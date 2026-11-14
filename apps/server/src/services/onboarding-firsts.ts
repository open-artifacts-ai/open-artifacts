// #2478: the first time each activation step of the instance owner happened,
// one settings row per owner and step, written once (the first time is kept).
// Timestamps only: never a title, a name or any text.
//
// One function per first-time, called from exactly one place each. They are
// the seam where a PostHog event goes next (#2479): each returns true only
// for the call that wrote the row, so an event fires once.

import { isInstanceOwner } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import { getUser } from "./users.js";

export const namedKey = (userId: string) => `onboarding:named:${userId}`;
/** The owner's first @-mention of one of their own agents: what "no reply in 2 minutes" counts from. */
export const mentionedKey = (userId: string) =>
  `onboarding:mentioned:${userId}`;
export const mentionRepliedKey = (userId: string) =>
  `onboarding:mention-replied:${userId}`;
export const askAnsweredKey = (userId: string) =>
  `onboarding:ask-answered:${userId}`;

/** How long a mention may go unanswered before the checklist says so. */
export const MENTION_STALLED_MS = 2 * 60 * 1000;

const SET_FIRST = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/** Writes `key` once, for the instance owner only; true when this call wrote it. Never throws. */
async function first(
  env: Env,
  userId: string,
  key: string,
  event: string,
): Promise<boolean> {
  try {
    const user = await getUser(env, userId);
    if (!user || !isInstanceOwner(user)) return false;
    const r = await stmt(env.DB, SET_FIRST).bind(key, String(Date.now())).run();
    return r.meta.changes > 0;
  } catch (e) {
    logWarn(event, { code: e instanceof Error ? e.name : "error" });
    return false;
  }
}

/**
 * The cheap gate before any thread read: `key` is still unset and `userId` is
 * the instance owner. One settings read, then one user read, only while unset.
 */
export async function pendingFirst(
  env: Env,
  userId: string,
  key: string,
): Promise<boolean> {
  const row = await stmt(env.DB, "select 1 as x from settings where key = ?1")
    .bind(key)
    .first();
  if (row) return false;
  const user = await getUser(env, userId);
  return !!user && isInstanceOwner(user);
}

/** Step 2: the owner has a bus agent with a chosen name or a role. */
export const noteAgentNamed = (env: Env, userId: string) =>
  first(env, userId, namedKey(userId), "onboarding_named_failed");

/** The owner mentioned one of their own agents (not a step: it starts the stalled clock). */
export const noteMentioned = (env: Env, userId: string) =>
  first(env, userId, mentionedKey(userId), "onboarding_mentioned_failed");

/** Step 4: one of the owner's own agents replied after the owner's comment that mentioned it. */
export const noteMentionReplied = (env: Env, userId: string) =>
  first(env, userId, mentionRepliedKey(userId), "onboarding_replied_failed");

/** Step 5: the owner's typed answer on an ask one of their own agents posted. */
export const noteAskAnswered = (env: Env, userId: string) =>
  first(env, userId, askAnsweredKey(userId), "onboarding_answered_failed");

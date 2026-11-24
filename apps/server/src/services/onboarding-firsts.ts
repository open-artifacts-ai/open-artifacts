// #2478: the first time each activation step of a member happened (#2632:
// any non-guest member, not only the owner), one settings row per person and step, written once (the first time is kept).
// Timestamps only: never a title, a name or any text.
//
// One function per first-time, called from exactly one place each. They are
// the seam where a PostHog event goes next (#2479): each returns true only
// for the call that wrote the row, so an event fires once.

import { isGuestRole } from "../auth/policy.js";
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

/**
 * One row per person who commented (#2287), the one key for both facts.
 * A legacy value is a timestamp (String(Date.now())): it proves only that the
 * person commented with no agent attached (legacy `commented`, and the team
 * step beside it), which a comment from before the typed flag (#1797) or a
 * bare token path can also pass. #2953: a typed comment in the web app upgrades
 * it to JSON { artifactId, at } (ms), the earliest known; never a title or text.
 * An older server only tests that the row exists, so both shapes read as
 * commented across a rolling update.
 */
export const commentedKey = (userId: string) =>
  `onboarding:commented:${userId}`;
/** The historical scan (first-comment-scan.ts): the last artifact id read, the marker that every artifact was, and when it began. Not `onboarding:` rows. */
export const FIRST_COMMENT_SCAN_CURSOR_KEY = "onboarding-scan:first-comment";
export const FIRST_COMMENT_SCAN_DONE_KEY = "onboarding-scan:first-comment:done";
export const FIRST_COMMENT_SCAN_STARTED_KEY =
  "onboarding-scan:first-comment:started";

/** How long a mention may go unanswered before the checklist says so. */
export const MENTION_STALLED_MS = 2 * 60 * 1000;

const SET_FIRST = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/** Writes `key` once, for a non-guest member; true when this call wrote it. Never throws. */
async function first(
  env: Env,
  userId: string,
  key: string,
  event: string,
): Promise<boolean> {
  try {
    const user = await getUser(env, userId);
    if (!user || isGuestRole(user.role)) return false;
    const r = await stmt(env.DB, SET_FIRST).bind(key, String(Date.now())).run();
    return r.meta.changes > 0;
  } catch (e) {
    logWarn(event, { code: e instanceof Error ? e.name : "error" });
    return false;
  }
}

/**
 * The cheap gate before any thread read: `key` is still unset and `userId` is
 * a non-guest member. One settings read, then one user read, only while unset.
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
  return !!user && !isGuestRole(user.role);
}

/** True when the owner's named time is already recorded (one settings read). */
export async function namedRecorded(
  env: Env,
  userId: string,
): Promise<boolean> {
  const row = await stmt(env.DB, "select 1 as x from settings where key = ?1")
    .bind(namedKey(userId))
    .first();
  return !!row;
}

/**
 * SQL: the typed time (ms) of a commented value, NULL for a legacy timestamp or
 * anything unreadable (valid JSON with a text artifactId and a numeric `at`).
 * CASE, so a malformed value never reaches json_type.
 */
export const typedAtSql = (col: string) =>
  `(case when json_valid(${col}) and json_type(${col}, '$.artifactId') = 'text'
         and json_type(${col}, '$.at') in ('integer', 'real')
    then json_extract(${col}, '$.at') end)`;

/**
 * SQL for one typed first comment (?1 key, ?2 value, ?3 user id): only for an
 * active non-guest member (the checklist's people). Inserts, upgrades a legacy
 * timestamp, or replaces only a later typed time: the earliest comment is kept,
 * a repeat changes nothing, and it is one atomic statement.
 */
export const KEEP_EARLIEST_TYPED_COMMENT = `on conflict (key) do update set value = excluded.value
  where ${typedAtSql("settings.value")} is null
     or ${typedAtSql("settings.value")} > json_extract(excluded.value, '$.at')`;

const UPSERT_TYPED_COMMENT = `insert into settings (key, value)
  select ?1, ?2 where exists (select 1 from users where id = ?3 and role <> 'guest' and status = 'active')
  ${KEEP_EARLIEST_TYPED_COMMENT}`;

export const commentedValue = (artifactId: string, at: number) =>
  JSON.stringify({ artifactId, at });

/** The upsert for one person's typed first comment on `artifactId` at `at` (ms). */
const typedCommentStmt = (
  env: Env,
  userId: string,
  artifactId: string,
  at: number,
) =>
  stmt(env.DB, UPSERT_TYPED_COMMENT).bind(
    commentedKey(userId),
    commentedValue(artifactId, at),
    userId,
  );

/** A stored commented value as typed metadata, or null: absent, a legacy timestamp or unreadable. */
export function parseFirstComment(
  v: string | undefined | null,
): { artifactId: string; at: number } | null {
  if (!v) return null;
  try {
    const j = JSON.parse(v) as { artifactId?: unknown; at?: unknown } | null;
    if (!j || typeof j !== "object") return null;
    return typeof j.artifactId === "string" &&
      typeof j.at === "number" &&
      Number.isFinite(j.at)
      ? { artifactId: j.artifactId, at: j.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * #2953: records the person's typed comment on `artifactId` at `at` (ms) as
 * their first if it is the earliest known. The caller has checked it was typed
 * by the person in the web app (no token, no agent); a guest or inactive
 * account earns nothing (the SQL checks the user). Idempotent and race-safe
 * (one upsert). Never throws: a comment must not fail on it.
 */
export async function noteFirstComment(
  env: Env,
  userId: string,
  artifactId: string,
  at: number = Date.now(),
): Promise<void> {
  try {
    await typedCommentStmt(
      env,
      userId,
      artifactId,
      Number.isFinite(at) ? at : Date.now(),
    ).run();
  } catch (e) {
    logWarn("onboarding_first_comment_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
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

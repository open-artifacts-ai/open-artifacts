// The first-run "Get started" checklist's state, install-wide, in the
// settings table: one row per flag, written once (the first time is kept).
// The dashboard derives each step from real data (a connection, an artifact,
// an invited member); the server keeps only what data cannot say: that the
// owner hid the list, and that every step was once done (so removing a
// member later never brings it back).

import type { Member, Onboarding, OnboardingPatch } from "@oa/shared";
import { isInstanceOwner } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logWarn } from "../log.js";
import { WELCOME_TITLE, welcomeHtml } from "../onboarding/welcome.js";
import { publish } from "./artifacts.js";
import { busView } from "./bus.js";
import {
  askAnsweredKey,
  MENTION_STALLED_MS,
  mentionedKey,
  mentionRepliedKey,
  namedKey,
} from "./onboarding-firsts.js";

export const DISMISSED_KEY = "onboarding:dismissed";
export const COMPLETED_KEY = "onboarding:completed";

/** #2287: {userId, artifactId} of the seeded Welcome; written once, kept after a delete. */
export const WELCOME_KEY = "onboarding:welcome";
export const WELCOME_OPENED_KEY = "onboarding:welcome-opened";
/**
 * The hosted provisioner's create self-test page (a private markdown artifact
 * the owner holds, #2422). It is not the user's work: it never makes an
 * instance "not fresh" and never counts as their first artifact.
 */
export const SELF_TEST = `(title = 'Welcome to Open Artifacts' and format = 'markdown')`;

/** One row per user who has posted a comment (any thread or reply). */
export const commentedKey = (userId: string) =>
  `onboarding:commented:${userId}`;

const SET = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/**
 * The flags, plus facts about `userId`: owns a live artifact (#1832), and for
 * #2287 the Welcome, the first agent connection, the first other artifact and
 * the first comment. welcomeId and welcomeOpened are for the user Welcome was
 * seeded for only.
 */
export async function getOnboarding(
  env: Env,
  userId: string,
): Promise<Onboarding> {
  const [flags, own, agent, first, commented, firsts] = await env.DB.batch([
    stmt(
      env.DB,
      "select key, value from settings where key in (?1, ?2, ?3, ?4)",
    ).bind(DISMISSED_KEY, COMPLETED_KEY, WELCOME_KEY, WELCOME_OPENED_KEY),
    stmt(
      env.DB,
      `select 1 as x from artifacts where owner_id = ?1 and deleted_at is null and not ${SELF_TEST}
       and id <> coalesce((select json_extract(value, '$.artifactId') from settings where key = ?2), '')
       limit 1`,
    ).bind(userId, WELCOME_KEY),
    // An agent is connected: an OAuth grant it used, or a token that was used.
    stmt(
      env.DB,
      `select 1 as x from agent_grants where user_id = ?1
       union all select 1 from tokens where user_id = ?1 and revoked_at is null and last_used_at is not null
       limit 1`,
    ).bind(userId),
    stmt(
      env.DB,
      `select id, title from artifacts where owner_id = ?1 and deleted_at is null
       and not ${SELF_TEST}
       and id <> coalesce((select json_extract(value, '$.artifactId') from settings where key = ?2), '')
       order by created_at, id limit 1`,
    ).bind(userId, WELCOME_KEY),
    stmt(env.DB, "select 1 as x from settings where key = ?1").bind(
      commentedKey(userId),
    ),
    // #2478: the first times of the three new steps, and of the first mention.
    stmt(
      env.DB,
      "select key, value from settings where key in (?1, ?2, ?3, ?4)",
    ).bind(
      namedKey(userId),
      mentionedKey(userId),
      mentionRepliedKey(userId),
      askAnsweredKey(userId),
    ),
  ]);
  const rows = flags.results as { key: string; value: string }[];
  const keys = new Set(rows.map((r) => r.key));
  const w = parseWelcome(rows.find((r) => r.key === WELCOME_KEY)?.value);
  const mine = w !== null && w.userId === userId;
  let welcomeId: string | null = null;
  if (mine) {
    const live = await stmt(
      env.DB,
      "select 1 as x from artifacts where id = ?1 and deleted_at is null",
    )
      .bind(w.artifactId)
      .first();
    welcomeId = live ? w.artifactId : null;
  }
  const f = first.results[0] as { id: string; title: string } | undefined;
  const at = new Map(
    (firsts.results as { key: string; value: string }[]).map((r) => [
      r.key,
      Number(r.value),
    ]),
  );
  const agentNamed = at.has(namedKey(userId));
  const mentionReplied = at.has(mentionRepliedKey(userId));
  const mentionedAt = at.get(mentionedKey(userId));
  return {
    dismissed: keys.has(DISMISSED_KEY),
    completed: keys.has(COMPLETED_KEY),
    hasArtifacts: own.results.length > 0,
    welcomeId,
    welcomeOpened: mine && keys.has(WELCOME_OPENED_KEY),
    agentConnected: agent.results.length > 0,
    firstArtifact: f ? { id: f.id, title: f.title } : null,
    commented: commented.results.length > 0,
    agentNamed,
    agentName:
      agentNamed && !keys.has(COMPLETED_KEY)
        ? await agentName(env, userId)
        : null,
    mentionReplied,
    mentionStalled:
      !mentionReplied &&
      mentionedAt !== undefined &&
      Date.now() - mentionedAt >= MENTION_STALLED_MS,
    askAnswered: at.has(askAnsweredKey(userId)),
  };
}

/**
 * The name the checklist calls the owner's agent: the most recently active
 * agent that is not on a harness default name. Read live, never stored; null
 * when none or the hub can't be read (the page then says "your agent").
 */
async function agentName(env: Env, userId: string): Promise<string | null> {
  try {
    const { agents } = await busView(env, userId);
    const named = agents
      .filter((a) => a.unnamed !== true)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return named?.name ?? null;
  } catch {
    return null;
  }
}

function parseWelcome(
  v: string | undefined,
): { userId: string; artifactId: string } | null {
  if (!v) return null;
  try {
    const j = JSON.parse(v) as { userId?: unknown; artifactId?: unknown };
    return typeof j.userId === "string" && typeof j.artifactId === "string"
      ? { userId: j.userId, artifactId: j.artifactId }
      : null;
  } catch {
    return null;
  }
}

/** Records that `userId` commented; never throws (a comment must not fail on it). */
export async function noteCommented(env: Env, userId: string): Promise<void> {
  try {
    await stmt(env.DB, SET)
      .bind(commentedKey(userId), String(Date.now()))
      .run();
  } catch (e) {
    logWarn("onboarding_commented_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/**
 * #2287: seeds the Welcome for a hosted instance's first owner, once ever.
 * The settings row is claimed first (insert-or-nothing), so a second sign-in,
 * a race, or a delete of Welcome never seeds again. A failed publish releases
 * the claim so the next sign-in retries. Never throws: sign-in must not block.
 */
export async function seedWelcome(env: Env, user: Member): Promise<void> {
  if (env.HOSTED !== "1" || !isInstanceOwner(user)) return;
  try {
    // One atomic claim. An instance that already has any artifact row (deleted
    // ones too) is not fresh: a "skipped" claim (no user, no artifact) is kept
    // so Welcome never appears later, after its artifacts are deleted.
    const claim = await stmt(
      env.DB,
      `insert into settings (key, value)
       select ?1, case when exists (select 1 from artifacts where not ${SELF_TEST}) then ?2 else ?3 end
       on conflict (key) do nothing`,
    )
      .bind(
        WELCOME_KEY,
        JSON.stringify({ userId: "", artifactId: "" }),
        JSON.stringify({ userId: user.id, artifactId: "" }),
      )
      .run();
    if (!claim.meta.changes) return;
    const held = await stmt(env.DB, "select value from settings where key = ?1")
      .bind(WELCOME_KEY)
      .first<{ value: string }>();
    if (parseWelcome(held?.value)?.userId !== user.id) return;
    let id: string;
    try {
      id = (
        await publish(
          env,
          user,
          {
            title: WELCOME_TITLE,
            format: "html",
            content: welcomeHtml(appOrigin(env)),
            visibility: "private",
          },
          null,
          undefined,
          "create",
        )
      ).id;
    } catch (e) {
      // Nothing was published: release the claim so the next sign-in retries.
      await stmt(env.DB, "delete from settings where key = ?1")
        .bind(WELCOME_KEY)
        .run();
      throw e;
    }
    // Published: keep the claim whatever happens (a retry would seed twice).
    await stmt(env.DB, "update settings set value = ?2 where key = ?1")
      .bind(WELCOME_KEY, JSON.stringify({ userId: user.id, artifactId: id }))
      .run();
  } catch (e) {
    logWarn("welcome_seed_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/** Turns on the flags in `patch`; the route checks who may. */
export async function setOnboarding(
  env: Env,
  userId: string,
  patch: OnboardingPatch,
): Promise<Onboarding> {
  const now = String(Date.now());
  const writes = [
    patch.dismissed ? stmt(env.DB, SET).bind(DISMISSED_KEY, now) : null,
    patch.completed ? stmt(env.DB, SET).bind(COMPLETED_KEY, now) : null,
    // Only for the user Welcome was seeded for; anyone else's is a no-op.
    patch.welcomeOpened
      ? stmt(
          env.DB,
          `insert into settings (key, value) select ?1, ?2
           where json_extract((select value from settings where key = ?3), '$.userId') = ?4
           on conflict (key) do nothing`,
        ).bind(WELCOME_OPENED_KEY, now, WELCOME_KEY, userId)
      : null,
  ].filter((s) => s !== null);
  if (writes.length) await env.DB.batch(writes);
  return getOnboarding(env, userId);
}

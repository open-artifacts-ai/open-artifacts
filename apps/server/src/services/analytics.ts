// #2479, #2879: activation events to PostHog, server-side, hosted only.
//
// One event the first time EACH member reaches each activation step. Sent only
// when the instance is hosted AND a POSTHOG_KEY secret is bound: a self-hosted
// instance has no key and makes no call. No browser script anywhere.
//
// The payload is fixed: distinct_id is an anonymous per-member id (below), and
// the properties are { instance_id, plan, time, $groups: { instance },
// $geoip_disable }. No $set or $set_once, no person properties, never a title,
// comment text, email, name, user id, IP or user agent. An agent acting for a
// person is that person's event; an anonymous guest has none.
// Best effort: a failed or slow send never fails or delays the user's action,
// and only a warning code is logged (never the payload or the error text).
//
// The anonymous id is the first 16 bytes (hex) of
// HMAC-SHA256(deriveKey(env, "oa:analytics-member"), userId), computed on send
// and stored nowhere. Only this instance can link it to an account. If
// SESSION_SECRET is ever rotated every member gets a new id and the funnel
// restarts: that is accepted. Never "fix" it by storing the ids.

import { WELCOME_TITLE } from "@oa/shared";
import { deriveKey } from "../auth/keys.js";
import { isGuestRole } from "../auth/policy.js";
import { billingOn, readPlan } from "../billing/plan.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import {
  NOT_A_WELCOME,
  SELF_TEST,
  WELCOME_KEY,
  welcomeKey,
} from "./onboarding.js";
import {
  commentedKey,
  FIRST_COMMENT_SCAN_DONE_KEY,
  FIRST_COMMENT_SCAN_STARTED_KEY,
  parseFirstComment,
  typedAtSql,
} from "./onboarding-firsts.js";
import { getUser } from "./users.js";

export type ActivationEvent =
  | "signed_up"
  | "agent_connected"
  | "agent_named"
  | "first_page_published"
  | "agent_replied_to_mention"
  | "first_ask_answered"
  | "first_comment";

/** Default PostHog capture host; POSTHOG_HOST overrides it (EU cloud, a proxy). */
export const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const SEND_TIMEOUT_MS = 3000;

type Ctx = Pick<ExecutionContext, "waitUntil">;

/** The install id, or null; trimmed like /healthz. */
const installId = (env: Env): string | null => env.INSTALL_ID?.trim() || null;

/**
 * Whether events would be sent: hosted, a key, and an install id. Cheap and
 * synchronous: callers gate their own D1 work on it so a self-hosted instance
 * (or a hosted one before the key exists) pays nothing.
 */
export const analyticsOn = (env: Env): boolean =>
  billingOn(env) && !!env.POSTHOG_KEY?.trim() && installId(env) !== null;

/** The capture URL for the configured host. */
function captureUrl(env: Env): string {
  const host = env.POSTHOG_HOST?.trim() || POSTHOG_DEFAULT_HOST;
  return `${host.replace(/\/+$/, "")}/capture/`;
}

const enc = new TextEncoder();

/** The anonymous id of a member (see the header): computed, never stored. */
export async function memberDistinctId(
  env: Env,
  userId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(await deriveKey(env, "oa:analytics-member")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(userId)),
  );
  return [...sig.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sends one event for one member now; never throws. `at` is the original time
 * of a backfilled first (PostHog's `timestamp` and our `time` both use it).
 * Exported for the unit tests.
 */
export async function sendActivation(
  env: Env,
  event: ActivationEvent,
  userId: string,
  now = Date.now(),
  at?: number,
): Promise<void> {
  if (!analyticsOn(env)) return;
  try {
    const id = installId(env) as string;
    const distinctId = await memberDistinctId(env, userId);
    const plan = (await readPlan(env, now).catch(() => null))?.tier ?? null;
    const when = new Date(at ?? now).toISOString();
    const res = await fetch(captureUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: env.POSTHOG_KEY?.trim(),
        event,
        distinct_id: distinctId,
        ...(at === undefined ? {} : { timestamp: when }),
        properties: {
          instance_id: id,
          plan,
          time: when,
          $groups: { instance: id },
          // No location is derived from this server's IP.
          $geoip_disable: true,
        },
      }),
    });
    if (!res.ok)
      logWarn("analytics_send_failed", { code: `http_${res.status}` });
  } catch (e) {
    logWarn("analytics_send_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/** Sends the event after the response when there is a ctx, else awaits it; never throws. */
export async function activation(
  env: Env,
  event: ActivationEvent,
  userId: string,
  ctx?: Ctx,
): Promise<void> {
  if (!analyticsOn(env)) return;
  const p = sendActivation(env, event, userId);
  // Never awaited: a slow PostHog must not delay the caller (sendActivation never rejects).
  if (ctx) ctx.waitUntil(p);
  else void p;
}

/** One settings row per member and step: written once, its value is the first time (ms). */
export const memberFirstKey = (event: ActivationEvent, userId: string) =>
  `analytics:first:${event}:${userId}`;

const SET_FIRST = `insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing`;

/** A per-isolate memo of claimed (step, member) pairs: skips D1 once known recorded. */
const recorded = new Set<string>();
export const resetAnalyticsMemo = () => recorded.clear();

/**
 * Records a member's first time of a step and sends its event, once per member.
 * Touches nothing (no D1, no call) unless analytics is on. A guest or an
 * unknown user has no per-person event. Never throws.
 */
export async function noteMemberFirst(
  env: Env,
  userId: string,
  event: ActivationEvent,
  ctx?: Ctx,
): Promise<void> {
  if (!analyticsOn(env) || recorded.has(`${event}:${userId}`)) return;
  // The D1 claim and the send run after the response, never inline.
  const p = claimMemberFirst(env, userId, event);
  if (ctx) ctx.waitUntil(p);
  else void p;
}

async function claimMemberFirst(
  env: Env,
  userId: string,
  event: ActivationEvent,
): Promise<void> {
  try {
    const user = await getUser(env, userId);
    if (!user || isGuestRole(user.role)) return;
    // first_page_published counts the checklist's firstArtifact: not the
    // provisioner's self-test, not the seeded Welcome (by id once recorded; by
    // its title while the seed is still being written).
    if (event === "first_page_published") {
      const mine = await stmt(
        env.DB,
        `select 1 as x from artifacts where owner_id = ?1 and deleted_at is null
           and not ${SELF_TEST} and ${NOT_A_WELCOME}
           and not (title = ?2 and exists (select 1 from settings where key in (?3, ?4) and coalesce(json_extract(value, '$.artifactId'), '') = ''))
         limit 1`,
      )
        .bind(userId, WELCOME_TITLE, welcomeKey(userId), WELCOME_KEY)
        .first();
      if (!mine) return;
    }
    // #2953: until every older page was read for typed comments, a person's
    // true first may be months old: the backfill sends it with its original
    // time (it reads the same stored first), so a live one waits. A person
    // created after the scan began has no older comment to find: theirs is
    // sent at once.
    let at: number | undefined;
    if (event === "first_comment") {
      const row = await stmt(
        env.DB,
        `select s.value from settings s join users u on u.id = ?1
         where s.key = ?2 and (
           exists (select 1 from settings where key = ?3)
           or u.created_at >= cast((select value from settings where key = ?4) as integer)
         )`,
      )
        .bind(
          userId,
          commentedKey(userId),
          FIRST_COMMENT_SCAN_DONE_KEY,
          FIRST_COMMENT_SCAN_STARTED_KEY,
        )
        .first<{ value: string }>();
      // The stored typed first (never a page id): none on record, no event.
      const fc = parseFirstComment(row?.value);
      if (!fc) return;
      at = fc.at;
    }
    const r = await stmt(env.DB, SET_FIRST)
      .bind(memberFirstKey(event, userId), String(at ?? Date.now()))
      .run();
    recorded.add(`${event}:${userId}`);
    if (r.meta.changes > 0)
      await sendActivation(env, event, userId, Date.now(), at);
  } catch (e) {
    logWarn("analytics_first_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

// ------------------------------------------------------------------ backfill

/** Written once the stored firsts have all been sent: the backfill never repeats. */
export const BACKFILL_KEY = "analytics:backfill:done";
/** At most this many events per run; the daily cron continues next day. */
export const BACKFILL_BATCH = 50;

type Candidate = { userId: string; event: ActivationEvent; at: number };

/** Each member's first times already stored, with their original times (ms). */
async function backfillCandidates(env: Env): Promise<Candidate[]> {
  const [people, signed, connected, published, firsts] = await env.DB.batch([
    stmt(
      env.DB,
      "select id from users where role <> 'guest' and status = 'active'",
    ),
    stmt(
      env.DB,
      "select id, created_at as at from users where role <> 'guest' and status = 'active' and last_seen_at is not null",
    ),
    stmt(
      env.DB,
      `select user_id as id, min(t) as at from (
         select user_id, last_used_at as t from agent_grants where last_used_at is not null
         union all select user_id, last_used_at from tokens where revoked_at is null and last_used_at is not null
       ) group by user_id`,
    ),
    stmt(
      env.DB,
      `select owner_id as id, min(created_at) as at from artifacts
        where deleted_at is null and not ${SELF_TEST} and ${NOT_A_WELCOME} group by owner_id`,
    ),
    stmt(
      env.DB,
      `select key, value from settings
        where key like 'onboarding:named:%' or key like 'onboarding:mention-replied:%'
           or key like 'onboarding:ask-answered:%'`,
    ),
  ]);
  const ok = new Set(
    ((people?.results ?? []) as { id: string }[]).map((r) => r.id),
  );
  const out: Candidate[] = [];
  const rows = (r: typeof signed, event: ActivationEvent): void => {
    for (const x of (r?.results ?? []) as { id: string; at: number }[])
      if (ok.has(x.id) && Number.isFinite(x.at))
        out.push({ userId: x.id, event, at: x.at });
  };
  rows(signed, "signed_up");
  rows(connected, "agent_connected");
  rows(published, "first_page_published");
  const byPrefix: [string, ActivationEvent][] = [
    ["onboarding:named:", "agent_named"],
    ["onboarding:mention-replied:", "agent_replied_to_mention"],
    ["onboarding:ask-answered:", "first_ask_answered"],
  ];
  for (const r of (firsts?.results ?? []) as { key: string; value: string }[])
    for (const [prefix, event] of byPrefix)
      if (r.key.startsWith(prefix)) {
        const userId = r.key.slice(prefix.length);
        const at = Number(r.value);
        if (ok.has(userId) && Number.isFinite(at) && at > 0)
          out.push({ userId, event, at });
      }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * One-time backfill: once the PostHog key is present, sends each member's
 * stored first times with their ORIGINAL times, once per install. Each
 * (member, step) is claimed first (the same row a live first writes), so a
 * step is never sent twice, live or backfilled. At most BACKFILL_BATCH events
 * per run; when all are done the marker is written and it never runs again.
 * Best effort: never throws.
 */
export async function backfillActivation(env: Env): Promise<void> {
  if (!analyticsOn(env)) return;
  try {
    const done = await stmt(
      env.DB,
      "select 1 as x from settings where key = ?1",
    )
      .bind(BACKFILL_KEY)
      .first();
    if (done) return;
    let sent = 0;
    for (const c of await backfillCandidates(env)) {
      if (sent >= BACKFILL_BATCH) return;
      const r = await stmt(env.DB, SET_FIRST)
        .bind(memberFirstKey(c.event, c.userId), String(c.at))
        .run();
      recorded.add(`${c.event}:${c.userId}`);
      if (r.meta.changes === 0) continue;
      await sendActivation(env, c.event, c.userId, Date.now(), c.at);
      sent++;
    }
    await stmt(env.DB, SET_FIRST).bind(BACKFILL_KEY, String(Date.now())).run();
  } catch (e) {
    logWarn("analytics_backfill_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/**
 * Its own marker, so an install whose BACKFILL_KEY is already written (the
 * stored firsts of #2879 were all sent) still gets first_comment (#2953).
 */
export const BACKFILL_FIRST_COMMENT_KEY = "analytics:backfill:first_comment";
/** Events per run of the every-2-minute tick: each is a claim and a send, so it stays inside a small subrequest budget. */
export const FIRST_COMMENT_BACKFILL_BATCH = 10;

/**
 * #2953: sends first_comment for every active, non-guest member with a stored
 * first typed comment, with its ORIGINAL time, once per install. Waits until
 * the historical scan has read every page (scanFirstComments), so a person's
 * earliest comment is the one sent. Each (member, step) is claimed first with
 * the row a live first writes, so it is never sent twice. The SQL skips legacy
 * timestamps before its LIMIT (only typed metadata is a candidate), so they
 * never fill a batch. At most `batch` per run; the marker is written when none
 * is left. Only the time goes out: no page id, title or text. Never throws.
 */
export async function backfillFirstComment(
  env: Env,
  /** Events per run; injectable for tests. */
  batch: number = FIRST_COMMENT_BACKFILL_BATCH,
): Promise<void> {
  if (!analyticsOn(env)) return;
  try {
    const has = (key: string) =>
      stmt(env.DB, "select 1 as x from settings where key = ?1")
        .bind(key)
        .first();
    if (await has(BACKFILL_FIRST_COMMENT_KEY)) return;
    if (!(await has(FIRST_COMMENT_SCAN_DONE_KEY))) return;
    const { results } = await stmt(
      env.DB,
      `select substr(s.key, length(?1) + 1) as id, s.value as value from settings s
        join users u on u.id = substr(s.key, length(?1) + 1)
       where substr(s.key, 1, length(?1)) = ?1
         and ${typedAtSql("s.value")} is not null
         and u.role <> 'guest' and u.status = 'active'
         and not exists (select 1 from settings d
                          where d.key = 'analytics:first:first_comment:' || u.id)
       order by s.key limit ${batch + 1}`,
    )
      .bind(commentedKey(""))
      .all<{ id: string; value: string }>();
    let sent = 0;
    for (const r of results) {
      if (sent >= batch) return;
      const fc = parseFirstComment(r.value);
      if (!fc) continue;
      const claim = await stmt(env.DB, SET_FIRST)
        .bind(memberFirstKey("first_comment", r.id), String(fc.at))
        .run();
      recorded.add(`first_comment:${r.id}`);
      if (claim.meta.changes === 0) continue;
      await sendActivation(env, "first_comment", r.id, Date.now(), fc.at);
      sent++;
    }
    await stmt(env.DB, SET_FIRST)
      .bind(BACKFILL_FIRST_COMMENT_KEY, String(Date.now()))
      .run();
  } catch (e) {
    logWarn("analytics_backfill_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

import type { Env } from "../env.js";
import { oauthApi } from "./oauth-api.js";

// Dynamic client registration is unauthenticated and costs KV writes (Free plan:
// 1000/day). Besides the per-IP RL_ANON limit, registrations are capped per UTC
// day in D1, and clients that never complete a grant are deleted after a day.

/** OAuth client registrations allowed per UTC day, instance-wide. */
export const MAX_REGISTRATIONS_PER_DAY = 200;
const DAY_KEY = "oauth_register";
/** counters rows `client:<clientId>`: n 0 = registered, 1 = granted; day = registration day. */
const CLIENT_KEY = "client:";
const SWEEP_BATCH = 50;
const DAY_MS = 86_400_000;
const GRANTED_MARKER_DAYS = 90;

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Read-only check of today's registration count (rejected attempts write
 * nothing to D1). False once today's successful registrations reach the cap.
 */
export async function registrationAllowed(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  const row = await env.DB.prepare("select n, day from counters where key = ?")
    .bind(DAY_KEY)
    .first<{ n: number; day: string }>();
  return !row || row.day !== utcDay(now) || row.n < MAX_REGISTRATIONS_PER_DAY;
}

/**
 * After a 201 registration: counts it toward today's cap (UPSERT; the row
 * resets on a new day) and remembers the client as not yet granted.
 */
export async function trackRegisteredClient(
  env: Env,
  res: Response,
  now = Date.now(),
): Promise<void> {
  if (res.status !== 201) return;
  const day = utcDay(now);
  const count = env.DB.prepare(
    `insert into counters (key, n, day) values (?1, 1, ?2)
     on conflict (key) do update set
       n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
       day = excluded.day`,
  ).bind(DAY_KEY, day);
  let id: unknown;
  try {
    id = ((await res.clone().json()) as { client_id?: unknown }).client_id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string" || !id || id.length > 256) {
    await count.run();
    return;
  }
  await env.DB.batch([
    count,
    env.DB.prepare(
      "insert into counters (key, n, day) values (?, 0, ?) on conflict (key) do nothing",
    ).bind(CLIENT_KEY + id, day),
  ]);
}

/** Marks a client as having completed a grant, so the sweep keeps it. */
export async function markClientGranted(
  env: Env,
  clientId: string,
  now = Date.now(),
  /** Statements to commit in the same batch (an audit row). */
  extra: D1PreparedStatement[] = [],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "insert into counters (key, n, day) values (?, 1, ?) on conflict (key) do update set n = 1",
    ).bind(CLIENT_KEY + clientId, utcDay(now)),
    ...extra,
  ]);
}

/**
 * Cron: deletes clients registered at least a full day ago (registration day
 * before yesterday, so ≥ 24 h) that never completed a grant, at most
 * SWEEP_BATCH per run. Returns how many were deleted.
 */
export async function sweepUngrantedClients(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const { results } = await env.DB.prepare(
    "select key from counters where key like 'client:%' and n = 0 and day < ? order by day limit ?",
  )
    .bind(utcDay(now - DAY_MS), SWEEP_BATCH)
    .all<{ key: string }>();
  // Granted markers only matter while a client registration can live (90 days).
  await env.DB.prepare(
    "delete from counters where key like 'client:%' and n = 1 and day < ?",
  )
    .bind(utcDay(now - GRANTED_MARKER_DAYS * DAY_MS))
    .run();
  if (results.length === 0) return 0;
  const oauth = oauthApi(env);
  let done = 0;
  for (const { key } of results) {
    await oauth.deleteClient(key.slice(CLIENT_KEY.length));
    await env.DB.prepare("delete from counters where key = ? and n = 0")
      .bind(key)
      .run();
    done++;
  }
  return done;
}

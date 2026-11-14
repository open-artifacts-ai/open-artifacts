import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

/**
 * The hosted suspend marker (cloud #228): a row in the install's own D1
 * `settings` (no migration), written by the platform's `oa:close-sockets`
 * job and cleared by `oa:resume`. The install refuses new bus connects from
 * this strongly consistent state instead of waiting for dispatch's cached,
 * eventually consistent HOSTS value to turn "paused".
 */
export const SUSPENDED_KEY = "suspended";

const SET = `insert into settings (key, value) values (?1, '1')
  on conflict(key) do update set value = '1'`;
const CLEAR = "delete from settings where key = ?1";
const READ = "select 1 as one from settings where key = ?1";

export async function markSuspended(env: Env): Promise<void> {
  await stmt(env.DB, SET).bind(SUSPENDED_KEY).run();
}

export async function clearSuspended(env: Env): Promise<void> {
  await stmt(env.DB, CLEAR).bind(SUSPENDED_KEY).run();
}

/** One primary-key read; hosted only (self-host never sets the marker). */
export async function isSuspended(env: Env): Promise<boolean> {
  if (env.HOSTED !== "1") return false;
  const r = await stmt(env.DB, READ)
    .bind(SUSPENDED_KEY)
    .first<{ one: number }>();
  return r !== null;
}

/**
 * Dispatch's paused answer (apps/dispatch unavailable(req, "paused")) for a
 * non-HTML client: 503, plain text, no-store, no Retry-After.
 */
export function pausedResponse(): Response {
  return new Response(
    "This workspace is paused. Nothing in it has been deleted. If you use this workspace, ask its admin when it will be back.\n",
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-robots-tag": "noindex",
        "content-type": "text/plain; charset=utf-8",
      },
    },
  );
}

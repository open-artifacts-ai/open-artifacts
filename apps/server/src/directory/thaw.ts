import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo } from "../log.js";
import { revokeUsersLive } from "../runtime/revoke.js";

// P3 T15: sync back on after a freeze (Team to Business). Each frozen edit
// (frozen_edits: a synced row an admin changed or removed by hand while
// frozen) is replaced by the synced role: the pair's manual row goes, and its
// space_members(source = 'sync') row is derived again from directory_members
// and the space's group_mappings (the max role; none: no row), as T14's
// applyGroupDiff derives it. The group walks that follow apply what changed
// in Google meanwhile. Users whose role in the space dropped have their
// sockets closed once the batch committed.

/** Frozen edits per batch. */
export const THAW_CHUNK = 100;

const rank = (c: string) =>
  `(case ${c} when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)`;
const roleOf = (r: string) =>
  `(case ${r} when 3 then 'manager' when 2 then 'editor' else 'viewer' end)`;

// ?1: the chunk, a JSON array of [space_id, user_id, at].
const P = `(select json_extract(value, '$[0]') as s, json_extract(value, '$[1]') as u,
  json_extract(value, '$[2]') as t from json_each(?1))`;
const IN_P = `(space_id, user_id) in (select s, u from ${P})`;
/** The synced role (space s, user u) should hold now; null: none. */
const want = (s: string, u: string) => `(select max(${rank("gm.role")})
  from group_mappings gm join directory_members dm on dm.group_id = gm.group_id
  where gm.space_id = ${s} and dm.user_id = ${u})`;
const WANT_ROW = want("space_members.space_id", "space_members.user_id");

const PAGE = `select space_id as s, user_id as u, at as t from frozen_edits
  order by at, space_id, user_id limit ?1`;
/** Each pair's effective rank (manual and sync rows). */
const RANKS = `select p.s, p.u, (select max(${rank("m.role")}) from space_members m
  where m.space_id = p.s and m.user_id = p.u) as r from ${P} p`;
const DROP_MANUAL = `delete from space_members where source = 'manual' and ${IN_P}`;
const DROP_SYNC = `delete from space_members where source = 'sync' and ${IN_P}
  and ${WANT_ROW} is null`;
const SET_SYNC = `update space_members set role = ${roleOf(WANT_ROW)}
  where source = 'sync' and ${IN_P} and ${WANT_ROW} <> ${rank("role")}`;
const ADD_SYNC = `insert into space_members (space_id, user_id, role, source, created_at)
  select p.s, p.u, ${roleOf(want("p.s", "p.u"))}, 'sync', ?2 from ${P} p
  join users x on x.id = p.u
  where x.status <> 'removed' and ${want("p.s", "p.u")} is not null
    and not exists (select 1 from space_members m where m.space_id = p.s
      and m.user_id = p.u and m.source = 'sync')`;
/** Only the rows read (an edit recorded meanwhile has another `at`). */
const DONE = `delete from frozen_edits
  where (space_id, user_id, at) in (select s, u, t from ${P})`;

type Pair = { s: string; u: string; t: number };
type Ranked = { s: string; u: string; r: number | null };

/**
 * Replaces up to THAW_CHUNK frozen edits (one D1 batch), then closes the
 * sockets of the users it narrowed. Resolves to whether edits remain.
 * `guard` is re-checked right before the batch (DirectorySync's epoch).
 */
export async function thawFrozenEdits(
  env: Env,
  o: {
    guard?: () => void;
    now?: number;
    ctx?: Pick<ExecutionContext, "waitUntil">;
  } = {},
): Promise<boolean> {
  const { results } = await stmt(env.DB, PAGE).bind(THAW_CHUNK).all<Pair>();
  if (!results.length) return false;
  const chunk = JSON.stringify(results.map((p) => [p.s, p.u, p.t]));
  o.guard?.();
  const out = await env.DB.batch([
    stmt(env.DB, RANKS).bind(chunk),
    stmt(env.DB, DROP_MANUAL).bind(chunk),
    stmt(env.DB, DROP_SYNC).bind(chunk),
    stmt(env.DB, SET_SYNC).bind(chunk),
    stmt(env.DB, ADD_SYNC).bind(chunk, o.now ?? Date.now()),
    stmt(env.DB, DONE).bind(chunk),
    stmt(env.DB, RANKS).bind(chunk),
  ]);
  const key = (x: Ranked) => `${x.s}\u0000${x.u}`;
  const before = new Map(
    ((out[0]?.results ?? []) as Ranked[]).map((x) => [key(x), x.r ?? 0]),
  );
  const narrowed = ((out.at(-1)?.results ?? []) as Ranked[])
    .filter((x) => (x.r ?? 0) < (before.get(key(x)) ?? 0))
    .map((x) => x.u);
  logInfo("directory_thaw", {
    edits: results.length,
    narrowed: narrowed.length,
  });
  // Never guarded: the batch committed, so its socket closes always follow.
  await revokeUsersLive(env, narrowed, "frozen edit replaced", o.ctx);
  return results.length === THAW_CHUNK;
}

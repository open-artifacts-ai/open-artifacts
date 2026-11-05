import { newId, SpaceRoleSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logError, logInfo, logWarn } from "../log.js";
import { revokeUsersLive } from "../runtime/revoke.js";

// P3 T15: sync back on after a freeze (Team to Business). It runs after the
// reconcile's group walks, so directory_members is fresh. Each frozen edit
// (frozen_edits, first edit wins) gets its outcome:
// - override (an admin changed a synced row): the pair's manual row is put
//   back exactly as it was before the first frozen edit (none: it goes),
//   never more, never for a removed user.
// - delete (an explicit removal): final; the manual row stays as it is.
// - manual (a manual row on a pair with no synced row): kept.
// Then every pair's space_members(source = 'sync') row is derived again
// from directory_members and the space's group_mappings (the max role;
// none: no row), as T14's applyGroupDiff derives it, never for a removed
// user. Every outcome and every synced-row change is audited (actor sync).
//
// Every write is gated on the record still being what the page read
// (frozen_edits joined on at, kind and manual_role): a live admin edit that
// lands between the read and the batch supersedes the record (spaces.ts
// SUPERSEDE_BY_*), so this batch writes nothing for it and the next thaw
// takes the record as it is then.
//
// The users whose role in the space dropped have their sockets closed. The
// close is durable: the chunk's users are held as pending (DirectorySync's
// kv) before the batch, narrowed to those that dropped after it, and
// released once revoked; a failure leaves them for the next alarm.

/** Frozen edits per batch (one batch per alarm). */
export const THAW_CHUNK = 50;

const KINDS = ["override", "delete", "manual"] as const;
type Kind = (typeof KINDS)[number];
/** Audit rows a pair can get: ids are minted per pair and slot. */
const SLOTS = 6;

const rank = (c: string) =>
  `(case ${c} when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)`;
const roleOf = (r: string) =>
  `(case ${r} when 3 then 'manager' when 2 then 'editor' else 'viewer' end)`;
const ROLES = "('viewer', 'editor', 'manager')";

// ?1: the chunk, a JSON array of [space_id, user_id, at, manual_role, kind,
// raw manual_role, raw kind, ...audit ids]; ?2: now.
const RAW = `(select json_extract(value, '$[0]') as s, json_extract(value, '$[1]') as u,
  json_extract(value, '$[2]') as t, json_extract(value, '$[3]') as m,
  json_extract(value, '$[4]') as k, json_extract(value, '$[5]') as rm,
  json_extract(value, '$[6]') as rk${Array.from(
    { length: SLOTS },
    (_, i) => `, json_extract(value, '$[${7 + i}]') as id${i}`,
  ).join("")} from json_each(?1))`;
/** The pairs whose record is still the one read. */
const P = `(select r.* from ${RAW} r join frozen_edits fe on fe.space_id = r.s
  and fe.user_id = r.u and fe.at = r.t and fe.kind is r.rk and fe.manual_role is r.rm)`;
const IN_P = `(space_id, user_id) in (select s, u from ${P})`;
const IN_OVERRIDE = `(space_id, user_id) in (select s, u from ${P} where k = 'override')`;
/** The synced role (space s, user u) should hold now; null: none. */
const want = (s: string, u: string) => `(select max(${rank("gm.role")})
  from group_mappings gm join directory_members dm on dm.group_id = gm.group_id
  where gm.space_id = ${s} and dm.user_id = ${u})`;
const WANT_ROW = want("space_members.space_id", "space_members.user_id");
/** The stored manual role of the override pair this space_members row is. */
const STORED = `(select p.m from ${P} p
  where p.s = space_members.space_id and p.u = space_members.user_id)`;
const LIVE_ROW = `exists (select 1 from users x where x.id = space_members.user_id
  and x.status <> 'removed')`;
const live = (u: string) =>
  `exists (select 1 from users x where x.id = ${u} and x.status <> 'removed')`;
const manualOf = (s: string, u: string) =>
  `(select m.role from space_members m where m.space_id = ${s} and m.user_id = ${u} and m.source = 'manual')`;
const syncOf = (s: string, u: string) =>
  `(select m.role from space_members m where m.space_id = ${s} and m.user_id = ${u} and m.source = 'sync')`;

const PAGE = `select space_id as s, user_id as u, at as t, manual_role as m, kind as k
  from frozen_edits order by at, space_id, user_id limit ?1`;
/** Each pair's effective rank (manual and sync rows), records or not. */
const RANKS = `select p.s, p.u, (select max(${rank("m.role")}) from space_members m
  where m.space_id = p.s and m.user_id = p.u) as r from ${RAW} p`;

/** One audit row per pair of `P p` where `cond` holds (the audit_events shape). */
const auditRows = (
  slot: number,
  action: string,
  detail: string,
  cond: string,
) =>
  `insert into audit_events
    (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail)
  select p.id${slot}, ?2, 'sync', null, '${action}', 'user', p.u, p.s, ${detail}
  from ${P} p where ${cond}`;
const T = "json('true')";
const AUDITS = [
  // override, no manual row before: the frozen one goes.
  auditRows(
    0,
    "space.member.remove",
    `json_object('thaw', ${T})`,
    `p.k = 'override' and p.m is null and ${manualOf("p.s", "p.u")} is not null`,
  ),
  // override: the pre-freeze role back on the manual row.
  auditRows(
    1,
    "space.member.role",
    `json_object('thaw', ${T}, 'role', p.m)`,
    `p.k = 'override' and p.m in ${ROLES} and ${manualOf("p.s", "p.u")} <> p.m
      and ${live("p.u")}`,
  ),
  // override: the pre-freeze manual row re-added.
  auditRows(
    2,
    "space.member.add",
    `json_object('thaw', ${T}, 'role', p.m)`,
    `p.k = 'override' and p.m in ${ROLES} and ${manualOf("p.s", "p.u")} is null
      and ${live("p.u")}`,
  ),
  auditRows(
    3,
    "directory.sync",
    "json_object('thaw', 'removal_kept')",
    "p.k = 'delete'",
  ),
  auditRows(
    4,
    "directory.sync",
    `json_patch(json_object('thaw', 'manual_kept'), json_object('role', ${manualOf("p.s", "p.u")}))`,
    "p.k = 'manual'",
  ),
];
/** The synced row the rebuild leaves (null: none), as DROP/SET/ADD_SYNC decide. */
const SYNC_TO = `(case when ${want("p.s", "p.u")} is null then null
  when not ${live("p.u")} and ${syncOf("p.s", "p.u")} is null then null
  else ${roleOf(want("p.s", "p.u"))} end)`;
const AUDIT_SYNC = auditRows(
  5,
  "directory.sync",
  `json_patch(json_object('thaw', 'sync'), json_object('from', ${syncOf("p.s", "p.u")}, 'to', ${SYNC_TO}))`,
  `${syncOf("p.s", "p.u")} is not ${SYNC_TO}`,
);

/** Override, no manual row before the freeze: the one it left goes. */
const DROP_MANUAL = `delete from space_members where source = 'manual' and ${IN_OVERRIDE}
  and ${STORED} is null`;
/** Override, a manual row before the freeze: its role back, exactly. */
const SET_MANUAL = `update space_members set role = ${STORED}
  where source = 'manual' and ${IN_OVERRIDE} and ${STORED} in ${ROLES}
  and role <> ${STORED} and ${LIVE_ROW}`;
/** Override whose manual row went since (never for a removed user): back. */
const ADD_MANUAL = `insert into space_members (space_id, user_id, role, source, created_at)
  select p.s, p.u, p.m, 'manual', ?2 from ${P} p
  where p.k = 'override' and p.m in ${ROLES} and ${live("p.u")}
    and ${manualOf("p.s", "p.u")} is null`;
const DROP_SYNC = `delete from space_members where source = 'sync' and ${IN_P}
  and ${WANT_ROW} is null`;
const SET_SYNC = `update space_members set role = ${roleOf(WANT_ROW)}
  where source = 'sync' and ${IN_P} and ${WANT_ROW} <> ${rank("role")}`;
const ADD_SYNC = `insert into space_members (space_id, user_id, role, source, created_at)
  select p.s, p.u, ${roleOf(want("p.s", "p.u"))}, 'sync', ?2 from ${P} p
  where ${live("p.u")} and ${want("p.s", "p.u")} is not null
    and ${syncOf("p.s", "p.u")} is null`;
/** The records applied (still the ones read; the first-wins insert never changes `at`). */
const DONE = `delete from frozen_edits
  where (space_id, user_id, at) in (select s, u, t from ${P})`;

export type Row = { s: string; u: string; t: number; m: unknown; k: unknown };
type Pair = { s: string; u: string; t: number; m: string | null; k: Kind };
type Ranked = { s: string; u: string; r: number | null };

/** A stored value outside the enums never grants: no role, no restore. */
export function validEdit(r: Row): Pair {
  const m = SpaceRoleSchema.safeParse(r.m).success ? (r.m as string) : null;
  const k = (KINDS as readonly unknown[]).includes(r.k) ? (r.k as Kind) : null;
  if ((r.m !== null && m === null) || k === null)
    logWarn("directory_thaw_invalid", new Error("frozen edit out of range"));
  return { s: r.s, u: r.u, t: r.t, m, k: k ?? "delete" };
}

/** Users whose socket close is owed (DirectorySync's kv). */
export type PendingRevokes = {
  /** Before the batch: the chunk's users. */
  hold(ids: string[]): void;
  /** After it: of `ids`, only `narrowed` stay owed. */
  keep(ids: string[], narrowed: string[]): void;
  /** Revoked. */
  release(ids: string[]): void;
};

/**
 * Applies up to THAW_CHUNK frozen edits (one D1 batch), then closes the
 * sockets of the users whose role it lowered (restored rows included).
 * Resolves to whether edits remain. `guard` is re-checked right before the
 * batch (DirectorySync's epoch). `revoke` replaces the socket close (tests).
 */
export async function thawFrozenEdits(
  env: Env,
  o: {
    guard?: () => void;
    now?: number;
    ctx?: Pick<ExecutionContext, "waitUntil">;
    pending?: PendingRevokes;
    revoke?: (ids: string[]) => Promise<void>;
  } = {},
): Promise<boolean> {
  const { results } = await stmt(env.DB, PAGE).bind(THAW_CHUNK).all<Row>();
  if (!results.length) return false;
  const pairs = results.map(validEdit);
  const chunk = JSON.stringify(
    pairs.map((p, i) => [
      p.s,
      p.u,
      p.t,
      p.m,
      p.k,
      results[i]?.m ?? null,
      results[i]?.k ?? null,
      ...Array.from({ length: SLOTS }, () => newId()),
    ]),
  );
  const now = o.now ?? Date.now();
  const users = [...new Set(pairs.map((p) => p.u))];
  o.guard?.();
  o.pending?.hold(users);
  const out = await env.DB.batch([
    stmt(env.DB, RANKS).bind(chunk),
    ...AUDITS.map((sql) => stmt(env.DB, sql).bind(chunk, now)),
    stmt(env.DB, DROP_MANUAL).bind(chunk),
    stmt(env.DB, SET_MANUAL).bind(chunk),
    stmt(env.DB, ADD_MANUAL).bind(chunk, now),
    stmt(env.DB, AUDIT_SYNC).bind(chunk, now),
    stmt(env.DB, DROP_SYNC).bind(chunk),
    stmt(env.DB, SET_SYNC).bind(chunk),
    stmt(env.DB, ADD_SYNC).bind(chunk, now),
    stmt(env.DB, DONE).bind(chunk),
    stmt(env.DB, RANKS).bind(chunk),
  ]);
  const key = (x: Ranked) => `${x.s}\u0000${x.u}`;
  const before = new Map(
    ((out[0]?.results ?? []) as Ranked[]).map((x) => [key(x), x.r ?? 0]),
  );
  const narrowed = [
    ...new Set(
      ((out.at(-1)?.results ?? []) as Ranked[])
        .filter((x) => (x.r ?? 0) < (before.get(key(x)) ?? 0))
        .map((x) => x.u),
    ),
  ];
  o.pending?.keep(users, narrowed);
  logInfo("directory_thaw", {
    edits: pairs.length,
    narrowed: narrowed.length,
  });
  // Never guarded: the batch committed, so its socket closes always follow.
  try {
    if (o.revoke) await o.revoke(narrowed);
    else await revokeUsersLive(env, narrowed, "frozen edit undone", o.ctx);
    o.pending?.release(narrowed);
  } catch (e) {
    // Left pending: the next alarm retries.
    logError("directory_thaw_revoke", e);
  }
  return results.length === THAW_CHUNK;
}

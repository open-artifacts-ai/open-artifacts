import { SpaceRoleSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { revokeUsersLive } from "../runtime/revoke.js";
import { type AuditActor, audit } from "../services/audit.js";

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
// user. Each outcome is audited (actor sync). Users whose role in the space
// dropped have their sockets closed once the batch committed.

/** Frozen edits per batch (one batch per alarm). */
export const THAW_CHUNK = 50;

const SYNC: AuditActor = { kind: "sync", id: null };
const KINDS = ["override", "delete", "manual"] as const;
type Kind = (typeof KINDS)[number];

const rank = (c: string) =>
  `(case ${c} when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)`;
const roleOf = (r: string) =>
  `(case ${r} when 3 then 'manager' when 2 then 'editor' else 'viewer' end)`;
const ROLES = "('viewer', 'editor', 'manager')";

// ?1: the chunk, a JSON array of [space_id, user_id, at, manual_role, kind].
const P = `(select json_extract(value, '$[0]') as s, json_extract(value, '$[1]') as u,
  json_extract(value, '$[2]') as t, json_extract(value, '$[3]') as m,
  json_extract(value, '$[4]') as k from json_each(?1))`;
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
const LIVE = `exists (select 1 from users x where x.id = space_members.user_id
  and x.status <> 'removed')`;

const PAGE = `select space_id as s, user_id as u, at as t, manual_role as m, kind as k
  from frozen_edits order by at, space_id, user_id limit ?1`;
/** Each pair's effective rank (manual and sync rows). */
const RANKS = `select p.s, p.u, (select max(${rank("m.role")}) from space_members m
  where m.space_id = p.s and m.user_id = p.u) as r from ${P} p`;
/** Override, no manual row before the freeze: the one it left goes. */
const DROP_MANUAL = `delete from space_members where source = 'manual' and ${IN_OVERRIDE}
  and ${STORED} is null`;
/** Override, a manual row before the freeze: its role back, exactly. */
const SET_MANUAL = `update space_members set role = ${STORED}
  where source = 'manual' and ${IN_OVERRIDE} and ${STORED} in ${ROLES}
  and role <> ${STORED} and ${LIVE}`;
/** Override whose manual row went since (never for a removed user): back. */
const ADD_MANUAL = `insert into space_members (space_id, user_id, role, source, created_at)
  select p.s, p.u, p.m, 'manual', ?2 from ${P} p join users x on x.id = p.u
  where p.k = 'override' and p.m in ${ROLES} and x.status <> 'removed'
    and not exists (select 1 from space_members m where m.space_id = p.s
      and m.user_id = p.u and m.source = 'manual')`;
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
/**
 * The rows read, by their `at` too: a record that a reset or disconnect
 * deleted and a new freeze recorded again meanwhile has another `at` and
 * waits for the next thaw (the first-wins insert never changes `at`).
 */
const DONE = `delete from frozen_edits
  where (space_id, user_id, at) in (select s, u, t from ${P})`;
const MANUAL_IS = `select 1 from space_members where space_id = ? and user_id = ? and source = 'manual'`;
const ACTIVE = `exists (select 1 from users where id = ? and status <> 'removed')`;
const MANUAL_ROLE = `(select role from space_members where space_id = ? and user_id = ? and source = 'manual')`;

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

/** Each pair's outcome audit, gated on the rows before the batch. */
function outcomeAudits(env: Env, p: Pair): D1PreparedStatement[] {
  const target = { type: "user", id: p.u } as const;
  const base = { spaceId: p.s };
  if (p.k === "delete")
    return [
      audit(env, "directory.sync", target, SYNC, {
        ...base,
        detail: { thaw: "removal_kept" },
      }),
    ];
  if (p.k === "manual")
    return [
      audit(env, "directory.sync", target, SYNC, {
        ...base,
        detail: { thaw: "manual_kept" },
        detailSql: {
          sql: `json_object('role', ${MANUAL_ROLE})`,
          args: [p.s, p.u],
        },
      }),
    ];
  if (p.m === null)
    return [
      audit(env, "space.member.remove", target, SYNC, {
        ...base,
        detail: { thaw: true },
        when: { sql: `exists (${MANUAL_IS})`, args: [p.s, p.u] },
      }),
    ];
  return [
    audit(env, "space.member.role", target, SYNC, {
      ...base,
      detail: { thaw: true, role: p.m },
      when: {
        sql: `exists (${MANUAL_IS} and role <> ?) and ${ACTIVE}`,
        args: [p.s, p.u, p.m, p.u],
      },
    }),
    audit(env, "space.member.add", target, SYNC, {
      ...base,
      detail: { thaw: true, role: p.m },
      when: {
        sql: `not exists (${MANUAL_IS}) and ${ACTIVE}`,
        args: [p.s, p.u, p.u],
      },
    }),
  ];
}

/**
 * Applies up to THAW_CHUNK frozen edits (one D1 batch), then closes the
 * sockets of the users whose role it lowered (restored rows included).
 * Resolves to whether edits remain. `guard` is re-checked right before the
 * batch (DirectorySync's epoch).
 */
export async function thawFrozenEdits(
  env: Env,
  o: {
    guard?: () => void;
    now?: number;
    ctx?: Pick<ExecutionContext, "waitUntil">;
  } = {},
): Promise<boolean> {
  const { results } = await stmt(env.DB, PAGE).bind(THAW_CHUNK).all<Row>();
  if (!results.length) return false;
  const pairs = results.map(validEdit);
  const chunk = JSON.stringify(pairs.map((p) => [p.s, p.u, p.t, p.m, p.k]));
  const now = o.now ?? Date.now();
  o.guard?.();
  const out = await env.DB.batch([
    stmt(env.DB, RANKS).bind(chunk),
    ...pairs.flatMap((p) => outcomeAudits(env, p)),
    stmt(env.DB, DROP_MANUAL).bind(chunk),
    stmt(env.DB, SET_MANUAL).bind(chunk),
    stmt(env.DB, ADD_MANUAL).bind(chunk, now),
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
  const narrowed = ((out.at(-1)?.results ?? []) as Ranked[])
    .filter((x) => (x.r ?? 0) < (before.get(key(x)) ?? 0))
    .map((x) => x.u);
  logInfo("directory_thaw", {
    edits: pairs.length,
    narrowed: narrowed.length,
  });
  // Never guarded: the batch committed, so its socket closes always follow.
  await revokeUsersLive(env, narrowed, "frozen edit undone", o.ctx);
  return results.length === THAW_CHUNK;
}

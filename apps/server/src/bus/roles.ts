// Role addresses (#1296): a member-set alias in one namespace (`backend-lead`)
// that points at one agent by its stable id, so it follows a rename. The only
// rerouting on the bus (design Decision 3): a send to a role resolves at send
// time to its holder; the system never guesses one. Only the member sets a
// role (BusHub.putRole, from the dashboard's REST); no frame does. One
// exception, by the user's decision (#1816): a session that reclaims an away
// holder's name (#1742) takes that holder's roles, except a role with reach.
//
// Adapted from OpenBus v0.63.0 apps/server/src/hub/roles.ts, without the
// agent card's `role` claim or the one-role-per-agent rule. A close does not
// clear the holder (v0.63 did): the role reads vacant while its holder isn't
// open in its namespace (holderOf), and the holder's reopened session holds
// it again, which lasting mailboxes (#1295, #1349) build on.
import {
  BusNameSchema,
  type RefusalReason,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { BUS_ROLE_MAX, type BusRole } from "@oa/shared";
import { iso } from "./dto.js";
import { AGENT_COLS, type AgentRow } from "./rows.js";

export type RoleResolution =
  | { ok: true; agent: AgentRow; viaRole: true }
  | { ok: false; reason: RefusalReason };

/**
 * #3132: a role re-pointed from one session to another, as recorded in
 * role_moves: the sessions' addresses at the time of the move.
 */
export type RoleMove = {
  roleId: string;
  fromAgentId: string;
  toAgentId: string;
  from: { namespace: string; name: string };
  to: { namespace: string; name: string };
};

export type PutRoleResult =
  | { ok: true; role: BusRole; moved: RoleMove | null }
  | { ok: false; reason: "invalid"; field: "namespace" | "name" }
  | { ok: false; reason: "name_taken" | "agent_not_open" | "role_limit" };

type Row = Record<string, SqlStorageValue>;
const all = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] => sql.exec<T>(q, ...b).toArray();
const one = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T | null => all<T>(sql, q, ...b)[0] ?? null;

/**
 * The SQL fragment (and its bindings after `lname`) that is true when a role
 * reserves `lname` from an agent: a role in `namespace`, or for a global
 * agent (visible everywhere) a role in any namespace. A vacant role still
 * reserves its name. For nameTaken (hub.ts).
 */
export function roleTakenSql(
  orgId: string,
  lname: string,
  namespace: string,
  global: boolean,
): { sql: string; binds: SqlStorageValue[] } {
  return global
    ? {
        sql: "exists (select 1 from roles indexed by roles_lname where org_id = ? and lname = ?)",
        binds: [orgId, lname],
      }
    : {
        sql: "exists (select 1 from roles where org_id = ? and namespace = ? and lname = ?)",
        binds: [orgId, namespace, lname],
      };
}

/**
 * The SQL fragment (and its bindings) that is true when an agent other than
 * `selfId` (null: none) holds `lname` as a chosen or held former name still
 * in its grace, reserved in the scope of an agent in `namespace` (`global`:
 * in any scope). OpenBus #451: a row reserves in the scope it was left in
 * (former_names namespace, global), not its agent's current one, so a move
 * or flip keeps it reserved where it was; a `held` row (a name an agent left
 * a scope under: a close, move or flip; #1448: a revoke frees them) reserves the same way, and
 * both reserve whether or not the agent is live. One definition for
 * nameTaken (hub.ts) and putRole, so a role never takes a name an agent
 * couldn't.
 */
export function formerReservedSql(
  orgId: string,
  lname: string,
  now: number,
  namespace: string,
  global: boolean,
  selfId: string | null,
): { sql: string; binds: SqlStorageValue[] } {
  return {
    sql: `exists (select 1 from former_names f
            where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind in ('chosen', 'held', 'away')
              and f.agent_id is not ?${global ? "" : " and (f.namespace = ? or f.global = 1)"})`,
    binds: [orgId, lname, now, selfId, ...(global ? [] : [namespace])],
  };
}

type StoredRole = {
  id: string;
  namespace: string;
  name: string;
  agentId: string | null;
  setAt: number;
  holderName: string | null;
  held: number;
};

const ROLE_SELECT = `select r.id, r.namespace, r.name, r.agent_id as agentId, r.set_at as setAt,
    h.name as holderName,
    (h.id is not null and h.live = 1 and (h.namespace = r.namespace or h.global = 1)) as held
  from roles r left join agents h on h.id = r.agent_id`;

const roleDto = (r: StoredRole): BusRole => ({
  id: r.id,
  namespace: r.namespace,
  name: r.name,
  agentId: r.agentId,
  holderName: r.holderName,
  vacant: r.held !== 1,
  setAt: iso(r.setAt),
});

/** Every role of the hub (at most `max`), by namespace then name. */
export function listRoles(
  sql: SqlStorage,
  orgId: string,
  max: number = BUS_ROLE_MAX,
): BusRole[] {
  return all<StoredRole>(
    sql,
    `${ROLE_SELECT} where r.org_id = ? order by r.namespace, r.lname limit ?`,
    orgId,
    max,
  ).map(roleDto);
}

/** A role write's refusal (putRole, and a proposal's dry run of it). */
export type RoleRefusal = Exclude<PutRoleResult, { ok: true }>;

/** The role (namespace, lname), as stored, or null. */
const roleRow = (
  sql: SqlStorage,
  orgId: string,
  namespace: string,
  lname: string,
) =>
  one<{ id: string; agentId: string | null }>(
    sql,
    "select id, agent_id as agentId from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    namespace,
    lname,
  );

/**
 * putRole's checks, writing nothing: ok with the role as stored (null: it
 * would be created), or the refusal putRole would answer. A proposal
 * (#1372) runs the same checks when it is made and again, through putRole,
 * when it is confirmed.
 */
export function checkRole(
  sql: SqlStorage,
  orgId: string,
  namespace: string,
  name: string,
  agentId: string | null,
  now: number,
  max: number = BUS_ROLE_MAX,
):
  | { ok: true; existing: { id: string; agentId: string | null } | null }
  | RoleRefusal {
  if (!WireNamespaceSchema.safeParse(namespace).success)
    return { ok: false, reason: "invalid", field: "namespace" };
  if (!BusNameSchema.safeParse(name).success)
    return { ok: false, reason: "invalid", field: "name" };
  const lname = name.toLowerCase();
  if (agentId !== null) {
    const agent = one<{ namespace: string; global: number }>(
      sql,
      "select namespace, global from agents where id = ? and org_id = ? and live = 1",
      agentId,
      orgId,
    );
    if (agent === null || (agent.global !== 1 && agent.namespace !== namespace))
      return { ok: false, reason: "agent_not_open" };
  }
  const former = formerReservedSql(orgId, lname, now, namespace, false, null);
  const taken = one<{ x: number }>(
    sql,
    `select (exists (select 1 from agents where org_id = ? and lower(name) = ? and live = 1 and (namespace = ? or global = 1))
         or ${former.sql}
         or exists (select 1 from minted_names where org_id = ? and lname = ? and agent_id is not ?)) as x`,
    orgId,
    lname,
    namespace,
    ...former.binds,
    orgId,
    lname,
    agentId,
  );
  if (taken?.x === 1) return { ok: false, reason: "name_taken" };
  const existing = roleRow(sql, orgId, namespace, lname);
  if (
    existing === null &&
    (one<{ n: number }>(
      sql,
      "select count(*) as n from roles where org_id = ?",
      orgId,
    )?.n ?? 0) >= max
  )
    return { ok: false, reason: "role_limit" };
  return { ok: true, existing };
}

/**
 * Sets role (`namespace`, `name`) to `agentId`, or vacates it (null),
 * creating it if needed (a new random id); re-pointing keeps its id, and the
 * stored display name follows the latest call. Refused (nothing written,
 * checkRole):
 * - invalid (with the field): not a wire namespace, or not a bus name
 *   (reserved names too);
 * - agent_not_open: the agent isn't open, or is neither in `namespace` nor
 *   global;
 * - name_taken: a live agent visible in `namespace` (in it, or a global) has
 *   the name, or an agent holds it as a chosen or held former name still in
 *   its grace reserved there (R393b; OpenBus #451: in the scope the name was
 *   left in, live or not, formerReservedSql, as nameTaken), any case; or it
 *   was minted for an
 *   agent other than `agentId` (OpenBus #446: a minted name is never handed
 *   on, in any scope, so a default former name needs no reservation);
 * - role_limit: `max` roles exist and this would add one.
 */
export function putRole(
  sql: SqlStorage,
  orgId: string,
  namespace: string,
  name: string,
  agentId: string | null,
  now: number,
  newId: () => string,
  max: number = BUS_ROLE_MAX,
): PutRoleResult {
  const c = checkRole(sql, orgId, namespace, name, agentId, now, max);
  if (!c.ok) return c;
  const lname = name.toLowerCase();
  const id = c.existing?.id ?? newId();
  sql.exec(
    `insert into roles (id, org_id, namespace, name, lname, agent_id, set_at) values (?, ?, ?, ?, ?, ?, ?)
     on conflict (org_id, namespace, lname) do update set name = excluded.name, agent_id = excluded.agent_id, set_at = excluded.set_at`,
    id,
    orgId,
    namespace,
    name,
    lname,
    agentId,
    now,
  );
  const row = one<StoredRole>(sql, `${ROLE_SELECT} where r.id = ?`, id);
  if (row === null) throw new Error("role row missing after write");
  const prior = c.existing?.agentId ?? null;
  const moved =
    prior !== null && agentId !== null && prior !== agentId
      ? recordMove(sql, orgId, id, prior, agentId, now, newId)
      : null;
  return { ok: true, role: roleDto(row), moved };
}

/**
 * #3132: the role's live holder hands it to its open agent `agentName`, at
 * once (Leo's pick, 2026-11-26: "The holder hands it over, or you
 * approve"). not_holder when the session with `identityId` is not the
 * role's live holder, or names itself: then nothing is handed over and the
 * caller only proposes. Otherwise putRole's answer (ambiguous: two open agents have the
 * name).
 */
export type HandOverResult =
  | PutRoleResult
  | { ok: false; reason: "ambiguous" | "not_holder" };

export function handOver(
  sql: SqlStorage,
  orgId: string,
  identityId: string,
  namespace: string,
  name: string,
  agentName: string,
  now: number,
  newId: () => string,
  max: number = BUS_ROLE_MAX,
): HandOverResult {
  const notHolder = { ok: false, reason: "not_holder" } as const;
  const role = roleRow(sql, orgId, namespace, name.toLowerCase());
  if (role?.agentId == null) return notHolder;
  const holder = one<{ id: string }>(
    sql,
    `select id from agents where org_id = ? and id = ? and live = 1 and identity_id = ?
       and (namespace = ? or global = 1)`,
    orgId,
    role.agentId,
    identityId,
    namespace,
  );
  if (holder === null) return notHolder;
  const named = all<{ id: string }>(
    sql,
    `select id from agents where org_id = ? and lower(name) = ? and live = 1
       and (namespace = ? or global = 1) limit 2`,
    orgId,
    agentName.toLowerCase(),
    namespace,
  );
  if (named.length > 1) return { ok: false, reason: "ambiguous" };
  const to = named[0]?.id ?? "";
  if (to === holder.id) return notHolder;
  return putRole(sql, orgId, namespace, name, to, now, newId, max);
}

/**
 * #3132: records that role `roleId` moved from agent `fromId` to `toId`,
 * with the from-session's address and identity as they are now (its agents
 * row may be gone later). Null when either row is already gone: there is no
 * address to forward from.
 */
function recordMove(
  sql: SqlStorage,
  orgId: string,
  roleId: string,
  fromId: string,
  toId: string,
  now: number,
  newId: () => string,
): RoleMove | null {
  const row = (id: string) =>
    one<{ namespace: string; name: string; identity: string | null }>(
      sql,
      "select namespace, name, identity_id as identity from agents where org_id = ? and id = ?",
      orgId,
      id,
    );
  const from = row(fromId);
  const to = row(toId);
  if (from === null || to === null) return null;
  sql.exec(
    `insert into role_moves (id, org_id, role_id, from_agent_id, from_ns, from_lname, from_identity, to_agent_id, at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    orgId,
    roleId,
    fromId,
    from.namespace,
    from.name.toLowerCase(),
    from.identity,
    toId,
    now,
  );
  return {
    roleId,
    fromAgentId: fromId,
    toAgentId: toId,
    from: { namespace: from.namespace, name: from.name },
    to: { namespace: to.namespace, name: to.name },
  };
}

/** #1889 namesOf's row, with #3132's role (roleOfIdentity). */
export type AgentNameRow = {
  identityId: string;
  name: string;
  role?: string;
  holder?: string;
};

/**
 * #3132: the role the session with `identityId` holds now (no `holder`), or
 * else the role it last handed on, with `holder` the session holding it now
 * (none while it is vacant). Empty when it never held one, or the role is gone.
 */
export function roleOfIdentity(
  sql: SqlStorage,
  orgId: string,
  identityId: string,
): { role?: string; holder?: string } {
  const held = one<{ role: string }>(
    sql,
    `select r.name as role from roles r join agents a on a.id = r.agent_id
       where r.org_id = ? and a.identity_id = ? order by r.set_at desc limit 1`,
    orgId,
    identityId,
  );
  if (held) return { role: held.role };
  const moved = one<{ role: string; holder: string | null }>(
    sql,
    `select r.name as role, h.name as holder from role_moves m indexed by role_moves_identity
       join roles r on r.id = m.role_id
       left join agents h on h.id = r.agent_id
       where m.org_id = ? and m.from_identity = ? order by m.at desc, m.rowid desc limit 1`,
    orgId,
    identityId,
  );
  if (!moved) return {};
  return moved.holder
    ? { role: moved.role, holder: moved.holder }
    : { role: moved.role };
}

/**
 * #3132: where a notice for a session that handed its role on goes now: the
 * role's live holder. `identity` set: the move of the session with that
 * identity. Otherwise the move from address (ns, lname), only while no other
 * agent has taken that name since (a namesake inherits nothing, #3208). The
 * latest such move wins; none applies once the session holds the role again
 * or the role is vacant, removed or held by nobody live. Null: deliver as
 * addressed.
 */
export function roleForward(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  lname: string,
  identity: string | null,
): AgentRow | null {
  const move = one<{ roleId: string; fromId: string }>(
    sql,
    identity !== null
      ? `select role_id as roleId, from_agent_id as fromId from role_moves indexed by role_moves_identity
           where org_id = ? and from_identity = ? order by at desc, rowid desc limit 1`
      : `select role_id as roleId, from_agent_id as fromId from role_moves indexed by role_moves_from
           where org_id = ? and from_ns = ? and from_lname = ?
             and not exists (select 1 from agents a where a.org_id = role_moves.org_id
               and lower(a.name) = role_moves.from_lname and a.namespace = role_moves.from_ns
               and a.id <> role_moves.from_agent_id)
           order by at desc, rowid desc limit 1`,
    ...(identity !== null ? [orgId, identity] : [orgId, ns, lname]),
  );
  if (move === null) return null;
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where id =
       (select r.agent_id from roles r where r.org_id = ? and r.id = ? and r.agent_id <> ?)
       and live = 1 and (namespace = (select namespace from roles where id = ?) or global = 1)`,
    orgId,
    move.roleId,
    move.fromId,
    move.roleId,
  );
}

/** Removes role `id`; false when there was none. The name is free at once. */
export function deleteRole(
  sql: SqlStorage,
  orgId: string,
  id: string,
): boolean {
  // #1346: the role's reach goes with it.
  sql.exec(
    `delete from reach_grants where org_id = ? and (role_ns, lname) in
       (select namespace, lname from roles where org_id = ? and id = ?)`,
    orgId,
    orgId,
    id,
  );
  return (
    sql.exec("delete from roles where org_id = ? and id = ?", orgId, id)
      .rowsWritten > 0
  );
}

/**
 * Role `lname` in `ns` resolved: its live holder, or role_vacant. With
 * `awayAt` (#1349, a mailbox-capable sender; the time) a holder that is away
 * resolves too, so the send queues in its mailbox: closed (not live), its
 * `away` reservation unexpired (a newcomer's reclaim, #1742, releases it: a
 * plain role moves to the newcomer, a role with reach is then vacant), its machine not revoked, and still in the role's
 * namespace or global. A vacated role, or a holder that moved, stays vacant.
 */
function holderOf(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  lname: string,
  awayAt?: number,
): RoleResolution {
  const agent = one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where id =
       (select r.agent_id from roles r where r.org_id = ? and r.namespace = ? and r.lname = ?)
       and live = 1 and (namespace = ? or global = 1)`,
    orgId,
    ns,
    lname,
    ns,
  );
  if (agent) return { ok: true, agent, viaRole: true };
  if (awayAt !== undefined) {
    const away = one<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where id =
         (select r.agent_id from roles r where r.org_id = ? and r.namespace = ? and r.lname = ?)
         and live = 0 and (namespace = ? or global = 1)
         and exists (select 1 from former_names f where f.agent_id = agents.id and f.kind = 'away' and f.expires_at > ?)
         and not exists (select 1 from machines m where m.id = agents.machine_id and m.revoked_at is not null)`,
      orgId,
      ns,
      lname,
      ns,
      awayAt,
    );
    if (away) return { ok: true, agent: away, viaRole: true };
  }
  return { ok: false, reason: "role_vacant" };
}

const roleIn = (sql: SqlStorage, orgId: string, ns: string, lname: string) =>
  one(
    sql,
    "select 1 as x from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    ns,
    lname,
  ) !== null;

/**
 * The role `lname` in namespace `ns`, resolved, or null when `ns` has no such
 * role (name resolution runs). Within a scope a role comes first: no live
 * agent can share its name there.
 */
export function resolveRoleIn(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  lname: string,
  awayAt?: number,
): RoleResolution | null {
  return roleIn(sql, orgId, ns, lname)
    ? holderOf(sql, orgId, ns, lname, awayAt)
    : null;
}

/**
 * A global sender's role target outside its own namespace (no to_namespace),
 * or null when no namespace has a role `lname`. A role in two namespaces is
 * ambiguous; so is one role while a live agent elsewhere has the name
 * (`elsewhere`: hub.ts checks current and former names outside the role's
 * scope). The system never picks one.
 */
export function resolveRoleAnywhere(
  sql: SqlStorage,
  orgId: string,
  lname: string,
  elsewhere: (ns: string) => boolean,
  awayAt?: number,
): RoleResolution | null {
  const hits = all<{ namespace: string }>(
    sql,
    "select namespace from roles indexed by roles_lname where org_id = ? and lname = ? limit 2",
    orgId,
    lname,
  );
  const hit = hits[0];
  if (hit === undefined) return null;
  if (hits.length > 1 || elsewhere(hit.namespace))
    return { ok: false, reason: "ambiguous" };
  return holderOf(sql, orgId, hit.namespace, lname, awayAt);
}

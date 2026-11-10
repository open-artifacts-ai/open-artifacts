// Scoped role reach (#1346): the member lets a role reach other namespaces.
// Its live holder then sees and messages the agents there, and they reply to
// it. A grant is one `reach_grants` row per (role, target namespace). The
// holder is read from `roles` (follows a re-point, vacant gives none), and
// reach is never transitive: it opens the holder's own view only, never the
// target's view of the holder's other agents. Only the member writes one:
// directly (BusHub.putReach) or by confirming an agent's proposal on its
// one-time link (bus/reach-proposals.ts); no frame and no MCP tool does.
import { WireNamespaceSchema } from "@oa/bus-protocol";
import { BUS_REACH_MAX, BUS_REACH_PER_ROLE } from "@oa/shared";

export type ReachGrant = {
  id: string;
  roleNamespace: string;
  roleName: string;
  namespace: string;
  createdAt: number;
};

export type PutReachResult =
  | { ok: true; grant: ReachGrant; created: boolean }
  | { ok: false; reason: "invalid"; field: "namespace" | "target" }
  | { ok: false; reason: "role_unknown" | "reach_limit" };

type Row = Record<string, SqlStorageValue>;
const all = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] => sql.exec<T>(q, ...b).toArray();

// The role's name is read from roles (a case rename updates it there, not on
// the grant); the grant's own copy is only the fallback.
const GRANT_FROM = `reach_grants g left join roles r on r.org_id = g.org_id and r.namespace = g.role_ns and r.lname = g.lname`;
const GRANT_COLS =
  "g.id as id, g.role_ns as roleNamespace, coalesce(r.name, g.role_name) as roleName, g.target_ns as namespace, g.created_at as createdAt";

/** True when the hub has any grant: every lookup below returns at once when not. */
const anyReach = (sql: SqlStorage, orgId: string): boolean =>
  all(sql, "select 1 as x from reach_grants where org_id = ? limit 1", orgId)
    .length > 0;

/**
 * The namespaces the roles held by agent `agentId` reach, sorted: the
 * agent's reach set R. The agent must be live, non-global and in its role's
 * namespace (the holder, as listRoles and holderOf read it): a holder that
 * moved to another namespace, or flipped global, has none while the role
 * reads vacant. [] when there are no grants.
 */
export function reachNamespaces(
  sql: SqlStorage,
  orgId: string,
  agentId: string,
  max = BUS_REACH_MAX,
): string[] {
  if (!anyReach(sql, orgId)) return [];
  return all<{ ns: string }>(
    sql,
    `select distinct g.target_ns as ns from roles r
       join agents a on a.id = r.agent_id and a.live = 1 and a.global = 0 and a.namespace = r.namespace
       join reach_grants g on g.org_id = r.org_id and g.role_ns = r.namespace and g.lname = r.lname
      where r.org_id = ? and r.agent_id = ? and g.mode = 'reach'
      order by ns limit ?`,
    orgId,
    agentId,
    max,
  ).map((r) => r.ns);
}

/**
 * The live agents whose roles reach namespace `ns`, as ids: the holders that
 * must hear about a change in `ns` (same holder rule as reachNamespaces).
 * Bounded by `max` (reach_grants_target).
 */
export function holdersReaching(
  sql: SqlStorage,
  orgId: string,
  ns: string,
  max = BUS_REACH_MAX,
): string[] {
  if (!anyReach(sql, orgId)) return [];
  return all<{ id: string }>(
    sql,
    `select distinct r.agent_id as id from reach_grants g
       join roles r on r.org_id = g.org_id and r.namespace = g.role_ns and r.lname = g.lname
       join agents a on a.id = r.agent_id and a.live = 1 and a.global = 0 and a.namespace = r.namespace
      where g.org_id = ? and g.mode = 'reach' and g.target_ns = ?
      limit ?`,
    orgId,
    ns,
    max,
  ).map((r) => r.id);
}

/**
 * True when agent `holderId` holds a role that reaches `ns` and is still in
 * that role's namespace as a non-global agent. Live or away: the reply path
 * may leave mail for an away holder.
 */
export function holderReaches(
  sql: SqlStorage,
  orgId: string,
  holderId: string,
  ns: string,
): boolean {
  if (!anyReach(sql, orgId)) return false;
  return (
    all(
      sql,
      `select 1 as x from roles r
         join agents a on a.id = r.agent_id and a.global = 0 and a.namespace = r.namespace
         join reach_grants g on g.org_id = r.org_id and g.role_ns = r.namespace and g.lname = r.lname
        where r.org_id = ? and r.agent_id = ? and g.mode = 'reach' and g.target_ns = ? limit 1`,
      orgId,
      holderId,
      ns,
    ).length > 0
  );
}

/** Every grant of the hub (at most `max`), by role then target namespace. */
export function listReach(
  sql: SqlStorage,
  orgId: string,
  max = BUS_REACH_MAX,
): ReachGrant[] {
  return all<ReachGrant>(
    sql,
    `select ${GRANT_COLS} from ${GRANT_FROM} where g.org_id = ? and g.mode = 'reach'
      order by g.role_ns, g.lname, g.target_ns limit ?`,
    orgId,
    max,
  );
}

/** The namespaces role (`roleNs`, `roleName`) reaches, sorted. */
export function reachOfRole(
  sql: SqlStorage,
  orgId: string,
  roleNs: string,
  lname: string,
  max = BUS_REACH_PER_ROLE,
): string[] {
  return all<{ ns: string }>(
    sql,
    `select target_ns as ns from reach_grants
      where org_id = ? and role_ns = ? and lname = ? and mode = 'reach' order by ns limit ?`,
    orgId,
    roleNs,
    lname,
    max,
  ).map((r) => r.ns);
}

/**
 * Lets role (`roleNs`, `roleName`) reach `target`. Idempotent. Refused:
 * invalid (a namespace that is not canonical, or the role's own namespace),
 * role_unknown (no such role: the role is the key), reach_limit (the hub or
 * the role is at its share).
 */
export function addReach(
  sql: SqlStorage,
  orgId: string,
  roleNs: string,
  roleName: string,
  target: string,
  now: number,
  newId: () => string,
  max = BUS_REACH_MAX,
  perRole = BUS_REACH_PER_ROLE,
  /** Set when a confirmed agent proposal (not the member's own add) grants it: the proposing machine. */
  viaMachine: string | null = null,
): PutReachResult {
  if (!WireNamespaceSchema.safeParse(roleNs).success)
    return { ok: false, reason: "invalid", field: "namespace" };
  if (!WireNamespaceSchema.safeParse(target).success || target === roleNs)
    return { ok: false, reason: "invalid", field: "target" };
  const lname = roleName.toLowerCase();
  const role = all<{ name: string }>(
    sql,
    "select name from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    roleNs,
    lname,
  )[0];
  if (!role) return { ok: false, reason: "role_unknown" };
  const read = () =>
    all<ReachGrant>(
      sql,
      `select ${GRANT_COLS} from ${GRANT_FROM}
        where g.org_id = ? and g.role_ns = ? and g.lname = ? and g.mode = 'reach' and g.target_ns = ?`,
      orgId,
      roleNs,
      lname,
      target,
    )[0];
  const had = read();
  if (had) return { ok: true, grant: had, created: false };
  const n = all<{ n: number }>(
    sql,
    "select count(*) as n from reach_grants where org_id = ?",
    orgId,
  )[0]?.n;
  if ((n ?? 0) >= max) return { ok: false, reason: "reach_limit" };
  if (reachOfRole(sql, orgId, roleNs, lname, perRole).length >= perRole)
    return { ok: false, reason: "reach_limit" };
  sql.exec(
    `insert into reach_grants (id, org_id, role_ns, role_name, lname, mode, target_ns, created_at, granted_by, machine_id)
     values (?, ?, ?, ?, ?, 'reach', ?, ?, ?, ?)`,
    newId(),
    orgId,
    roleNs,
    role.name,
    lname,
    target,
    now,
    viaMachine === null ? "member" : "request",
    viaMachine,
  );
  const grant = read();
  if (!grant) throw new Error("reach grant not stored");
  return { ok: true, grant, created: true };
}

/** Removes grant `id`; returns it, or null when unknown. */
export function removeReach(
  sql: SqlStorage,
  orgId: string,
  id: string,
): ReachGrant | null {
  const row = all<ReachGrant>(
    sql,
    `select ${GRANT_COLS} from ${GRANT_FROM} where g.org_id = ? and g.mode = 'reach' and g.id = ?`,
    orgId,
    id,
  )[0];
  if (!row) return null;
  sql.exec("delete from reach_grants where org_id = ? and id = ?", orgId, id);
  return row;
}

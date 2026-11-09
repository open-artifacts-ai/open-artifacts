// Reach proposals (#1346): the agent that holds a role asks, through its
// machine's token (POST R.busReachProposals), that the role reach other
// namespaces. A machine token alone must never mint reach, so this only
// records a proposal; the member confirms it in a browser on its one-time
// link (bus/reach-confirm.ts), the same flow as link proposals (#1567) and
// role proposals (#1372). This is the hub's side, run by BusHub's
// Worker-only RPC methods.
//
// The role is never named by the caller: it is the role the hub finds the
// agent holding (the live, non-global agent in the role's namespace, as
// reachNamespaces reads a holder), so a peer can't ask for another agent's
// role. A proposal is bound to what the member sees: the role, its holder
// and the namespaces. It applies only while the role is still the same role
// with the same holder under the same name, through addReach (the member's
// own REST write, same limits), all of its namespaces or none. It is
// decided once: applied, refused or expired.
import { WireNamespaceSchema } from "@oa/bus-protocol";
import {
  BUS_REACH_MAX,
  BUS_REACH_PER_ROLE,
  BUS_REACH_PROPOSAL_TTL_MS,
  BUS_REACH_PROPOSALS_PENDING_MAX,
  BUS_REACH_PROPOSALS_PER_MACHINE_HOUR,
} from "@oa/shared";
import { addReach, reachOfRole } from "./reach.js";

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

const RETAIN_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

/** What a decided or viewed proposal shows. */
export type ReachProposalView = {
  id: string;
  roleId: string;
  roleNamespace: string;
  roleName: string;
  /** The holder's name when it was proposed. */
  agentName: string;
  agentId: string;
  /** The namespaces asked for, sorted. */
  namespaces: string[];
  machineId: string;
  expiresAt: number;
  createdAt: number;
  /** The proposing machine's label (null: gone). */
  machineLabel: string | null;
  status: "pending" | "applied" | "refused" | "expired";
  reason: string | null;
};

/** The ids an audit row may carry (never names or namespaces). */
export type ReachAudit = {
  proposalId: string;
  roleId: string;
  agentId: string;
  machineId: string;
};

export type ReachRefusalReason =
  | "unknown"
  | "used"
  | "expired"
  | "changed"
  | "reach_limit"
  | "rejected";

export type ReachProposeResult =
  | { ok: true; proposal: ReachProposalView; expired: ReachAudit[] }
  | {
      ok: false;
      reason: "invalid";
      field: "namespaces" | "nativeRef";
      expired: ReachAudit[];
    }
  | {
      ok: false;
      reason: "no_role" | "ambiguous" | "rate_limited" | "proposal_limit";
      expired: ReachAudit[];
    };

type Detail = {
  proposal: ReachProposalView;
  /** The namespaces already granted to the role: confirming adds only the rest. */
  noop: boolean;
  /** Of the namespaces asked for, those no agent of this hub ever used. */
  unknown: string[];
};

export type ReachViewResult =
  | ({ ok: true; expired: ReachAudit[] } & Detail)
  | {
      ok: false;
      reason: ReachRefusalReason;
      proposal: ReachProposalView | null;
      expired: ReachAudit[];
    };

export type ReachDecideResult =
  | {
      ok: true;
      proposal: ReachProposalView;
      noop: boolean;
      audit: ReachAudit;
      expired: ReachAudit[];
      /** Set when grants were added: the role's namespace, to tell its machines. */
      changed: string | null;
    }
  | {
      ok: false;
      reason: ReachRefusalReason;
      proposal: ReachProposalView | null;
      /** Present when this call decided the proposal (refused): audit it. */
      audit: ReachAudit | null;
      expired: ReachAudit[];
    };

type Stored = {
  id: string;
  roleId: string;
  roleNamespace: string;
  roleName: string;
  agentName: string;
  agentId: string;
  namespaces: string;
  machineId: string;
  expiresAt: number;
  createdAt: number;
  machineLabel: string | null;
  status: ReachProposalView["status"];
  reason: string | null;
};

const SELECT = `select p.id, p.role_id as roleId, p.role_ns as roleNamespace, p.role_name as roleName,
    p.agent_name as agentName, p.agent_id as agentId, p.namespaces, p.machine_id as machineId,
    p.expires_at as expiresAt, p.created_at as createdAt, m.label as machineLabel, p.status, p.reason
  from reach_proposals p left join machines m on m.org_id = p.org_id and m.id = p.machine_id`;

const view = (r: Stored): ReachProposalView => ({
  ...r,
  namespaces: JSON.parse(r.namespaces) as string[],
});

const auditOf = (p: {
  id?: string;
  proposalId?: string;
  roleId: string;
  agentId: string;
  machineId: string;
}): ReachAudit => ({
  proposalId: p.proposalId ?? p.id ?? "",
  roleId: p.roleId,
  agentId: p.agentId,
  machineId: p.machineId,
});

const byHash = (sql: SqlStorage, orgId: string, hash: string) => {
  const r = one<Stored>(
    sql,
    `${SELECT} where p.org_id = ? and p.token_hash = ?`,
    orgId,
    hash,
  );
  return r === null ? null : view(r);
};

const EXPIRED = `returning id, role_id as roleId, agent_id as agentId, machine_id as machineId`;

/** Marks overdue pending proposals expired and drops decided ones past retention. Returns the newly expired, for their audit rows. */
export function expireReachProposals(
  sql: SqlStorage,
  orgId: string,
  now: number,
): ReachAudit[] {
  const gone = all<{
    id: string;
    roleId: string;
    agentId: string;
    machineId: string;
  }>(
    sql,
    `update reach_proposals set status = 'expired', decided_at = ?
      where org_id = ? and status = 'pending' and expires_at <= ? ${EXPIRED}`,
    now,
    orgId,
    now,
  ).map(auditOf);
  sql.exec(
    "delete from reach_proposals where org_id = ? and status != 'pending' and decided_at < ?",
    orgId,
    now - RETAIN_MS,
  );
  return gone;
}

/**
 * Expires the pending proposals `machineId` made, at once, when the machine
 * is revoked. Decided ones and other machines' are untouched. Returns the
 * newly expired, for their audit rows.
 */
export function expireReachProposalsOfMachine(
  sql: SqlStorage,
  orgId: string,
  machineId: string,
  now: number,
): ReachAudit[] {
  return all<{
    id: string;
    roleId: string;
    agentId: string;
    machineId: string;
  }>(
    sql,
    `update reach_proposals set status = 'expired', decided_at = ?
      where org_id = ? and machine_id = ? and status = 'pending' ${EXPIRED}`,
    now,
    orgId,
    machineId,
  ).map(auditOf);
}

/**
 * The role the agent `nativeRef` of machine `machineId` holds: the roles
 * naming it as their holder while it is live, non-global and in the role's
 * namespace (the holder rule of reachNamespaces). At most two, to tell
 * none, one and several apart.
 */
const rolesHeldBy = (
  sql: SqlStorage,
  orgId: string,
  machineId: string,
  nativeRef: string,
) =>
  all<{
    roleId: string;
    namespace: string;
    name: string;
    lname: string;
    agentId: string;
    agentName: string;
  }>(
    sql,
    `select r.id as roleId, r.namespace, r.name, r.lname, a.id as agentId, a.name as agentName
       from agents a join roles r on r.org_id = a.org_id and r.agent_id = a.id and r.namespace = a.namespace
      where a.org_id = ? and a.machine_id = ? and a.native_ref = ? and a.live = 1 and a.global = 0
      order by r.lname limit 2`,
    orgId,
    machineId,
    nativeRef,
  );

/**
 * Records a proposal from agent `nativeRef` of `machineId` under
 * `tokenHash` (the sha256 of the confirm link's secret, minted by the
 * Worker). Grants nothing. Refused: `invalid` (a namespace not canonical, or
 * the role's own), `no_role` (the agent holds no role), `ambiguous` (it
 * holds several: the role is never named by the caller), `proposal_limit`
 * (BUS_REACH_PROPOSALS_PENDING_MAX waiting), `rate_limited` (this machine
 * already made BUS_REACH_PROPOSALS_PER_MACHINE_HOUR in the last hour).
 */
export function proposeReach(
  sql: SqlStorage,
  orgId: string,
  input: { nativeRef: string; namespaces: string[] },
  machineId: string,
  tokenHash: string,
  now: number,
  newId: () => string,
): ReachProposeResult {
  const expired = expireReachProposals(sql, orgId, now);
  const namespaces = [...new Set(input.namespaces)].sort();
  if (
    namespaces.length === 0 ||
    namespaces.length > BUS_REACH_PER_ROLE ||
    namespaces.some((n) => !WireNamespaceSchema.safeParse(n).success)
  )
    return { ok: false, reason: "invalid", field: "namespaces", expired };
  const held = rolesHeldBy(sql, orgId, machineId, input.nativeRef);
  const role = held[0];
  if (role === undefined) return { ok: false, reason: "no_role", expired };
  if (held.length > 1) return { ok: false, reason: "ambiguous", expired };
  if (namespaces.includes(role.namespace))
    return { ok: false, reason: "invalid", field: "namespaces", expired };
  const recent =
    one<{ n: number }>(
      sql,
      "select count(*) as n from reach_proposals where org_id = ? and machine_id = ? and created_at > ?",
      orgId,
      machineId,
      now - HOUR_MS,
    )?.n ?? 0;
  if (recent >= BUS_REACH_PROPOSALS_PER_MACHINE_HOUR)
    return { ok: false, reason: "rate_limited", expired };
  const pending =
    one<{ n: number }>(
      sql,
      "select count(*) as n from reach_proposals where org_id = ? and status = 'pending'",
      orgId,
    )?.n ?? 0;
  if (pending >= BUS_REACH_PROPOSALS_PENDING_MAX)
    return { ok: false, reason: "proposal_limit", expired };
  sql.exec(
    `insert into reach_proposals (id, org_id, token_hash, role_id, role_ns, role_name, agent_id, agent_name,
       namespaces, machine_id, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    orgId,
    tokenHash,
    role.roleId,
    role.namespace,
    role.name,
    role.agentId,
    role.agentName,
    JSON.stringify(namespaces),
    machineId,
    now,
    now + BUS_REACH_PROPOSAL_TTL_MS,
  );
  const row = byHash(sql, orgId, tokenHash);
  if (row === null) throw new Error("reach proposal row missing after write");
  return { ok: true, proposal: row, expired };
}

/**
 * Whether pending proposal `p` would apply now: null when yes, else why
 * not. The binding: the role is still the same role (id and namespace)
 * pointing at the same agent, that agent still holds it (live, non-global,
 * in the role's namespace) under the name the member is shown, then the
 * limits for the namespaces not yet granted.
 */
function blocker(
  sql: SqlStorage,
  orgId: string,
  p: ReachProposalView,
): { why: "changed" | "reach_limit" | null; fresh: string[] } {
  const same = one(
    sql,
    `select 1 as x from roles r join agents a on a.id = r.agent_id and a.live = 1 and a.global = 0
         and a.namespace = r.namespace and a.name = ?
      where r.org_id = ? and r.id = ? and r.namespace = ? and r.agent_id = ?`,
    p.agentName,
    orgId,
    p.roleId,
    p.roleNamespace,
    p.agentId,
  );
  const have = new Set(
    reachOfRole(
      sql,
      orgId,
      p.roleNamespace,
      p.roleName.toLowerCase(),
      BUS_REACH_MAX,
    ),
  );
  const fresh = p.namespaces.filter((n) => !have.has(n));
  if (same === null) return { why: "changed", fresh };
  if (fresh.length === 0) return { why: null, fresh };
  const total =
    one<{ n: number }>(
      sql,
      "select count(*) as n from reach_grants where org_id = ?",
      orgId,
    )?.n ?? 0;
  if (
    have.size + fresh.length > BUS_REACH_PER_ROLE ||
    total + fresh.length > BUS_REACH_MAX
  )
    return { why: "reach_limit", fresh };
  return { why: null, fresh };
}

/** Of `namespaces`, those no agent of this hub has ever used (shown on the card, never refused). */
const neverUsed = (sql: SqlStorage, orgId: string, namespaces: string[]) => {
  const seen = new Set(
    all<{ namespace: string }>(
      sql,
      `select distinct namespace from agents where org_id = ?
         and namespace in (select value from json_each(?))`,
      orgId,
      JSON.stringify(namespaces),
    ).map((r) => r.namespace),
  );
  return namespaces.filter((n) => !seen.has(n));
};

/** The proposal behind `tokenHash`, for the confirm page; decides nothing but expiry. */
export function viewReachProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  now: number,
): ReachViewResult {
  const expired = expireReachProposals(sql, orgId, now);
  const p = byHash(sql, orgId, tokenHash);
  if (p === null)
    return { ok: false, reason: "unknown", proposal: null, expired };
  if (p.status !== "pending")
    return {
      ok: false,
      reason: p.status === "expired" ? "expired" : "used",
      proposal: p,
      expired,
    };
  const b = blocker(sql, orgId, p);
  if (b.why !== null) return { ok: false, reason: b.why, proposal: p, expired };
  return {
    ok: true,
    proposal: p,
    noop: b.fresh.length === 0,
    unknown: neverUsed(sql, orgId, p.namespaces),
    expired,
  };
}

/**
 * Decides the proposal behind `tokenHash`, once. "confirm" applies it
 * through addReach while it is pending, unexpired and still bound (blocker),
 * every namespace or none, then marks it applied; a blocker marks it
 * refused with that reason. "reject" marks it refused (`rejected`). One
 * synchronous run in the hub, so a proposal applies at most once.
 */
export function decideReachProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  decision: "confirm" | "reject",
  now: number,
  newId: () => string,
): ReachDecideResult {
  const expired = expireReachProposals(sql, orgId, now);
  const p = byHash(sql, orgId, tokenHash);
  if (p === null)
    return {
      ok: false,
      reason: "unknown",
      proposal: null,
      audit: null,
      expired,
    };
  if (p.status !== "pending")
    return {
      ok: false,
      reason: p.status === "expired" ? "expired" : "used",
      proposal: p,
      audit: null,
      expired,
    };
  const settle = (status: "applied" | "refused", reason: string | null) => {
    sql.exec(
      "update reach_proposals set status = ?, reason = ?, decided_at = ? where id = ? and status = 'pending'",
      status,
      reason,
      now,
      p.id,
    );
    return byHash(sql, orgId, tokenHash) ?? p;
  };
  const audit = auditOf({ ...p, proposalId: p.id });
  const refuse = (reason: ReachRefusalReason): ReachDecideResult => ({
    ok: false,
    reason,
    proposal: settle("refused", reason),
    audit,
    expired,
  });
  if (decision === "reject") return refuse("rejected");
  const b = blocker(sql, orgId, p);
  if (b.why !== null) return refuse(b.why);
  for (const ns of b.fresh) {
    const r = addReach(
      sql,
      orgId,
      p.roleNamespace,
      p.roleName,
      ns,
      now,
      newId,
      BUS_REACH_MAX,
      BUS_REACH_PER_ROLE,
      p.machineId,
    );
    if (!r.ok) return refuse("changed");
  }
  const noop = b.fresh.length === 0;
  return {
    ok: true,
    proposal: settle("applied", noop ? "noop" : null),
    noop,
    audit,
    expired,
    changed: noop ? null : p.roleNamespace,
  };
}

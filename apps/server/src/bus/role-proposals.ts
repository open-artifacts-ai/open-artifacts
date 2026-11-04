// Role proposals (#1372): a role change an AI agent proposed for the member
// over MCP (bus_role_propose). The user's guardrail ("Let's do B", then "1,
// propose via MCP, I confirm by link"): nothing changes until the member
// confirms it in a browser on its one-time link. This is the hub's side,
// run by BusHub's Worker-only RPC methods; services/bus.ts mints the link
// and bus/role-confirm.ts is the page that confirms.
//
// A proposal is bound to what the member will see: the action, the role
// (namespace, name; its id unless it is new), the new holder's agent id and
// the holder it displaces. It applies only while the role is still exactly
// as it was when proposed, through putRole or deleteRole (roles.ts), the
// browser REST path's own functions, so putRole's checks run again then.
// It is decided once: applied, refused or expired.
import {
  BUS_ROLE_MAX,
  BUS_ROLE_PROPOSAL_TTL_MS,
  BUS_ROLE_PROPOSALS_LISTED,
  BUS_ROLE_PROPOSALS_PENDING_MAX,
  type BusRole,
  type BusRoleProposal,
  type BusRoleProposalAction,
} from "@oa/shared";
import { iso } from "./dto.js";
import { checkRole, deleteRole, putRole, type RoleRefusal } from "./roles.js";

/** Decided proposals kept for the dashboard: at most this many, and none older than RETAIN_MS. */
const RETAIN_MAX = 100;
const RETAIN_MS = 7 * 24 * 3_600_000;

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

/** What a proposal asks for (bus_role_propose, after the tool's own checks). */
export type ProposeInput = {
  action: "set" | "clear";
  namespace: string;
  name: string;
  /** The new holder's bus name (set only). */
  agent: string | null;
};

/** The ids an audit row may carry (never names): services/bus.ts audits them. */
export type ProposalAudit = {
  proposalId: string;
  action: BusRoleProposalAction;
  roleId: string | null;
  agentId: string | null;
  priorAgentId: string | null;
};

export type ProposeResult =
  | { ok: true; proposal: BusRoleProposal; expired: ProposalAudit[] }
  | (RoleRefusal & { expired: ProposalAudit[] })
  | {
      ok: false;
      reason: "no_role" | "unchanged" | "ambiguous" | "proposal_limit";
      expired: ProposalAudit[];
    };

/**
 * Why a confirm or view can't apply: `unknown` (no proposal has that link
 * in this hub), `used` (already decided), `expired`, `changed` (the role
 * moved since it was proposed), or putRole's refusal.
 */
export type ProposalRefusalReason =
  | "unknown"
  | "used"
  | "expired"
  | "changed"
  | "invalid"
  | "name_taken"
  | "agent_not_open"
  | "role_limit";

export type ViewResult =
  | { ok: true; proposal: BusRoleProposal; expired: ProposalAudit[] }
  | {
      ok: false;
      reason: ProposalRefusalReason;
      proposal: BusRoleProposal | null;
      expired: ProposalAudit[];
    };

export type DecideResult =
  | {
      ok: true;
      proposal: BusRoleProposal;
      /** The role as set (set, repoint); null after a clear. */
      role: BusRole | null;
      audit: ProposalAudit;
      expired: ProposalAudit[];
    }
  | {
      ok: false;
      reason: ProposalRefusalReason | "rejected";
      proposal: BusRoleProposal | null;
      /** Present when this call decided the proposal (refused): audit it. */
      audit: ProposalAudit | null;
      expired: ProposalAudit[];
    };

type StoredProposal = {
  id: string;
  tokenHash: string;
  action: BusRoleProposalAction;
  namespace: string;
  name: string;
  lname: string;
  roleId: string | null;
  agentId: string | null;
  agentName: string | null;
  priorAgentId: string | null;
  priorHolderName: string | null;
  createdAt: number;
  expiresAt: number;
  status: BusRoleProposal["status"];
  reason: string | null;
  decidedAt: number | null;
};

const PROPOSAL_SELECT = `select p.id, p.token_hash as tokenHash, p.action, p.namespace, p.name, p.lname,
    p.role_id as roleId, p.agent_id as agentId, a.name as agentName,
    p.prior_agent_id as priorAgentId, h.name as priorHolderName,
    p.created_at as createdAt, p.expires_at as expiresAt, p.status, p.reason,
    p.decided_at as decidedAt
  from role_proposals p
  left join agents a on a.id = p.agent_id
  left join agents h on h.id = p.prior_agent_id`;

const proposalDto = (p: StoredProposal): BusRoleProposal => ({
  id: p.id,
  action: p.action,
  namespace: p.namespace,
  name: p.name,
  roleId: p.roleId,
  agentId: p.agentId,
  agentName: p.agentName,
  priorAgentId: p.priorAgentId,
  priorHolderName: p.priorHolderName,
  status: p.status,
  reason: p.reason,
  createdAt: iso(p.createdAt),
  expiresAt: iso(p.expiresAt),
  decidedAt: p.decidedAt === null ? null : iso(p.decidedAt),
});

const auditOf = (p: {
  id: string;
  action: BusRoleProposalAction;
  roleId: string | null;
  agentId: string | null;
  priorAgentId: string | null;
}): ProposalAudit => ({
  proposalId: p.id,
  action: p.action,
  roleId: p.roleId,
  agentId: p.agentId,
  priorAgentId: p.priorAgentId,
});

const byHash = (sql: SqlStorage, orgId: string, hash: string) =>
  one<StoredProposal>(
    sql,
    `${PROPOSAL_SELECT} where p.org_id = ? and p.token_hash = ?`,
    orgId,
    hash,
  );

/**
 * Marks every pending proposal past its expiry `expired`, and drops decided
 * ones past retention. Returns the newly expired, for their audit rows.
 */
export function expireProposals(
  sql: SqlStorage,
  orgId: string,
  now: number,
): ProposalAudit[] {
  const gone = all<{
    id: string;
    action: BusRoleProposalAction;
    roleId: string | null;
    agentId: string | null;
    priorAgentId: string | null;
  }>(
    sql,
    `update role_proposals set status = 'expired', decided_at = ?
      where org_id = ? and status = 'pending' and expires_at <= ?
      returning id, action, role_id as roleId, agent_id as agentId, prior_agent_id as priorAgentId`,
    now,
    orgId,
    now,
  ).map(auditOf);
  sql.exec(
    `delete from role_proposals where org_id = ? and status != 'pending'
       and (decided_at < ? or id not in (select id from role_proposals
         where org_id = ? and status != 'pending' order by created_at desc limit ?))`,
    orgId,
    now - RETAIN_MS,
    orgId,
    RETAIN_MAX,
  );
  return gone;
}

/** The newest proposals (pending or decided), newest first, for GET R.busRoles. */
export function listProposals(
  sql: SqlStorage,
  orgId: string,
): BusRoleProposal[] {
  return all<StoredProposal>(
    sql,
    `${PROPOSAL_SELECT} where p.org_id = ? order by p.created_at desc, p.rowid desc limit ?`,
    orgId,
    BUS_ROLE_PROPOSALS_LISTED,
  ).map(proposalDto);
}

/**
 * Records a proposal under `tokenHash` (the sha256 of its link's secret,
 * minted by the Worker). Refused with putRole's reasons (the same checks,
 * as a dry run: checkRole), or: `agent_not_open` (no open agent of this hub
 * has that name in the namespace), `ambiguous` (two do), `no_role` (clear
 * of a role that doesn't exist), `unchanged` (the role already points
 * there), `proposal_limit` (BUS_ROLE_PROPOSALS_PENDING_MAX pending).
 */
export function propose(
  sql: SqlStorage,
  orgId: string,
  input: ProposeInput,
  tokenHash: string,
  now: number,
  newId: () => string,
  maxRoles: number = BUS_ROLE_MAX,
): ProposeResult {
  const expired = expireProposals(sql, orgId, now);
  const lname = input.name.toLowerCase();
  let action: BusRoleProposalAction;
  let roleId: string | null;
  let agentId: string | null = null;
  let priorAgentId: string | null;
  if (input.action === "clear") {
    // The name rules first, as putRole's, so a bad name is `invalid`.
    const c = checkRole(sql, orgId, input.namespace, input.name, null, now);
    if (!c.ok && c.reason === "invalid") return { ...c, expired };
    const role = one<{ id: string; agentId: string | null }>(
      sql,
      "select id, agent_id as agentId from roles where org_id = ? and namespace = ? and lname = ?",
      orgId,
      input.namespace,
      lname,
    );
    if (role === null) return { ok: false, reason: "no_role", expired };
    action = "clear";
    roleId = role.id;
    priorAgentId = role.agentId;
  } else {
    const named = all<{ id: string }>(
      sql,
      `select id from agents where org_id = ? and lower(name) = ? and live = 1
         and (namespace = ? or global = 1) limit 2`,
      orgId,
      (input.agent ?? "").toLowerCase(),
      input.namespace,
    );
    if (named.length > 1) return { ok: false, reason: "ambiguous", expired };
    // No such open agent: checkRole answers agent_not_open (or invalid first).
    agentId = named[0]?.id ?? "";
    const c = checkRole(
      sql,
      orgId,
      input.namespace,
      input.name,
      agentId,
      now,
      maxRoles,
    );
    if (!c.ok) return { ...c, expired };
    if (c.existing !== null && c.existing.agentId === agentId)
      return { ok: false, reason: "unchanged", expired };
    action = c.existing === null ? "set" : "repoint";
    roleId = c.existing?.id ?? null;
    priorAgentId = c.existing?.agentId ?? null;
  }
  const pending =
    one<{ n: number }>(
      sql,
      "select count(*) as n from role_proposals where org_id = ? and status = 'pending'",
      orgId,
    )?.n ?? 0;
  if (pending >= BUS_ROLE_PROPOSALS_PENDING_MAX)
    return { ok: false, reason: "proposal_limit", expired };
  const id = newId();
  sql.exec(
    `insert into role_proposals (id, org_id, token_hash, action, namespace, name, lname,
       role_id, agent_id, prior_agent_id, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    orgId,
    tokenHash,
    action,
    input.namespace,
    input.name,
    lname,
    roleId,
    agentId,
    priorAgentId,
    now,
    now + BUS_ROLE_PROPOSAL_TTL_MS,
  );
  const row = byHash(sql, orgId, tokenHash);
  if (row === null) throw new Error("proposal row missing after write");
  return { ok: true, proposal: proposalDto(row), expired };
}

/**
 * Whether pending proposal `p` would apply now: null when yes, else why
 * not. The binding: the role is still as proposed (set: no such role;
 * repoint and clear: the same role, still on the same holder), then for
 * set and repoint putRole's own checks (checkRole).
 */
function blocker(
  sql: SqlStorage,
  orgId: string,
  p: StoredProposal,
  now: number,
  maxRoles: number,
): ProposalRefusalReason | null {
  const role = one<{ id: string; agentId: string | null }>(
    sql,
    "select id, agent_id as agentId from roles where org_id = ? and namespace = ? and lname = ?",
    orgId,
    p.namespace,
    p.lname,
  );
  const same =
    p.action === "set"
      ? role === null
      : role !== null &&
        role.id === p.roleId &&
        role.agentId === p.priorAgentId;
  if (!same) return "changed";
  if (p.action === "clear") return null;
  const c = checkRole(
    sql,
    orgId,
    p.namespace,
    p.name,
    p.agentId,
    now,
    maxRoles,
  );
  return c.ok ? null : c.reason;
}

/**
 * The proposal behind `tokenHash`, for the confirm page: ok while it is
 * pending and would apply now; else why not (nothing is decided here,
 * except expiry).
 */
export function viewProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  now: number,
  maxRoles: number = BUS_ROLE_MAX,
): ViewResult {
  const expired = expireProposals(sql, orgId, now);
  const p = byHash(sql, orgId, tokenHash);
  if (p === null)
    return { ok: false, reason: "unknown", proposal: null, expired };
  const dto = proposalDto(p);
  if (p.status !== "pending")
    return {
      ok: false,
      reason: p.status === "expired" ? "expired" : "used",
      proposal: dto,
      expired,
    };
  const why = blocker(sql, orgId, p, now, maxRoles);
  return why === null
    ? { ok: true, proposal: dto, expired }
    : { ok: false, reason: why, proposal: dto, expired };
}

/**
 * Decides the proposal behind `tokenHash`, once. "confirm": applies it while
 * it is pending, unexpired and the role is still as proposed (blocker),
 * through putRole or deleteRole, then marks it applied; a blocker marks it
 * refused with that reason. "reject": marks it refused (`rejected`). One
 * synchronous run in the hub: no other call interleaves, so a link applies
 * at most once.
 */
export function decideProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  decision: "confirm" | "reject",
  now: number,
  newId: () => string,
  maxRoles: number = BUS_ROLE_MAX,
): DecideResult {
  const expired = expireProposals(sql, orgId, now);
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
      proposal: proposalDto(p),
      audit: null,
      expired,
    };
  const settle = (status: "applied" | "refused", reason: string | null) => {
    sql.exec(
      "update role_proposals set status = ?, reason = ?, decided_at = ? where id = ? and status = 'pending'",
      status,
      reason,
      now,
      p.id,
    );
    const row = byHash(sql, orgId, tokenHash);
    if (row === null) throw new Error("proposal row missing after write");
    return proposalDto(row);
  };
  const refuse = (
    reason: ProposalRefusalReason | "rejected",
  ): DecideResult => ({
    ok: false,
    reason,
    proposal: settle("refused", reason),
    audit: auditOf(p),
    expired,
  });
  if (decision === "reject") return refuse("rejected");
  const why = blocker(sql, orgId, p, now, maxRoles);
  if (why !== null) return refuse(why);
  let role: BusRole | null = null;
  if (p.action === "clear") {
    if (p.roleId === null) throw new Error("clear proposal without a role id");
    deleteRole(sql, orgId, p.roleId);
  } else {
    const r = putRole(
      sql,
      orgId,
      p.namespace,
      p.name,
      p.agentId,
      now,
      newId,
      maxRoles,
    );
    if (!r.ok) return refuse(r.reason);
    role = r.role;
  }
  return {
    ok: true,
    proposal: settle("applied", null),
    role,
    audit: auditOf(p),
    expired,
  };
}

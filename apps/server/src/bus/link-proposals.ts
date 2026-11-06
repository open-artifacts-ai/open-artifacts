// Link proposals (#1567): `oa-bus link <dir> <dir>` on a machine proposes a
// link (or an unlink) between two namespaces. A machine token alone must
// never mint reach, so the CLI only records a proposal here; the member
// confirms it in a browser on the proposal's one-time link
// (bus/link-confirm.ts), the same flow as role proposals (#1372). This is
// the hub's side, run by BusHub's Worker-only RPC methods.
//
// A proposal is bound to the pair the member will see. It is decided once:
// applied, refused or expired. Confirming a link that already exists, or an
// unlink of one that doesn't, applies as a no-op (`noop`), with a clear page.

import { WireNamespaceSchema } from "@oa/bus-protocol";
import {
  BUS_LINK_MAX,
  BUS_LINK_PROPOSAL_TTL_MS,
  BUS_LINK_PROPOSALS_PENDING_MAX,
  BUS_LINK_PROPOSALS_PER_MACHINE_HOUR,
  BUS_LINKS_PER_NAMESPACE,
} from "@oa/shared";
import { addLink, removeLink } from "./links.js";

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

export type LinkProposalAction = "link" | "unlink";

/** What a decided or viewed proposal shows: the pair (sorted) and its action. */
export type LinkProposalView = {
  id: string;
  action: LinkProposalAction;
  a: string;
  b: string;
  expiresAt: number;
  status: "pending" | "applied" | "refused" | "expired";
  reason: string | null;
};

export type LinkProposeResult =
  | { ok: true; proposal: LinkProposalView }
  | { ok: false; reason: "invalid"; field: "a" | "b" | "namespaces" }
  | { ok: false; reason: "rate_limited" | "proposal_limit" };

export type LinkRefusalReason =
  | "unknown"
  | "used"
  | "expired"
  | "link_limit"
  | "rejected";

export type LinkViewResult =
  | { ok: true; proposal: LinkProposalView; noop: boolean }
  | { ok: false; reason: LinkRefusalReason; proposal: LinkProposalView | null };

export type LinkDecideResult =
  | { ok: true; proposal: LinkProposalView; noop: boolean }
  | { ok: false; reason: LinkRefusalReason; proposal: LinkProposalView | null };

const SELECT = `select id, action, ns_a as a, ns_b as b, expires_at as expiresAt, status, reason
  from link_proposals`;

const byHash = (sql: SqlStorage, orgId: string, hash: string) =>
  one<LinkProposalView>(
    sql,
    `${SELECT} where org_id = ? and token_hash = ?`,
    orgId,
    hash,
  );

/** Marks overdue pending proposals expired and drops decided ones past retention. */
export function expireLinkProposals(
  sql: SqlStorage,
  orgId: string,
  now: number,
): void {
  sql.exec(
    "update link_proposals set status = 'expired', decided_at = ? where org_id = ? and status = 'pending' and expires_at <= ?",
    now,
    orgId,
    now,
  );
  sql.exec(
    "delete from link_proposals where org_id = ? and status != 'pending' and decided_at < ?",
    orgId,
    now - RETAIN_MS,
  );
}

const linkIdOf = (sql: SqlStorage, orgId: string, a: string, b: string) =>
  one<{ id: string }>(
    sql,
    "select id from grants where org_id = ? and kind = 'link' and ns_a = ? and ns_b = ?",
    orgId,
    a,
    b,
  )?.id ?? null;

/**
 * Records a proposal for `machineId` under `tokenHash` (the sha256 of the
 * confirm link's secret, minted by the Worker). Changes no link. Refused:
 * `invalid` (a namespace not canonical, or the same one twice),
 * `proposal_limit` (BUS_LINK_PROPOSALS_PENDING_MAX waiting), `rate_limited`
 * (this machine already made BUS_LINK_PROPOSALS_PER_MACHINE_HOUR in the last hour).
 */
export function proposeLink(
  sql: SqlStorage,
  orgId: string,
  input: { action: LinkProposalAction; a: string; b: string },
  machineId: string,
  tokenHash: string,
  now: number,
  newId: () => string,
): LinkProposeResult {
  if (!WireNamespaceSchema.safeParse(input.a).success)
    return { ok: false, reason: "invalid", field: "a" };
  if (!WireNamespaceSchema.safeParse(input.b).success)
    return { ok: false, reason: "invalid", field: "b" };
  if (input.a === input.b)
    return { ok: false, reason: "invalid", field: "namespaces" };
  expireLinkProposals(sql, orgId, now);
  const recent =
    one<{ n: number }>(
      sql,
      "select count(*) as n from link_proposals where org_id = ? and machine_id = ? and created_at > ?",
      orgId,
      machineId,
      now - HOUR_MS,
    )?.n ?? 0;
  if (recent >= BUS_LINK_PROPOSALS_PER_MACHINE_HOUR)
    return { ok: false, reason: "rate_limited" };
  const pending =
    one<{ n: number }>(
      sql,
      "select count(*) as n from link_proposals where org_id = ? and status = 'pending'",
      orgId,
    )?.n ?? 0;
  if (pending >= BUS_LINK_PROPOSALS_PENDING_MAX)
    return { ok: false, reason: "proposal_limit" };
  const [x, y] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  sql.exec(
    `insert into link_proposals (id, org_id, token_hash, action, ns_a, ns_b, machine_id, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    orgId,
    tokenHash,
    input.action,
    x,
    y,
    machineId,
    now,
    now + BUS_LINK_PROPOSAL_TTL_MS,
  );
  const row = byHash(sql, orgId, tokenHash);
  if (row === null) throw new Error("link proposal row missing after write");
  return { ok: true, proposal: row };
}

/** Whether applying `p` now changes nothing: a link that exists, an unlink of one that doesn't. */
const isNoop = (sql: SqlStorage, orgId: string, p: LinkProposalView) =>
  (linkIdOf(sql, orgId, p.a, p.b) !== null) === (p.action === "link");

/** The proposal behind `tokenHash`, for the confirm page; decides nothing but expiry. */
export function viewLinkProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  now: number,
): LinkViewResult {
  expireLinkProposals(sql, orgId, now);
  const p = byHash(sql, orgId, tokenHash);
  if (p === null) return { ok: false, reason: "unknown", proposal: null };
  if (p.status !== "pending")
    return {
      ok: false,
      reason: p.status === "expired" ? "expired" : "used",
      proposal: p,
    };
  return { ok: true, proposal: p, noop: isNoop(sql, orgId, p) };
}

/**
 * Decides the proposal behind `tokenHash`, once. "confirm" applies it through
 * addLink or removeLink (the same functions as the member's REST, with the
 * same limits); "reject" refuses it. One synchronous run in the hub, so a
 * link applies at most once.
 */
export function decideLinkProposal(
  sql: SqlStorage,
  orgId: string,
  tokenHash: string,
  decision: "confirm" | "reject",
  now: number,
  newId: () => string,
  maxLinks = BUS_LINK_MAX,
  perNamespace = BUS_LINKS_PER_NAMESPACE,
): LinkDecideResult & { changed?: { a: string; b: string } } {
  expireLinkProposals(sql, orgId, now);
  const p = byHash(sql, orgId, tokenHash);
  if (p === null) return { ok: false, reason: "unknown", proposal: null };
  if (p.status !== "pending")
    return {
      ok: false,
      reason: p.status === "expired" ? "expired" : "used",
      proposal: p,
    };
  const settle = (status: "applied" | "refused", reason: string | null) => {
    sql.exec(
      "update link_proposals set status = ?, reason = ?, decided_at = ? where id = ? and status = 'pending'",
      status,
      reason,
      now,
      p.id,
    );
    return byHash(sql, orgId, tokenHash) ?? p;
  };
  const refuse = (reason: LinkRefusalReason): LinkDecideResult => ({
    ok: false,
    reason,
    proposal: settle("refused", reason),
  });
  if (decision === "reject") return refuse("rejected");
  const noop = isNoop(sql, orgId, p);
  if (!noop) {
    if (p.action === "link") {
      const r = addLink(
        sql,
        orgId,
        p.a,
        p.b,
        now,
        newId,
        maxLinks,
        perNamespace,
      );
      if (!r.ok)
        return refuse(r.reason === "link_limit" ? "link_limit" : "unknown");
    } else {
      const id = linkIdOf(sql, orgId, p.a, p.b);
      if (id !== null) removeLink(sql, orgId, id);
    }
  }
  return {
    ok: true,
    proposal: settle("applied", noop ? "noop" : null),
    noop,
    ...(noop ? {} : { changed: { a: p.a, b: p.b } }),
  };
}

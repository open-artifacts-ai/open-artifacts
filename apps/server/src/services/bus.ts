import {
  BUS_ROLE_PROPOSAL_TTL_MS,
  type BusAgent,
  type BusLink,
  type BusLinkProposed,
  type BusMachine,
  type BusNotice,
  type BusReach,
  type BusReachProposed,
  type BusRole,
  type BusRoleProposal,
  type BusRoleProposeInput,
  parseFeatures,
} from "@oa/shared";
import type {
  LinkDecideResult,
  LinkProposalAction,
  LinkProposeResult,
  LinkViewResult,
} from "../bus/link-proposals.js";
import type { PutReachResult, ReachGrant } from "../bus/reach.js";
import type {
  ReachAudit,
  ReachDecideResult,
  ReachProposeResult,
  ReachViewResult,
} from "../bus/reach-proposals.js";
import type {
  DecideResult,
  ProposalAudit,
  ProposeInput,
  ProposeResult,
  ViewResult,
} from "../bus/role-proposals.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { logError } from "../log.js";
import { lookupUserGrant } from "../mcp/oauth-api.js";
import { b64urlEncode, sha256Hex } from "../util/crypto.js";
import { type Via, viaKey } from "./agent-usage.js";
import { type AuditActor, audit, userActor } from "./audit.js";
import type {
  DeliveryOutcome,
  DeliveryScope,
  NoticeDelivery,
} from "./bus-delivery.js";

// The bus's D1 side and the dashboard's reads of a member's BusHub (#1291).
// A BusHub exists only for a member with a machine that has connected at
// least once (last_used_at set at /bus/connect): every call here checks D1
// first, so a member without one never gets a DO (Decision 20).

/** How long a page or route waits for the member's BusHub before showing D1 only. */
export const BUS_HUB_TIMEOUT_MS = 2000;
/** Active (unrevoked) machines per member; equal to the list cap so every active one is listed. */
export const MAX_ACTIVE_MACHINES = 100;
const MAX_LISTED = 100;

/**
 * #1350: what a closeAll means for the member's machines. "access": a
 * transient change (a space role, a restore); the daemons reconnect within
 * seconds. "revoked": the member can no longer connect (status, role, cap,
 * erase, install suspend), so their machines never come back; the hub starts
 * their offline clock and the 24 h reap closes their agents.
 */
export type BusCloseKind = "access" | "revoked";

/**
 * revokeUserLive reasons (and closeInstall's) that leave canConnect as it
 * was: bus access is per member, never per space. Every other reason, and
 * any new one, is "revoked": fails safe toward cleanup, and harmless for a
 * transient change, since a reconnect clears the clock.
 */
const ACCESS_REASONS: ReadonlySet<string> = new Set([
  "space role lowered",
  "removed from space",
  "space mapping lowered",
  "space mapping removed",
  "every-space mapping lowered",
  "every-space mapping removed",
  "frozen edit undone",
  "artifacts transferred",
  "member restored",
  "member revived",
]);

export const busCloseKind = (reason: string): BusCloseKind =>
  ACCESS_REASONS.has(reason) ? "access" : "revoked";

/** What the Worker calls on a member's BusHub (bus/hub.ts), typed here so callers need not load the DO. */
export type BusHubRpc = {
  /** True; reads no member data and arms no alarm (the reserved ping hub). */
  ping(): Promise<true>;
  /** #1317: one server notice for one address, sent as the reserved sender; see services/bus-delivery.ts. */
  deliverNotice(notice: BusNotice): Promise<DeliveryOutcome>;
  /** The machines with a live socket now, and the open agents, in one read. */
  snapshot(): Promise<{ connected: string[]; agents: BusAgent[] }>;
  /** Closes the machine's sockets and drains its agents; false when unknown or already revoked. */
  revokeMachine(id: string): Promise<boolean>;
  /**
   * Records revokedAt, then closes every daemon socket (4403). Returns how
   * many. "revoked" also starts the offline clock (#1350); the default kind
   * is busCloseKind(reason).
   */
  closeAll(reason: string, kind?: BusCloseKind): Promise<number>;
  /** Closes every socket and deletes all of the hub's storage (erase). */
  wipe(): Promise<void>;
  /** #1296: the member's role addresses. */
  listRoles(): Promise<BusRole[]>;
  /** #1296: sets, re-points or (null) vacates a role; see bus/roles.ts putRole. */
  putRole(
    namespace: string,
    name: string,
    agentId: string | null,
  ): Promise<
    | { ok: true; role: BusRole }
    | { ok: false; reason: "invalid"; field: "namespace" | "name" }
    | { ok: false; reason: "name_taken" | "agent_not_open" | "role_limit" }
  >;
  /** #1296: removes a role; false when unknown. */
  deleteRole(id: string): Promise<boolean>;
  /** #1567: the member's links between namespaces. */
  listLinks(): Promise<BusLink[]>;
  /** #1567: links two namespaces (idempotent); see bus/links.ts addLink. */
  putLink(
    a: string,
    b: string,
  ): Promise<
    | { ok: true; link: BusLink }
    | { ok: false; reason: "invalid"; field: "a" | "b" | "namespaces" }
    | { ok: false; reason: "link_limit" }
  >;
  /** #1567: removes a link; false when unknown. */
  deleteLink(id: string): Promise<boolean>;
  /** #1346: the member's role reach grants. */
  listReach(): Promise<ReachGrant[]>;
  /** #1346: lets a role reach a namespace (idempotent); see bus/reach.ts addReach. */
  putReach(
    roleNamespace: string,
    roleName: string,
    target: string,
  ): Promise<PutReachResult>;
  /** #1346: removes a reach grant; false when unknown. */
  deleteReach(id: string): Promise<boolean>;
  /** #1346: records a reach proposal from a machine's agent under its link's hash; grants nothing. */
  proposeReach(
    input: { nativeRef: string; namespaces: string[] },
    machineId: string,
    tokenHash: string,
  ): Promise<ReachProposeResult>;
  /** #1346: the reach proposal behind a link's hash, for the confirm page. */
  viewReachProposal(tokenHash: string): Promise<ReachViewResult>;
  /** #1346: confirms (applies) or rejects the reach proposal behind a link's hash, once. */
  decideReachProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<ReachDecideResult>;
  /** #1567: records a link proposal under its link's hash; links nothing. */
  proposeLink(
    input: { action: LinkProposalAction; a: string; b: string },
    machineId: string,
    tokenHash: string,
  ): Promise<LinkProposeResult>;
  /** #1567: the link proposal behind a link's hash, for the confirm page. */
  viewLinkProposal(tokenHash: string): Promise<LinkViewResult>;
  /** #1567: confirms (applies) or rejects the proposal behind a link's hash, once. */
  decideLinkProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<LinkDecideResult>;
  /** #1372: records a role proposal under its link's hash; changes no role. */
  proposeRole(input: ProposeInput, tokenHash: string): Promise<ProposeResult>;
  /** #1372: the proposal behind a link's hash, for the confirm page. */
  viewRoleProposal(tokenHash: string): Promise<ViewResult>;
  /** #1372: confirms (applies) or rejects the proposal behind a link's hash, once. */
  decideRoleProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<DecideResult>;
  /** #1403: the credentials and machines behind the pending proposals. */
  pendingProposalSources(): Promise<{
    credentials: string[];
    machines: string[];
  }>;
  /** #1403: expires a machine's pending link and reach proposals; returns the reach ones for audit. */
  expireLinkProposalsOf(machineId: string): Promise<ReachAudit[]>;
  /** #1403: expires the pending role proposals a PAT or OAuth grant made (`t:<id>` / `g:<id>`). */
  expireRoleProposalsOf(credential: string): Promise<ProposalAudit[]>;
  /** #1372: the newest role proposals. */
  listRoleProposals(): Promise<{
    proposals: BusRoleProposal[];
    expired: ProposalAudit[];
  }>;
};

/**
 * True when the bus routes answer: BUS_HUB bound, and not a hosted install
 * (until #1299), unless the install's provisioned FEATURES carry "bus" (the
 * interim switch for staging and the red line; dropped at the gate lift).
 */
export const busOn = (
  env: Pick<Env, "BUS_HUB" | "HOSTED" | "FEATURES">,
): boolean =>
  env.BUS_HUB !== undefined &&
  (env.HOSTED !== "1" || parseFeatures(env.FEATURES).includes("bus"));

/** The member's BusHub, or null without the binding. Never call before a D1 check (see above). */
export function busHub(
  env: Pick<Env, "BUS_HUB">,
  userId: string,
): BusHubRpc | null {
  const ns = env.BUS_HUB;
  if (!ns) return null;
  return ns.get(ns.idFromName(`bus:${userId}`)) as unknown as BusHubRpc;
}

/**
 * #1299: the reserved hub the PAT-callable ping touches. Never a member's:
 * a user id is never "~ping", so `bus:${userId}` cannot equal it.
 */
export const BUS_PING_HUB_NAME = "bus:~ping";

/**
 * #1299: whether the reserved ping hub (never a member's) answers within
 * BUS_HUB_TIMEOUT_MS. Throws not_found while the bus is off.
 */
export async function busPing(env: Env): Promise<boolean> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  const ns = env.BUS_HUB;
  if (!ns) throw new ApiError("not_found", "Not found");
  const hub = ns.get(ns.idFromName(BUS_PING_HUB_NAME)) as unknown as BusHubRpc;
  return (await within(hub.ping(), BUS_HUB_TIMEOUT_MS)) === true;
}

/** `p`, or null once `ms` passes (the promise keeps running; its rejection is logged). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

type MachineDbRow = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

const MACHINES_OF = `select id, label, created_at as createdAt, last_used_at as lastUsedAt,
    revoked_at as revokedAt from bus_machines where user_id = ?1
  order by (revoked_at is null) desc, created_at desc, rowid desc limit ?2`;

const iso = (ms: number) => new Date(ms).toISOString();

/** The member's hub snapshot when one exists and answers within BUS_HUB_TIMEOUT_MS; else null. */
async function hubSnapshot(
  env: Env,
  userId: string,
  everConnected: boolean,
): Promise<{ connected: Set<string>; agents: BusAgent[] } | null> {
  if (!busOn(env) || !everConnected) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  try {
    const s = await within(hub.snapshot(), BUS_HUB_TIMEOUT_MS);
    return s && { connected: new Set(s.connected), agents: s.agents };
  } catch (e) {
    logError("bus_snapshot_failed", e);
    return null;
  }
}

export type BusView = {
  machines: BusMachine[];
  agents: BusAgent[];
  /**
   * Whether the hub's state is known. True when the hub was read, or when no
   * unrevoked machine ever connected (none can be connected: agents [] and
   * every `connected` false). False when the bus is off (unbound or hosted),
   * or when a machine has connected but the hub read failed or timed out
   * (`connected` then null for it).
   */
  live: boolean;
};

/**
 * The member's machines (D1) and agents (their BusHub, one read, at most
 * BUS_HUB_TIMEOUT_MS). Never throws on the hub side: an unbound, hosted,
 * slow or failing hub gives the D1 rows with `connected` null. A member with
 * no machine that ever connected never reaches a DO.
 */
export async function busView(env: Env, userId: string): Promise<BusView> {
  const { results } = await stmt(env.DB, MACHINES_OF)
    .bind(userId, MAX_LISTED)
    .all<MachineDbRow>();
  const snap = await hubSnapshot(
    env,
    userId,
    results.some((m) => m.lastUsedAt !== null),
  );
  const machines = results.map((m) => machineOf(m, snap?.connected ?? null));
  // Every active machine is listed (MAX_ACTIVE_MACHINES == MAX_LISTED).
  const mayBeLive = results.some(
    (m) => m.revokedAt === null && m.lastUsedAt !== null,
  );
  return {
    machines,
    agents: snap?.agents ?? [],
    live: snap !== null || (busOn(env) && !mayBeLive),
  };
}

/** A D1 row as the API shape; `connected` null when the hub wasn't read (or couldn't be) and it may be connected. */
function machineOf(m: MachineDbRow, connected: Set<string> | null): BusMachine {
  return {
    id: m.id,
    label: m.label,
    createdAt: iso(m.createdAt),
    lastUsedAt: m.lastUsedAt === null ? null : iso(m.lastUsedAt),
    revokedAt: m.revokedAt === null ? null : iso(m.revokedAt),
    connected:
      m.revokedAt !== null
        ? false
        : connected === null
          ? m.lastUsedAt === null
            ? false
            : null
          : connected.has(m.id),
  };
}

const MACHINE_OF = `select id, label, created_at as createdAt, last_used_at as lastUsedAt,
    revoked_at as revokedAt from bus_machines where id = ?1 and user_id = ?2`;

/**
 * The member's machine `id` (revoked or not) from D1 alone, or null when it
 * is unknown or another member's. No hub read: `connected` is false when it
 * can't be connected, else null.
 */
export async function busMachine(
  env: Env,
  userId: string,
  id: string,
): Promise<BusMachine | null> {
  const m = await stmt(env.DB, MACHINE_OF)
    .bind(id, userId)
    .first<MachineDbRow>();
  return m ? machineOf(m, null) : null;
}

/** The member's machines, newest active first, then revoked (at most 100). */
export async function listBusMachines(
  env: Env,
  userId: string,
): Promise<BusMachine[]> {
  return (await busView(env, userId)).machines;
}

/** The member's open agents, or [] (with live false) when the hub can't be read. */
export async function listBusAgents(
  env: Env,
  userId: string,
): Promise<{ agents: BusAgent[]; live: boolean }> {
  const v = await busView(env, userId);
  return { agents: v.agents, live: v.live };
}

const REVOKE_ONE = `update bus_machines set revoked_at = ?3
  where id = ?1 and user_id = ?2 and revoked_at is null`;
const ONE_OF = `select last_used_at as lastUsedAt, revoked_at as revokedAt
  from bus_machines where id = ?1 and user_id = ?2`;

/**
 * Revokes the member's machine `id` (D1, so its token is refused at once),
 * then closes its sockets on their BusHub. Idempotent: an already revoked
 * machine of theirs is closed again and resolves true. False (the route's
 * 404) when the id is unknown or another member's. Throws 503
 * revoke_not_closed when the hub could not close the sockets (the token is
 * already refused): retrying is safe.
 */
export async function revokeBusMachine(
  env: Env,
  userId: string,
  id: string,
): Promise<boolean> {
  const [, row] = await env.DB.batch([
    stmt(env.DB, REVOKE_ONE).bind(id, userId, Date.now()),
    stmt(env.DB, ONE_OF).bind(id, userId),
  ]);
  const m = row?.results[0] as
    | { lastUsedAt: number | null; revokedAt: number | null }
    | undefined;
  if (!m) return false;
  // Never connected: no hub holds a socket for it (and none is created).
  if (m.lastUsedAt === null) return true;
  const hub = busHub(env, userId);
  if (!hub) return true;
  try {
    const done = await within(hub.revokeMachine(id), BUS_HUB_TIMEOUT_MS * 5);
    if (done === null) throw new Error("bus hub timed out");
  } catch (e) {
    logError("bus_revoke_close_failed", e);
    throw new ApiError(
      "revoke_not_closed",
      "The machine is revoked, but its connection could not be closed yet. Try again.",
    );
  }
  return true;
}

/** Whether `userId` has a machine that ever connected (so a BusHub may exist). */
export async function hasConnectedMachine(
  env: Pick<Env, "DB">,
  userId: string,
): Promise<boolean> {
  const r = await stmt(
    env.DB,
    "select 1 as x from bus_machines where user_id = ?1 and last_used_at is not null limit 1",
  )
    .bind(userId)
    .first<{ x: number }>();
  return r !== null;
}

/**
 * #1317: the Worker's NoticeDelivery: carries one notice to the member's
 * BusHub. "dropped" without touching a hub when the bus is off, the member
 * has no machine that ever connected (so no hub is created for them), the
 * hub is slow (BUS_HUB_TIMEOUT_MS) or it fails. A plan cap (#1299) does not
 * stop it: capped members' machines keep receiving; a suspended member's
 * machines cannot connect, so their notices wait out the hold and expire.
 */
export const hubNoticeDelivery: NoticeDelivery = {
  async deliver(env, userId, notice, scope?: DeliveryScope) {
    if (!busOn(env)) return "dropped";
    let has = scope?.hasBus.get(userId);
    if (!has) {
      has = hasConnectedMachine(env, userId);
      scope?.hasBus.set(userId, has);
    }
    if (!(await has)) return "dropped";
    const hub = busHub(env, userId);
    if (!hub) return "dropped";
    try {
      return (
        (await within(hub.deliverNotice(notice), BUS_HUB_TIMEOUT_MS)) ??
        "dropped"
      );
    } catch (e) {
      logError("bus_notice_failed", e);
      return "dropped";
    }
  },
};

/**
 * Erase (#1204): deletes everything the member's BusHub holds (machine
 * labels, agents, mail). Only when one may exist (a machine that ever
 * connected; erase keeps those rows, emptied). Throws on failure, so the
 * erase call fails and its retry wipes again.
 */
export async function wipeUserBus(
  env: Pick<Env, "DB" | "BUS_HUB">,
  userId: string,
): Promise<void> {
  if (!env.BUS_HUB) return;
  if (!(await hasConnectedMachine(env, userId))) return;
  await busHub(env, userId)?.wipe();
}

/**
 * Closes every bus socket `userId` holds (UserPresence.closeAll calls this,
 * so it runs wherever a user's live access is revoked: status, role,
 * restriction, space or erase). No BusHub is touched for a member without a
 * machine that ever connected. Throws when the hub call fails, so the
 * caller's retry runs.
 */
export async function closeUserBus(
  env: Pick<Env, "DB" | "BUS_HUB">,
  userId: string,
  reason: string,
): Promise<number> {
  if (!env.BUS_HUB) return 0;
  if (!(await hasConnectedMachine(env, userId))) return 0;
  return (
    (await busHub(env, userId)?.closeAll(reason, busCloseKind(reason))) ?? 0
  );
}

// ------------------------------------------------------------ role addresses

/** Why a role write was refused (#1296): the 409's details.reason. */
export type RoleRefusal =
  | "name_taken"
  | "agent_not_open"
  | "role_limit"
  | "no_bus";

const ROLE_REFUSALS: Record<RoleRefusal, string> = {
  name_taken: "An agent or a reserved name already uses that name there",
  agent_not_open: "No open agent with that id in that namespace",
  role_limit: "Too many role addresses",
  no_bus: "Connect a machine to the bus first",
};

/** A hub call for a role write: ApiError internal when it fails or times out (retrying is safe). */
async function roleCall<T>(p: Promise<T>): Promise<T> {
  try {
    const r = await within(p, BUS_HUB_TIMEOUT_MS * 5);
    if (r === null) throw new Error("bus hub timed out");
    return r;
  } catch (e) {
    logError("bus_role_failed", e);
    throw new ApiError("internal", "The bus could not be reached. Try again.");
  }
}

/**
 * #1296: the member's role addresses, or [] with live false when the hub
 * can't be read in BUS_HUB_TIMEOUT_MS (or none can exist yet: no machine
 * ever connected, Decision 20).
 */
export async function listBusRoles(
  env: Env,
  userId: string,
): Promise<{ roles: BusRole[]; proposals: BusRoleProposal[]; live: boolean }> {
  const none = { roles: [], proposals: [], live: false };
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return none;
  const hub = busHub(env, userId);
  if (!hub) return none;
  try {
    const r = await within(
      Promise.all([hub.listRoles(), hub.listRoleProposals()]),
      BUS_HUB_TIMEOUT_MS,
    );
    if (r === null) return none;
    const [roles, { proposals, expired }] = r;
    await auditExpired(env, userId, expired);
    return { roles, proposals, live: true };
  } catch (e) {
    logError("bus_roles_failed", e);
    return none;
  }
}

/**
 * #1296: sets, re-points or (agentId null) vacates the member's role. The
 * route validated the body; the hub checks again. 409 conflict with details
 * { reason } on a refusal; `no_bus` before any machine connected (no BusHub
 * is created for it). 404 while the bus is off.
 */
export async function putBusRole(
  env: Env,
  userId: string,
  namespace: string,
  name: string,
  agentId: string | null,
): Promise<BusRole> {
  const refuse = (reason: RoleRefusal) =>
    new ApiError("conflict", ROLE_REFUSALS[reason], { reason });
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) throw refuse("no_bus");
  const hub = busHub(env, userId);
  if (!hub) throw refuse("no_bus");
  const r = await roleCall(hub.putRole(namespace, name, agentId));
  if (r.ok) return r.role;
  if (r.reason === "invalid")
    throw new ApiError("bad_request", `Invalid ${r.field}`, {
      field: r.field,
    });
  throw refuse(r.reason);
}

/** #1296: removes the member's role `id`. Idempotent: unknown is fine. */
export async function deleteBusRole(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) return;
  const hub = busHub(env, userId);
  if (!hub) return;
  await roleCall(hub.deleteRole(id));
}

// ------------------------------------------------------- project links

/** Why a link write was refused (#1567): the 409's details.reason. */
export type LinkRefusal = "link_limit" | "no_bus";

const LINK_REFUSALS: Record<LinkRefusal, string> = {
  link_limit: "Too many links",
  no_bus: "Connect a machine to the bus first",
};

/** A hub call for a link write: ApiError internal when it fails or times out (retrying is safe). */
async function linkCall<T>(p: Promise<T>): Promise<T> {
  try {
    const r = await within(p, BUS_HUB_TIMEOUT_MS * 5);
    if (r === null) throw new Error("bus hub timed out");
    return r;
  } catch (e) {
    logError("bus_link_failed", e);
    throw new ApiError("internal", "The bus could not be reached. Try again.");
  }
}

/** #1567: the member's links, or [] with live false when the hub can't be read (or none can exist yet). */
export async function listBusLinks(
  env: Env,
  userId: string,
): Promise<{ links: BusLink[]; live: boolean }> {
  const none = { links: [], live: false };
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return none;
  const hub = busHub(env, userId);
  if (!hub) return none;
  try {
    const links = await within(hub.listLinks(), BUS_HUB_TIMEOUT_MS);
    return links === null ? none : { links, live: true };
  } catch (e) {
    logError("bus_links_failed", e);
    return none;
  }
}

/**
 * #1567: links two namespaces. The route validated the body; the hub checks
 * again. 409 conflict with details { reason } on a refusal; `no_bus` before
 * any machine connected (no BusHub is created for it).
 */
export async function putBusLink(
  env: Env,
  userId: string,
  a: string,
  b: string,
): Promise<BusLink> {
  const refuse = (reason: LinkRefusal) =>
    new ApiError("conflict", LINK_REFUSALS[reason], { reason });
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) throw refuse("no_bus");
  const hub = busHub(env, userId);
  if (!hub) throw refuse("no_bus");
  const r = await linkCall(hub.putLink(a, b));
  if (r.ok) return r.link;
  if (r.reason === "invalid")
    throw new ApiError("bad_request", `Invalid ${r.field}`, {
      field: r.field,
    });
  throw refuse(r.reason);
}

/** #1567: removes the member's link `id`. Idempotent: unknown is fine. */
export async function deleteBusLink(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) return;
  const hub = busHub(env, userId);
  if (!hub) return;
  await linkCall(hub.deleteLink(id));
}

// ----------------------------------------------------------- role reach

/** Why a reach write was refused (#1346): the 409's details.reason. */
export type ReachRefusal = "role_unknown" | "reach_limit" | "no_bus";

const REACH_REFUSALS: Record<ReachRefusal, string> = {
  role_unknown: "Set the role first",
  reach_limit: "Too many reach grants",
  no_bus: "Connect a machine to the bus first",
};

const toBusReach = (g: ReachGrant): BusReach => ({
  id: g.id,
  role: { namespace: g.roleNamespace, name: g.roleName },
  namespace: g.namespace,
  createdAt: new Date(g.createdAt).toISOString(),
});

/** A hub call for a reach write: ApiError internal when it fails or times out (retrying is safe). */
async function reachCall<T>(p: Promise<T>): Promise<T> {
  try {
    const r = await within(p, BUS_HUB_TIMEOUT_MS * 5);
    if (r === null) throw new Error("bus hub timed out");
    return r;
  } catch (e) {
    logError("bus_reach_failed", e);
    throw new ApiError("internal", "The bus could not be reached. Try again.");
  }
}

/** #1346: the member's reach grants, or [] with live false when the hub can't be read (or none can exist yet). */
export async function listBusReach(
  env: Env,
  userId: string,
): Promise<{ reach: BusReach[]; live: boolean }> {
  const none = { reach: [], live: false };
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return none;
  const hub = busHub(env, userId);
  if (!hub) return none;
  try {
    const grants = await within(hub.listReach(), BUS_HUB_TIMEOUT_MS);
    return grants === null
      ? none
      : { reach: grants.map(toBusReach), live: true };
  } catch (e) {
    logError("bus_reach_list_failed", e);
    return none;
  }
}

/**
 * #1346: lets the role (`roleNamespace`, `roleName`) reach `target`. The
 * route validated the body; the hub checks again. 409 conflict with details
 * { reason } on a refusal; `no_bus` before any machine connected (no BusHub
 * is created for it).
 */
export async function putBusReach(
  env: Env,
  userId: string,
  roleNamespace: string,
  roleName: string,
  target: string,
): Promise<BusReach> {
  const refuse = (reason: ReachRefusal) =>
    new ApiError("conflict", REACH_REFUSALS[reason], { reason });
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) throw refuse("no_bus");
  const hub = busHub(env, userId);
  if (!hub) throw refuse("no_bus");
  const r = await reachCall(hub.putReach(roleNamespace, roleName, target));
  if (r.ok) return toBusReach(r.grant);
  if (r.reason === "invalid")
    throw new ApiError("bad_request", `Invalid ${r.field}`, {
      field: r.field,
    });
  throw refuse(r.reason);
}

/** #1346: removes the member's reach grant `id`. Idempotent: unknown is fine. */
export async function deleteBusReach(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  if (!(await hasConnectedMachine(env, userId))) return;
  const hub = busHub(env, userId);
  if (!hub) return;
  await reachCall(hub.deleteReach(id));
}

/** The link confirm page's path; the URL is `<origin>${LINK_CONFIRM_PATH}#<secret>` (the fragment never reaches a server or a log, #1426). */
export const LINK_CONFIRM_PATH = "/bus/links/confirm";

const LINK_PROPOSAL_REFUSALS = {
  rate_limited: "This machine made too many link proposals. Try again later",
  proposal_limit:
    "Too many link changes are waiting for the member. Confirm or let them expire first",
  no_bus: "Connect a machine to the bus first",
} as const;

/**
 * The machine-token route's proposal (#1567): records a link or unlink in
 * the member's own hub and returns its one-time confirm URL (the only copy
 * of the secret; the hub keeps its sha256). Links nothing. 400 bad_request
 * (a namespace), 409 conflict with details { reason }.
 */
export async function proposeBusLink(
  env: Env,
  userId: string,
  machineId: string,
  input: { action: LinkProposalAction; a: string; b: string },
): Promise<BusLinkProposed> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  const refuse = (reason: keyof typeof LINK_PROPOSAL_REFUSALS) =>
    new ApiError("conflict", LINK_PROPOSAL_REFUSALS[reason], { reason });
  if (!(await hasConnectedMachine(env, userId))) throw refuse("no_bus");
  const hub = busHub(env, userId);
  if (!hub) throw refuse("no_bus");
  const secret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const r = await linkCall(
    hub.proposeLink(input, machineId, await sha256Hex(secret)),
  );
  if (!r.ok) {
    if (r.reason === "invalid")
      throw new ApiError("bad_request", `Invalid ${r.field}`, {
        field: r.field,
      });
    throw refuse(r.reason);
  }
  return {
    confirmUrl: `${appOrigin(env)}${LINK_CONFIRM_PATH}#${secret}`,
    expiresAt: new Date(r.proposal.expiresAt).toISOString(),
  };
}

/** The link confirm page's read of the proposal behind `secret`, in the member's own hub only. null without a hub. */
export async function viewBusLinkProposal(
  env: Env,
  userId: string,
  secret: string,
): Promise<LinkViewResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  return linkCall(hub.viewLinkProposal(await sha256Hex(secret)));
}

/** The link confirm page's POST: decides the proposal behind `secret`, once. null without a hub. */
export async function decideBusLinkProposal(
  env: Env,
  userId: string,
  secret: string,
  decision: "confirm" | "reject",
): Promise<LinkDecideResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  return linkCall(hub.decideLinkProposal(await sha256Hex(secret), decision));
}

// ---------------------------------------------------------- role proposals
//
// #1372, the user's guardrail ("Let's do B", then "1, propose via MCP, I
// confirm by link"): an AI agent proposes a role change over MCP
// (bus_role_propose); nothing changes until the member confirms it on a
// one-time link in a browser (bus/role-confirm.ts). Every proposal and
// decision, and each expiry the hub notices, is an audit row (ids and enums
// only: never the role name, the namespace or the link).

/** The confirm page's path; the link is `<origin>${ROLE_CONFIRM_PATH}#<secret>` (the fragment never reaches a server or a log, #1426). */
export const ROLE_CONFIRM_PATH = "/bus/roles/confirm";
/** A link's secret: 32 random bytes, base64url (43 characters). */
export const ROLE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Why a proposal was refused at propose time: the tool's `conflict` details.reason. */
export type ProposalRefusal =
  | RoleRefusal
  | "no_role"
  | "unchanged"
  | "ambiguous"
  | "proposal_limit";

const PROPOSAL_REFUSALS: Record<
  Exclude<ProposalRefusal, RoleRefusal>,
  string
> = {
  no_role: "There is no role with that name in that namespace",
  unchanged: "The role already points at that agent",
  ambiguous: "More than one open agent has that name there",
  proposal_limit:
    "Too many role changes are waiting for the member. Ask them to confirm or let them expire first",
};

const auditTarget = (userId: string) => ({ type: "user" as const, id: userId });

/** An audit row's detail: ids and enums, the absent ones left out. */
const detailOf = (a: ProposalAudit, why?: string) => ({
  proposalId: a.proposalId,
  action: a.action,
  ...(a.roleId ? { roleId: a.roleId } : {}),
  ...(a.agentId ? { agentId: a.agentId } : {}),
  ...(a.priorAgentId ? { priorAgentId: a.priorAgentId } : {}),
  ...(why ? { why } : {}),
});

/** A reach audit row's detail: ids and enums only (never the role name or a namespace). */
const reachDetailOf = (a: ReachAudit, why?: string) => ({
  proposalId: a.proposalId,
  roleId: a.roleId,
  agentId: a.agentId,
  machineId: a.machineId,
  ...(why ? { why } : {}),
});

/** bus.role.expired rows for proposals the hub just found overdue (system actor). */
async function auditExpired(
  env: Env,
  userId: string,
  expired: ProposalAudit[],
): Promise<void> {
  if (expired.length === 0) return;
  const system: AuditActor = { kind: "system", id: null };
  await env.DB.batch(
    expired.map((a) =>
      audit(env, "bus.role.expired", auditTarget(userId), system, {
        detail: detailOf(a),
      }),
    ),
  );
}

/**
 * #1403: a PAT or OAuth grant was revoked: its pending role proposals expire
 * at once, each audited bus.role.expired with why `credential_revoked`. A
 * best effort after the revoke itself (which already refuses the credential):
 * a hub that can't be reached is logged, and the proposals still lapse at
 * their TTL. No hub (no machine ever connected) holds none.
 */
export async function expireBusRoleProposalsOf(
  env: Env,
  userId: string,
  via: Via,
): Promise<void> {
  try {
    if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return;
    const hub = busHub(env, userId);
    if (!hub) return;
    await expireCredential(env, userId, hub, viaKey(via));
  } catch (e) {
    logError("bus_credential_expire_failed", e);
  }
}

/** Expires `credential`'s pending role proposals in `hub` and audits each (system actor, credential_revoked). */
async function expireCredential(
  env: Env,
  userId: string,
  hub: BusHubRpc,
  credential: string,
): Promise<void> {
  const expired = await roleCall(hub.expireRoleProposalsOf(credential));
  if (expired.length === 0) return;
  const system: AuditActor = { kind: "system", id: null };
  await env.DB.batch(
    expired.map((a) =>
      audit(env, "bus.role.expired", auditTarget(userId), system, {
        detail: detailOf(a, "credential_revoked"),
      }),
    ),
  );
}

/** bus.reach.expired rows (system actor) for reach proposals the hub just expired; `why` when a revoke caused it. */
async function auditReachExpired(
  env: Env,
  userId: string,
  expired: ReachAudit[],
  why?: string,
): Promise<void> {
  if (expired.length === 0) return;
  const system: AuditActor = { kind: "system", id: null };
  await env.DB.batch(
    expired.map((a) =>
      audit(env, "bus.reach.expired", auditTarget(userId), system, {
        detail: reachDetailOf(a, why),
      }),
    ),
  );
}

/** Whether the credential (`t:<id>` PAT or `g:<id>` OAuth grant) of member `userId` is gone or revoked. */
async function credentialGone(
  env: Env,
  userId: string,
  credential: string,
): Promise<boolean> {
  const id = credential.slice(2);
  if (credential.startsWith("t:")) {
    const row = await stmt(
      env.DB,
      "select revoked_at as revokedAt from tokens where id = ?1 and user_id = ?2",
    )
      .bind(id, userId)
      .first<{ revokedAt: number | null }>();
    return row === null || row.revokedAt !== null;
  }
  if (credential.startsWith("g:"))
    return (await lookupUserGrant(env, userId, id)) === null;
  return false;
}

/**
 * #1403: before a confirm page shows or decides a proposal, expires the
 * pending ones whose proposer is gone: a PAT revoked or a grant ended, or a
 * machine revoked, by any path (a bulk revoke such as an identity reset or a
 * suspension never calls the per-credential hook, and the member may be
 * active again inside the TTL). Role expiries are audited
 * `credential_revoked`; link proposals have no audit rows yet (#1580). Fails
 * closed: an error is a 500 internal (retry is safe), never a stale link.
 */
async function sweepRevokedProposers(
  env: Env,
  userId: string,
  hub: BusHubRpc,
): Promise<void> {
  try {
    const { credentials, machines } = await hub.pendingProposalSources();
    for (const c of credentials)
      if (await credentialGone(env, userId, c))
        await expireCredential(env, userId, hub, c);
    for (const m of machines) {
      const row = await stmt(
        env.DB,
        "select revoked_at as revokedAt from bus_machines where id = ?1 and user_id = ?2",
      )
        .bind(m, userId)
        .first<{ revokedAt: number | null }>();
      if (row === null || row.revokedAt !== null)
        await auditReachExpired(
          env,
          userId,
          await hub.expireLinkProposalsOf(m),
          "machine_revoked",
        );
    }
  } catch (e) {
    logError("bus_proposal_sweep_failed", e);
    throw new ApiError("internal", "The bus could not be reached. Try again.");
  }
}

/** The member's hub for a proposal call, or a `no_bus` conflict (404 while the bus is off). */
async function proposalHub(env: Env, userId: string): Promise<BusHubRpc> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  const refuse = () =>
    new ApiError("conflict", ROLE_REFUSALS.no_bus, { reason: "no_bus" });
  if (!(await hasConnectedMachine(env, userId))) throw refuse();
  const hub = busHub(env, userId);
  if (!hub) throw refuse();
  return hub;
}

/**
 * MCP bus_role_propose: records the proposal in the member's own hub and
 * returns it with its confirm link (the only copy of the secret; the hub
 * keeps its sha256). Changes no role. Audited bus.role.proposed with the
 * request's credential (the agent's PAT or OAuth grant). Refusals: 400
 * bad_request (shape, name or namespace), 409 conflict with details
 * { reason } (RoleRefusal, no_role, unchanged, ambiguous, proposal_limit).
 */
export async function proposeBusRole(
  env: Env,
  userId: string,
  input: BusRoleProposeInput,
  /** The PAT or OAuth grant the request authenticated with (#1403): revoking it expires the proposal. */
  via?: Via,
): Promise<{ proposal: BusRoleProposal; confirmUrl: string }> {
  if (input.action === "set" && input.agent === undefined)
    throw new ApiError("bad_request", "agent is required to set a role", {
      field: "agent",
    });
  if (input.action === "clear" && input.agent !== undefined)
    throw new ApiError("bad_request", "agent is not taken to clear a role", {
      field: "agent",
    });
  const hub = await proposalHub(env, userId);
  const secret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const r = await roleCall(
    hub.proposeRole(
      {
        action: input.action,
        namespace: input.namespace,
        name: input.name,
        agent: input.agent ?? null,
        credential: via ? viaKey(via) : null,
      },
      await sha256Hex(secret),
    ),
  );
  await auditExpired(env, userId, r.expired);
  if (!r.ok) {
    if (r.reason === "invalid")
      throw new ApiError("bad_request", `Invalid ${r.field}`, {
        field: r.field,
      });
    throw new ApiError(
      "conflict",
      r.reason in ROLE_REFUSALS
        ? ROLE_REFUSALS[r.reason as RoleRefusal]
        : PROPOSAL_REFUSALS[r.reason as keyof typeof PROPOSAL_REFUSALS],
      { reason: r.reason },
    );
  }
  const p = r.proposal;
  await audit(
    env,
    "bus.role.proposed",
    auditTarget(userId),
    userActor(userId),
    {
      detail: detailOf({
        proposalId: p.id,
        action: p.action,
        roleId: p.roleId,
        agentId: p.agentId,
        priorAgentId: p.priorAgentId,
      }),
    },
  ).run();
  return {
    proposal: p,
    confirmUrl: `${appOrigin(env)}${ROLE_CONFIRM_PATH}#${secret}`,
  };
}

/** How long a confirm link works, in whole minutes (the tool's and page's copy). */
export const ROLE_PROPOSAL_TTL_MIN = Math.round(
  BUS_ROLE_PROPOSAL_TTL_MS / 60_000,
);

/**
 * The confirm page's read of the proposal behind link `secret`, in the
 * member's own hub only: another member's link is `unknown` there. null
 * when the member has no hub (nothing to confirm).
 */
export async function viewBusRoleProposal(
  env: Env,
  userId: string,
  secret: string,
): Promise<ViewResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  const r = await roleCall(hub.viewRoleProposal(await sha256Hex(secret)));
  await auditExpired(env, userId, r.expired);
  return r;
}

/**
 * The confirm page's POST: decides the proposal behind link `secret` in the
 * member's own hub, once. Audited bus.role.confirmed, or bus.role.refused
 * with `why` (a rejection, a changed role, putRole's refusal, or a link
 * already used or expired), with the request's credential: the member's
 * browser session (the page refuses every other). null without a hub.
 */
export async function decideBusRoleProposal(
  env: Env,
  userId: string,
  secret: string,
  decision: "confirm" | "reject",
): Promise<DecideResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  const r = await roleCall(
    hub.decideRoleProposal(await sha256Hex(secret), decision),
  );
  await auditExpired(env, userId, r.expired);
  const actor = userActor(userId);
  if (r.ok)
    await audit(env, "bus.role.confirmed", auditTarget(userId), actor, {
      detail: detailOf(r.audit),
    }).run();
  else if (r.proposal !== null)
    // A link already used or expired is a refusal too; an unknown one has
    // nothing to name (the page answers the same).
    await audit(env, "bus.role.refused", auditTarget(userId), actor, {
      detail: detailOf(
        r.audit ?? {
          proposalId: r.proposal.id,
          action: r.proposal.action,
          roleId: r.proposal.roleId,
          agentId: r.proposal.agentId,
          priorAgentId: r.proposal.priorAgentId,
        },
        r.reason,
      ),
    }).run();
  return r;
}

// ---------------------------------------------------------- reach proposals
//
// #1346: the agent that holds a role asks, with its machine's token, that the
// role reach other namespaces; nothing changes until the member confirms the
// one-time link in a browser (bus/reach-confirm.ts). Every proposal and
// decision, and each expiry, is an audit row (ids and enums only: never the
// role name, a namespace or the link).

/** The reach confirm page's path; the URL is `<origin>${REACH_CONFIRM_PATH}#<secret>` (the fragment never reaches a server or a log, #1426). */
export const REACH_CONFIRM_PATH = "/bus/reach/confirm";

const REACH_PROPOSAL_REFUSALS = {
  no_role:
    "This agent holds no role. Ask the person to give it a role first, then ask again",
  ambiguous:
    "This agent holds more than one role, so it is not clear which should reach",
  rate_limited: "This machine made too many reach proposals. Try again later",
  proposal_limit:
    "Too many reach changes are waiting for the member. Confirm or let them expire first",
  no_bus: "Connect a machine to the bus first",
} as const;

/**
 * The machine-token route's proposal (#1346): records a reach request for
 * the role agent `input.nativeRef` of `machineId` holds, in the member's
 * own hub, and returns its one-time confirm URL (the only copy of the
 * secret; the hub keeps its sha256). Grants nothing. Audited
 * bus.reach.proposed. 400 bad_request (a namespace), 409 conflict with
 * details { reason }.
 */
export async function proposeBusReach(
  env: Env,
  userId: string,
  machineId: string,
  input: { nativeRef: string; namespaces: string[] },
): Promise<BusReachProposed> {
  if (!busOn(env)) throw new ApiError("not_found", "Not found");
  const refuse = (reason: keyof typeof REACH_PROPOSAL_REFUSALS) =>
    new ApiError("conflict", REACH_PROPOSAL_REFUSALS[reason], { reason });
  if (!(await hasConnectedMachine(env, userId))) throw refuse("no_bus");
  const hub = busHub(env, userId);
  if (!hub) throw refuse("no_bus");
  // A revoked machine's pending proposals expire (audited) before they
  // count toward the pending limit.
  await sweepRevokedProposers(env, userId, hub);
  const secret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const r = await reachProposalCall(
    hub.proposeReach(input, machineId, await sha256Hex(secret)),
  );
  await auditReachExpired(env, userId, r.expired);
  if (!r.ok) {
    if (r.reason === "invalid")
      throw new ApiError("bad_request", `Invalid ${r.field}`, {
        field: r.field,
      });
    throw refuse(r.reason);
  }
  const p = r.proposal;
  await audit(
    env,
    "bus.reach.proposed",
    auditTarget(userId),
    userActor(userId),
    {
      detail: reachDetailOf({
        proposalId: p.id,
        roleId: p.roleId,
        agentId: p.agentId,
        machineId: p.machineId,
      }),
    },
  ).run();
  return {
    confirmUrl: `${appOrigin(env)}${REACH_CONFIRM_PATH}#${secret}`,
    expiresAt: new Date(p.expiresAt).toISOString(),
  };
}

/** A hub call for a reach proposal: ApiError internal when it fails or times out. */
async function reachProposalCall<T>(p: Promise<T>): Promise<T> {
  try {
    const r = await within(p, BUS_HUB_TIMEOUT_MS * 5);
    if (r === null) throw new Error("bus hub timed out");
    return r;
  } catch (e) {
    logError("bus_reach_proposal_failed", e);
    throw new ApiError("internal", "The bus could not be reached. Try again.");
  }
}

/** The reach confirm page's read of the proposal behind `secret`, in the member's own hub only. null without a hub. */
export async function viewBusReachProposal(
  env: Env,
  userId: string,
  secret: string,
): Promise<ReachViewResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  const r = await reachProposalCall(
    hub.viewReachProposal(await sha256Hex(secret)),
  );
  await auditReachExpired(env, userId, r.expired);
  return r;
}

/**
 * The reach confirm page's POST: decides the proposal behind `secret` in
 * the member's own hub, once. Audited bus.reach.confirmed, or
 * bus.reach.refused with `why`, with the member's browser session (the page
 * refuses every other). null without a hub.
 */
export async function decideBusReachProposal(
  env: Env,
  userId: string,
  secret: string,
  decision: "confirm" | "reject",
): Promise<ReachDecideResult | null> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId))) return null;
  const hub = busHub(env, userId);
  if (!hub) return null;
  await sweepRevokedProposers(env, userId, hub);
  const r = await reachProposalCall(
    hub.decideReachProposal(await sha256Hex(secret), decision),
  );
  const actor = userActor(userId);
  // The decision is made: an audit write that fails is logged and rethrown
  // so the page says it could not confirm, never "nothing changed".
  try {
    await auditReachExpired(env, userId, r.expired);
    await auditReachDecision(env, userId, r, actor);
  } catch (e) {
    const a = r.audit ?? r.proposal;
    logError("bus_reach_audit_failed", e, {
      proposalId: a ? ("proposalId" in a ? a.proposalId : a.id) : null,
      roleId: a?.roleId,
      machineId: a?.machineId,
    });
    throw e;
  }
  return r;
}

/** The audit row of a decided (or already-spent) reach proposal. */
async function auditReachDecision(
  env: Env,
  userId: string,
  r: ReachDecideResult,
  actor: AuditActor,
): Promise<void> {
  if (r.ok)
    await audit(env, "bus.reach.confirmed", auditTarget(userId), actor, {
      detail: reachDetailOf(r.audit),
    }).run();
  else if (r.audit !== null)
    await audit(env, "bus.reach.refused", auditTarget(userId), actor, {
      detail: reachDetailOf(r.audit, r.reason),
    }).run();
  else if (r.proposal !== null)
    // A link already used or expired is a refusal too; an unknown one has nothing to name.
    await audit(env, "bus.reach.refused", auditTarget(userId), actor, {
      detail: reachDetailOf(
        {
          proposalId: r.proposal.id,
          roleId: r.proposal.roleId,
          agentId: r.proposal.agentId,
          machineId: r.proposal.machineId,
        },
        r.reason,
      ),
    }).run();
}

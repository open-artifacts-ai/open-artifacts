import type { BusAgent, BusMachine, BusRole } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError } from "../log.js";

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
};

/** True when the bus routes answer: BUS_HUB bound, and not a hosted install (until #1299). */
export const busOn = (env: Pick<Env, "BUS_HUB" | "HOSTED">): boolean =>
  env.BUS_HUB !== undefined && env.HOSTED !== "1";

/** The member's BusHub, or null without the binding. Never call before a D1 check (see above). */
export function busHub(
  env: Pick<Env, "BUS_HUB">,
  userId: string,
): BusHubRpc | null {
  const ns = env.BUS_HUB;
  if (!ns) return null;
  return ns.get(ns.idFromName(`bus:${userId}`)) as unknown as BusHubRpc;
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
  /** False when the hub could not be read: `connected` is then null and agents []. */
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
  const machines = results.map(
    (m): BusMachine => ({
      id: m.id,
      label: m.label,
      createdAt: iso(m.createdAt),
      lastUsedAt: m.lastUsedAt === null ? null : iso(m.lastUsedAt),
      revokedAt: m.revokedAt === null ? null : iso(m.revokedAt),
      connected:
        m.revokedAt !== null
          ? false
          : snap === null
            ? m.lastUsedAt === null
              ? false
              : null
            : snap.connected.has(m.id),
    }),
  );
  return { machines, agents: snap?.agents ?? [], live: snap !== null };
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
 * 404) when the id is unknown or another member's. Throws 500 internal when the hub
 * could not close the sockets (the token is already refused): retrying is
 * safe.
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
      "internal",
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
): Promise<{ roles: BusRole[]; live: boolean }> {
  if (!busOn(env) || !(await hasConnectedMachine(env, userId)))
    return { roles: [], live: false };
  const hub = busHub(env, userId);
  if (!hub) return { roles: [], live: false };
  try {
    const roles = await within(hub.listRoles(), BUS_HUB_TIMEOUT_MS);
    return roles === null ? { roles: [], live: false } : { roles, live: true };
  } catch (e) {
    logError("bus_roles_failed", e);
    return { roles: [], live: false };
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

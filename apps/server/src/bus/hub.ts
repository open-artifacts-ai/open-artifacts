import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  AGENT_CAP_MESSAGES,
  type AgentKind,
  type AgentUpFrame,
  type ClientFrame,
  candidateName,
  decodeClientFrame,
  encodeFrame,
  FALLBACK_BUS_NAME,
  frameId,
  isMachineId,
  LIMITS,
  MachineLabelSchema,
  newId,
  PING,
  PONG,
  REFUSAL_REASONS,
  type RefusalReason,
  type SendFrame,
  type ServerFrame,
  suffixName,
  utf8Bytes,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import type { BusAgent } from "@oa/shared";
import type { Env } from "../env.js";
import { logInfo } from "../log.js";
import { VERSION } from "../version.gen.js";
import { type AgentWithMachine, agentDto, validAgents } from "./dto.js";
import {
  AGENT_COLS,
  type AgentRow,
  MACHINE_COLS,
  type MachineRow,
} from "./rows.js";
import { HUB_SCHEMA, migrateHub } from "./schema.js";
import {
  applyDueStatus,
  applyStatus,
  clearStatus,
  nextStatusDue,
  STATUS_CLEAR,
  type StatusChange,
  statusWire,
} from "./status.js";

// BusHub (#1291): OpenBus 0.63.0's hub DO (apps/server/src/hub/do.ts), one per
// member (idFromName(busHubName(userId))). Dropped from the port: machines'
// tokens and the device flow (D1 bus_machines and bus_device_codes, bus/*.ts),
// the OIDC states and session generation (Open Artifacts' sign-in), the
// dashboard socket feed (the dashboard polls REST), roles, agent cards,
// linked apps and the client-version gates. org_id stays on every row, always
// OWNER_ORG_ID (Product: a constant for now).

/** The one org id every hub row carries. */
export const OWNER_ORG_ID = "owner";

/** The DO name of `userId`'s hub. */
export const busHubName = (userId: string): string => `bus:${userId}`;

/**
 * The hub DO's internal path for a verified daemon upgrade. The Worker's GET
 * /bus/connect (bus/connect.ts) verifies the machine token in D1 and builds a
 * fresh request with only the headers below: the client's own never arrive.
 */
export const CONNECT_DO_PATH = "/connect";
export const MACHINE_ID_HEADER = "x-oa-bus-machine-id";
export const MACHINE_LABEL_HEADER = "x-oa-bus-machine-label";
/** When the Worker authorized the upgrade (ms): see BusHub.closeAll. */
export const AUTHZ_AT_HEADER = "x-oa-bus-authz-at";
/**
 * Clock-skew margin (ms) between the Worker that stamps AUTHZ_AT_HEADER and
 * this DO: an upgrade authorized at or before revokedAt + SKEW_MS is refused
 * (429, Retry-After), so a connect racing closeAll never survives it.
 */
export const SKEW_MS = 2000;

/** Structured hub events: ids, codes, kinds and counts only (log.ts). */
function logEvent(
  evt: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  logInfo(`bus_${evt}`, fields);
}

const HOUR_MS = 3_600_000;
/** meta key: when the last closeAll started (ms). */
const REVOKED_AT_KEY = "revoked_at";
/**
 * Latest alarm time ever asked of workerd, which throws past year 2189. A
 * later deadline is clamped here (and re-checked when this alarm fires).
 */
const ALARM_MAX_MS = Date.UTC(2100, 0, 1);

/**
 * A deadline workerd's setAlarm accepts: clamped to ALARM_MAX_MS; null (and
 * logged) when not a finite number, so a bad value never throws and stalls
 * the multiplexed alarm.
 */
function alarmTime(t: number): number | null {
  if (!Number.isFinite(t)) {
    logEvent("alarm_dropped");
    return null;
  }
  return Math.min(t, ALARM_MAX_MS);
}

type StoredMachine = Omit<MachineRow, "connected">;
type Row = Record<string, SqlStorageValue>;
type FetchFrame = Extract<ClientFrame, { type: "fetch" }>;

// Helpers are module-level, not class members: every method on the class
// prototype (TS `private`/`protected` included) is callable over RPC.

function all<T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] {
  return sql.exec<T>(q, ...b).toArray();
}

function one<T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T | null {
  return all<T>(sql, q, ...b)[0] ?? null;
}

/**
 * True only while the hub holds an open, current daemon socket tagged with the
 * machine id (B5). A socket being closed no longer counts.
 */
function withLiveness(ctx: DurableObjectState, m: StoredMachine): MachineRow {
  return {
    ...m,
    connected: m.revokedAt === null && machineOnline(ctx, m.id),
  };
}

/** An unrevoked machine this hub has accepted, or null. */
function activeMachine(
  ctx: DurableObjectState,
  id: string,
): MachineRow | null {
  const m = one<StoredMachine>(
    ctx.storage.sql,
    `select ${MACHINE_COLS} from machines where id = ? and org_id = ? and revoked_at is null`,
    id,
    OWNER_ORG_ID,
  );
  return m && withLiveness(ctx, m);
}


// ------------------------------------------------------------------ sockets
//
// Daemon sockets are tagged exactly ["daemon", machineId]: "daemon" for
// broadcasts, the machine id for B3's `connected` (withLiveness) and for the
// roster's live/queued state. Hibernation API only: no timers, no outbound
// sockets, and each message does a few indexed queries.

/**
 * Highest numeric suffix tried for a proposed name (then for the fallback
 * name). Equal to the roster cap, so the cap is reached before a name runs out.
 */
const MAX_NAME_SUFFIX = LIMITS.maxRosterAgents;
const DAEMON_TAG = "daemon";
const OPEN = 1; // WebSocket.READY_STATE_OPEN

type ErrorCode = Extract<ServerFrame, { type: "error" }>["code"];
/**
 * `replaced`: a newer socket took over this machine; `revoked`: the machine
 * was revoked (B9). Either way the socket is dead: nothing it sends is
 * processed and its close runs no bookkeeping. `clientVersion` is the last
 * `hello.client_version` (at most 64 chars), kept here so version gates
 * survive hibernation.
 */
type Attachment = {
  machineId: string;
  clientVersion?: string;
  replaced?: true;
  revoked?: true;
};

function attachmentOf(ws: WebSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return typeof a?.machineId === "string" ? a : null;
}

function machineOf(ws: WebSocket): string | null {
  return attachmentOf(ws)?.machineId ?? null;
}

const isReplaced = (ws: WebSocket): boolean => {
  const a = attachmentOf(ws);
  return a?.replaced === true || a?.revoked === true;
};

const isRevokedSocket = (ws: WebSocket): boolean =>
  attachmentOf(ws)?.revoked === true;

/**
 * Daemons below KIND_TOKEN_MIN_CLIENT decode `kind` with a closed enum and
 * refuse a roster with any other kind. Fails closed: no hello or a malformed
 * version gets only PRE_TOKEN_KINDS.
 */
const preTokenKinds = (ws: WebSocket): boolean =>
  !semverGte(attachmentOf(ws)?.clientVersion ?? "", KIND_TOKEN_MIN_CLIENT);

/**
 * The agent card wire (roster `role`, receipt `to_name`, `role_vacant`) goes
 * only to daemons at or above AGENT_CARD_MIN_CLIENT; their decoders are
 * strict. Fails closed, as preTokenKinds does.
 */
const gated = (ws: WebSocket): boolean =>
  semverGte(attachmentOf(ws)?.clientVersion ?? "", AGENT_CARD_MIN_CLIENT);

/** A refusal reason as `ws` can decode it: role_vacant is unknown_agent below the gate. */
const refusalFor = (ws: WebSocket, reason: RefusalReason): RefusalReason =>
  reason === "role_vacant" && !gated(ws) ? "unknown_agent" : reason;

/** The SQL allow-list for a pre-token daemon (constants, never input). */
const PRE_TOKEN_KIND_SQL = ` and kind in (${PRE_TOKEN_KINDS.map((k) => `'${k}'`).join(", ")})`;

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  try {
    ws.send(encodeFrame(frame));
  } catch {
    // The socket is closing; the daemon resyncs on reconnect.
  }
}

function sendError(
  ws: WebSocket,
  id: string | undefined,
  code: ErrorCode,
  message: string,
): void {
  sendFrame(ws, { v: 1, id: id ?? frameId(), type: "error", code, message });
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

/**
 * Daemon frame budget (B11): a token bucket per MACHINE, counted before
 * decode. It refills at `refillPerSec` and holds at most `burst` tokens; a
 * frame with no token left closes the socket with LIMITS.rateLimitCloseCode
 * (4429) "rate limited", and that machine's /hub upgrades get 429 for
 * LIMITS.rateLimitCooldownMs.
 *
 * Manager ruling (M3): burst 512 at 50/s. Client paces at 40 frames/s, below
 * the refill, so a paced daemon never drains the bucket; 512 also absorbs an
 * unpaced reconnect of a full machine (hello + 200 agent_ups + acks for a
 * 50-message flush = 252) twice over, while one socket can no longer fire
 * thousands of heavy frames at once.
 *
 * Keyed by machine id in memory (M2): a reconnect inherits the bucket (and
 * the cooldown). A wake starts empty maps, which is accepted. The runtime's
 * auto-response answers a bare ping without waking the hub, so pings never
 * count.
 */
export const FRAME_BUDGET = { refillPerSec: 50, burst: 512 } as const;

/** Dashboard sockets (L3): they only send pings, which never count. Per socket. */
export const DASHBOARD_FRAME_BUDGET = { refillPerSec: 1, burst: 16 } as const;

type Budget = { tokens: number; at: number; cooldownUntil: number };

/** Takes one token from `b` after refilling it to `now`; false when none was left. */
function takeToken(
  b: Budget,
  now: number,
  rule: { refillPerSec: number; burst: number },
): boolean {
  if (now > b.at)
    b.tokens = Math.min(
      rule.burst,
      b.tokens + ((now - b.at) * rule.refillPerSec) / 1000,
    );
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** A protocol refusal on a daemon socket: logged (code and machine id only), then sent. */
function reject(
  ws: WebSocket,
  machineId: string,
  id: string | undefined,
  code: ErrorCode,
  message: string,
): void {
  logEvent("hub_reject", { code, machineId });
  sendError(ws, id, code, message);
}

/**
 * Why a new live agent on `machineId` is refused, or null: past
 * maxAgentsPerMachine live agents on the machine, or maxRosterAgents in the
 * org. A re-up of an agent already live adds none and always passes. Bounded
 * counts on agents_machine and the live-only agents_live_lname.
 */
function capRefusal(
  sql: SqlStorage,
  machineId: string,
  ref: string,
): "machine" | "org" | null {
  if (registeredAgent(sql, machineId, ref)) return null;
  const n = (q: string, ...b: SqlStorageValue[]) =>
    one<{ n: number }>(sql, q, ...b)?.n ?? 0;
  if (
    n(
      "select count(*) as n from (select 1 from agents where machine_id = ? and live = 1 limit ?)",
      machineId,
      LIMITS.maxAgentsPerMachine,
    ) >= LIMITS.maxAgentsPerMachine
  )
    return "machine";
  if (
    n(
      "select count(*) as n from (select 1 from agents where org_id = ? and live = 1 limit ?)",
      OWNER_ORG_ID,
      LIMITS.maxRosterAgents,
    ) >= LIMITS.maxRosterAgents
  )
    return "org";
  return null;
}

/** True while the machine holds an open, current socket other than `except`. */
function machineOnline(
  ctx: DurableObjectState,
  machineId: string,
  except?: WebSocket,
): boolean {
  return ctx
    .getWebSockets(machineId)
    .some((w) => w !== except && w.readyState === OPEN && !isReplaced(w));
}

/**
 * The machine's live socket: open and not replaced. A replaced socket is dead
 * and never receives mail.
 */
function liveSocket(
  ctx: DurableObjectState,
  machineId: string,
): WebSocket | null {
  return (
    ctx
      .getWebSockets(machineId)
      .find((w) => w.readyState === OPEN && !isReplaced(w)) ?? null
  );
}

/**
 * For each machine id that should hear about `changed`, the namespaces it
 * should hear: those where it hosts a live agent, or all of them when it
 * hosts any live global agent (a global sees every namespace).
 *
 * Bounded by the smaller side: one indexed query per changed namespace, or
 * one per connected machine when there are fewer machines than namespaces.
 */
function rosterAudience(
  sql: SqlStorage,
  changed: string[],
  machines: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const all_ = (m: string) => out.set(m, changed);
  for (const r of all<{ machineId: string }>(
    sql,
    "select distinct machine_id as machineId from agents where org_id = ? and live = 1 and global = 1",
    OWNER_ORG_ID,
  ))
    all_(r.machineId);
  if (changed.length <= machines.length) {
    for (const namespace of changed)
      for (const r of all<{ machineId: string }>(
        sql,
        "select distinct machine_id as machineId from agents where org_id = ? and namespace = ? and live = 1",
        OWNER_ORG_ID,
        namespace,
      )) {
        const cur = out.get(r.machineId);
        if (cur === changed) continue;
        if (cur) cur.push(namespace);
        else out.set(r.machineId, [namespace]);
      }
    return out;
  }
  const wanted = new Set(changed);
  for (const m of machines) {
    if (out.get(m) === changed) continue;
    const hit = all<{ namespace: string }>(
      sql,
      // machine ids are unique across orgs: agents_machine(machine_id, live).
      "select distinct namespace from agents where machine_id = ? and live = 1",
      m,
    )
      .map((r) => r.namespace)
      .filter((n) => wanted.has(n));
    if (hit.length > 0) out.set(m, hit);
  }
  return out;
}

/**
 * What changed: the namespaces of the agents that changed, and whether any of
 * them is global (a global appears in every namespace's list).
 */
type RosterChange = { namespaces: string[]; global: boolean };

/**
 * A global change reaches every daemon: one `roster_changed{ns}` for each
 * namespace where that daemon's machine hosts a live agent (bounded by its own
 * agents, not namespaces x daemons). One covering query on
 * agents_live_ns_machine.
 */
function everyDaemonAudience(sql: SqlStorage): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of all<{ machineId: string; namespace: string }>(
    sql,
    "select distinct machine_id as machineId, namespace from agents where org_id = ? and live = 1",
    OWNER_ORG_ID,
  )) {
    const cur = out.get(r.machineId);
    if (cur) cur.push(r.namespace);
    else out.set(r.machineId, [r.namespace]);
  }
  return out;
}

/**
 * The one roster broadcast; each frame is encoded once per namespace. A
 * non-global change goes only to daemons whose machine hosts a live agent in
 * the namespace, or any live global; a global change reaches every daemon
 * (everyDaemonAudience). `except` is the socket that caused the change: it
 * already knows and is never told. Callers also call #notifyDashboards (B10).
 */
function notifyRoster(
  ctx: DurableObjectState,
  change: RosterChange,
  except?: WebSocket,
) {
  const changed = [...new Set(change.namespaces)];
  if (changed.length === 0) return;
  const sockets = ctx
    .getWebSockets(DAEMON_TAG)
    .filter((w) => w !== except && w.readyState === OPEN && !isReplaced(w));
  if (sockets.length === 0) return;
  const machines = [
    ...new Set(sockets.map(machineOf).filter((m): m is string => m !== null)),
  ];
  const audience = change.global
    ? everyDaemonAudience(ctx.storage.sql)
    : rosterAudience(ctx.storage.sql, changed, machines);
  const encoded = new Map<string, string>();
  const frameFor = (namespace: string) => {
    let f = encoded.get(namespace);
    if (f === undefined) {
      f = encodeFrame({
        v: 1,
        id: frameId(),
        type: "roster_changed",
        namespace,
      });
      encoded.set(namespace, f);
    }
    return f;
  };
  for (const ws of sockets) {
    const m = machineOf(ws);
    const nss = m === null ? undefined : audience.get(m);
    if (!nss) continue;
    for (const namespace of nss) {
      try {
        ws.send(frameFor(namespace));
      } catch {
        // Closing; it resyncs on reconnect.
      }
    }
  }
}

/** A machine's open agents: their state flips with its socket. */
function machineChange(sql: SqlStorage, machineId: string): RosterChange {
  const rows = all<{ namespace: string; g: number }>(
    sql,
    "select namespace, max(global) as g from agents where machine_id = ? and live = 1 group by namespace limit ?",
    machineId,
    LIMITS.maxRosterAgents,
  );
  return {
    namespaces: rows.map((r) => r.namespace),
    global: rows.some((r) => r.g === 1),
  };
}

/**
 * A role change: the role's namespace plus the namespaces of `agentIds` (its
 * old and new holders), whose roster rows carry the role.
 */
function roleChange(
  sql: SqlStorage,
  ns: string,
  agentIds: (string | null)[],
): RosterChange {
  const rows = all<{ namespace: string }>(
    sql,
    "select namespace from agents where id in (select value from json_each(?))",
    JSON.stringify(agentIds.filter((a) => a !== null)),
  );
  return { namespaces: [ns, ...rows.map((r) => r.namespace)], global: false };
}

/** The agent id role `role` (any case) in `ns` points at, or null. */
function roleHolderId(
  sql: SqlStorage,
  ns: string,
  role: string,
): string | null {
  return (
    one<{ a: string | null }>(
      sql,
      "select agent_id as a from roles where org_id = ? and namespace = ? and lrole = ?",
      OWNER_ORG_ID,
      ns,
      role.toLowerCase(),
    )?.a ?? null
  );
}

/** The open agent `ref` on this machine, or null: the from_ref identity check. */
function registeredAgent(
  sql: SqlStorage,
  machineId: string,
  ref: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where machine_id = ? and native_ref = ? and live = 1 and org_id = ?`,
    machineId,
    ref,
    OWNER_ORG_ID,
  );
}

/**
 * Names compare case-insensitively (bus names are ASCII), against agents and
 * roles (roleTaken). A global agent's
 * name must be free among ALL live agents (it is visible everywhere); a
 * non-global's must be free in its namespace and among live globals.
 * One query on agents_live_lname.
 */
function nameTaken(
  sql: SqlStorage,
  namespace: string,
  name: string,
  global: boolean,
  selfId: string,
): boolean {
  const lname = name.toLowerCase();
  // AC2a: a role reserves its name (hub/roles.ts).
  if (roleTaken(sql, namespace, lname, global)) return true;
  return global
    ? one(
        sql,
        "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and id != ? limit 1",
        OWNER_ORG_ID,
        lname,
        selfId,
      ) !== null
    : one(
        sql,
        "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and id != ? and (namespace = ? or global = 1) limit 1",
        OWNER_ORG_ID,
        lname,
        selfId,
        namespace,
      ) !== null;
}

/**
 * The proposed name, else `-2`, `-3`... up to the roster cap, else the
 * fallback name suffixed the same way, else a random fallback suffix. Never
 * fails: a name collision is not an error.
 */
function assignName(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
): string {
  const free = (n: string) => !nameTaken(sql, namespace, n, global, selfId);
  for (const base of new Set([candidateName(proposed), FALLBACK_BUS_NAME])) {
    if (free(base)) return base;
    for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
      const next = suffixName(base, n);
      if (free(next)) return next;
    }
  }
  for (;;) {
    const next = suffixName(
      FALLBACK_BUS_NAME,
      MAX_NAME_SUFFIX + 1 + Math.floor(Math.random() * 1e9),
    );
    if (free(next)) return next;
  }
}

/** Registers (or re-registers) an agent; returns the reply and changed namespaces. */
function agentUp(
  sql: SqlStorage,
  machineId: string,
  f: AgentUpFrame,
  now: number,
): { reply: ServerFrame; change: RosterChange; rowChanged: boolean } {
  const existing = one<{
    id: string;
    namespace: string;
    name: string;
    kind: string;
    live: number;
    global: number;
  }>(
    sql,
    "select id, namespace, name, kind, live, global from agents where machine_id = ? and native_ref = ? and org_id = ?",
    machineId,
    f.agent_ref,
    OWNER_ORG_ID,
  );
  const id = existing?.id ?? newId();
  const name = assignName(sql, f.namespace, f.proposed_name, f.global, id);
  // A new session starts when the agent was not live (B11): its boundary is
  // the newest receipt's rowid (receipts rowids only grow: the retention
  // purge never deletes the newest), so the old session's mail is never
  // served to it (fetch, flush, ack and the inbox cap take rowid > it).
  if (existing)
    sql.exec(
      "update agents set namespace = ?, name = ?, kind = ?, global = ?, live = 1, updated_at = ?, session_start_rowid = case when live = 1 then session_start_rowid else (select coalesce(max(rowid), 0) from receipts) end where id = ?",
      f.namespace,
      name,
      f.kind,
      f.global ? 1 : 0,
      now,
      id,
    );
  else
    sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at, session_start_rowid)
       values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, (select coalesce(max(rowid), 0) from receipts))`,
      id,
      OWNER_ORG_ID,
      f.namespace,
      name,
      f.kind,
      machineId,
      f.agent_ref,
      f.global ? 1 : 0,
      now,
    );
  const wasLive = existing?.live === 1;
  // AC2a (review I1): a holder that reopens, moves namespace or changes
  // global loses its role, so a role never silently follows it back.
  if (
    existing &&
    (!wasLive ||
      existing.namespace !== f.namespace ||
      existing.global !== (f.global ? 1 : 0))
  )
    vacateRoles(sql, [id]);
  // AC3: a reopened session starts with no status (a live move keeps it).
  if (existing && !wasLive) clearStatus(sql, [id]);
  const changed = [f.namespace];
  if (wasLive && existing.namespace !== f.namespace)
    changed.push(existing.namespace);
  const global = f.global || (wasLive && existing.global === 1);
  // What the dashboard shows changed: a new row, a live flip, or a new
  // namespace, name, kind or global (updated_at alone does not count).
  const rowChanged =
    !existing ||
    !wasLive ||
    existing.namespace !== f.namespace ||
    existing.name !== name ||
    existing.kind !== f.kind ||
    existing.global !== (f.global ? 1 : 0);
  return {
    rowChanged,
    reply: {
      v: 1,
      id: f.id,
      type: "agent_ok",
      agent_ref: f.agent_ref,
      bus_name: name,
    },
    change: { namespaces: changed, global },
  };
}

/** Closes an open agent (its session ended); returns it, or null. */
function agentDown(
  sql: SqlStorage,
  machineId: string,
  ref: string,
  now: number,
): { id: string; namespace: string; global: number } | null {
  // One statement (B11): the close is the hot path of sessions{closed}.
  const a = one<{ id: string; namespace: string; global: number }>(
    sql,
    `update agents set live = 0, last_name = name, updated_at = ?, ${STATUS_CLEAR} where machine_id = ? and native_ref = ? and live = 1 and org_id = ? returning id, namespace, global`,
    now,
    machineId,
    ref,
    OWNER_ORG_ID,
  );
  if (a) vacateRoles(sql, [a.id]);
  return a;
}

/**
 * A non-global agent sees its namespace plus every global agent; a global
 * agent sees every open agent. `state` is always sent: live while the
 * agent's machine holds an open, current socket (machineOnline, as the
 * dashboard and the send path decide it), queued otherwise. `preToken`
 * keeps only PRE_TOKEN_KINDS rows, for daemons too old to decode any other
 * kind (preTokenKinds). `gatedFields` (gated) adds each row's role, as the
 * viewer can resolve it (rolesOf), and its status (AC3).
 */
function roster(
  ctx: DurableObjectState,
  agent: AgentRow,
  id: string,
  preToken: boolean,
  gatedFields: boolean,
): ServerFrame {
  const sql = ctx.storage.sql;
  const cap = LIMITS.maxRosterAgents;
  const kinds = preToken ? PRE_TOKEN_KIND_SQL : "";
  let rows: AgentRow[];
  if (agent.global === 1) {
    rows = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1${kinds} order by namespace, name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
  } else {
    // Two indexed queries (agents_live_name, agents_global_name), merged here.
    const local = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and namespace = ? and live = 1${kinds} order by name limit ?`,
      OWNER_ORG_ID,
      agent.namespace,
      cap,
    );
    const globals = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1 and global = 1${kinds} order by name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
    const seen = new Set(local.map((r) => r.id));
    rows = [...local, ...globals.filter((r) => !seen.has(r.id))]
      .sort((a, b) =>
        a.namespace === b.namespace
          ? a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0
          : a.namespace < b.namespace
            ? -1
            : 1,
      )
      .slice(0, cap);
  }
  const online = new Map<string, boolean>();
  const stateOf = (machineId: string): "live" | "queued" => {
    let on = online.get(machineId);
    if (on === undefined) {
      // L1: open and not replaced or revoked, as the dashboard and sends see it.
      on = machineOnline(ctx, machineId);
      online.set(machineId, on);
    }
    return on ? "live" : "queued";
  };
  const labels = machineLabels(sql, rows);
  const roles = gatedFields
    ? rolesOf(
        sql,
        rows.map((r) => r.id),
        agent.global === 1 ? null : agent.namespace,
      )
    : new Map<string, string>();
  return {
    v: 1,
    id,
    type: "roster",
    agents: rows.map((r) => {
      const label = labels.get(r.machineId);
      return {
        bus_name: r.name,
        kind: r.kind as AgentKind,
        namespace: r.namespace,
        global: r.global === 1,
        state: stateOf(r.machineId),
        // The key is omitted, never null, if a row's machine has no label.
        ...(label === undefined ? {} : { machine_label: label }),
        ...(roles.has(r.id) ? { role: roles.get(r.id) } : {}),
        ...(gatedFields ? statusWire(r) : {}),
      };
    }),
  };
}

/**
 * The labels of the rows' machines (B13), in one statement: the distinct
 * machine ids (at most the roster cap) as one JSON parameter, each looked up
 * by the machines primary key. Only rows already in the roster are labelled.
 */
function machineLabels(sql: SqlStorage, rows: AgentRow[]): Map<string, string> {
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.map((r) => r.machineId))];
  const found = all<{ id: string; label: string }>(
    sql,
    "select id, label from machines where org_id = ? and id in (select value from json_each(?))",
    OWNER_ORG_ID,
    JSON.stringify(ids),
  );
  return new Map(found.map((m) => [m.id, m.label]));
}

// --------------------------------------------------------------- dashboards
//
// Dashboard sockets (B10-ws, manager ruling: a hibernatable WebSocket replaces
// SSE). They arrive on the hub's internal GET /events (EVENTS_DO_PATH), tagged
// only "dashboard" (never DAEMON_TAG or a machine id). Their attachment has no
// machineId, so attachmentOf/machineOf see null and no daemon path treats one
// as a machine; daemon paths only ever list DAEMON_TAG or machine-id sockets.
// Hibernation-safe: the list is always getWebSockets(DASHBOARD_TAG), never an
// in-memory one.

const DASHBOARD_TAG = "dashboard";
/** Dashboard sockets per hub; a newcomer past it evicts the oldest open one. */
export const MAX_DASHBOARDS = 16;
/** "Try again later": the dashboard was evicted to make room. */
const EVICT_CODE = 1013;
/** "Internal error": a send to the dashboard failed. */
const SEND_FAILED_CODE = 1011;
/** The session ended (bump or expiry): the dashboard must sign in again. */
const SESSION_CLOSE = LIMITS.dashboardSessionClose;

/**
 * `seq` is the connect order (max existing + 1), for evicting the oldest.
 * `exp` is the session's expiry (epoch ms) from SESSION_EXP_HEADER, `gen` its
 * generation from SESSION_GEN_HEADER (equal to the hub's at accept).
 */
type DashboardAttachment = {
  dashboard: true;
  seq: number;
  exp: number;
  gen: number;
};

/** Latest accepted session expiry past now: B1's max age plus 1 min of clock skew. */
const SESSION_EXP_CAP_MS = MAX_AGE_S * 1000 + 60_000;

function dashboardAttachment(ws: WebSocket): DashboardAttachment | null {
  try {
    const a = ws.deserializeAttachment() as DashboardAttachment | null;
    return a?.dashboard === true ? a : null;
  } catch {
    return null;
  }
}

function dashboardSeq(ws: WebSocket): number {
  const seq = dashboardAttachment(ws)?.seq;
  return typeof seq === "number" ? seq : 0;
}

/** The socket's session expiry; a socket without a valid one counts as expired. */
function dashboardExp(ws: WebSocket): number {
  const exp = dashboardAttachment(ws)?.exp;
  return typeof exp === "number" && Number.isSafeInteger(exp) ? exp : 0;
}

/**
 * True when a socket event must skip the daemon paths: a dashboard socket, or
 * a socket this DO never accepted (getTags throws; seen when a test or the
 * runtime closes a socket before acceptWebSocket), which has nothing to clean up.
 */
const notDaemon = (ctx: DurableObjectState, ws: WebSocket): boolean => {
  try {
    return ctx.getTags(ws).includes(DASHBOARD_TAG);
  } catch {
    return true;
  }
};

/**
 * A forwarded header as a plain decimal integer of at most 16 digits (a safe
 * integer), else null. Number() alone would accept "", " ", "0x10", "1e15".
 */
function parseDecimal(v: string | null): number | null {
  if (v === null || !/^[0-9]{1,16}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** SESSION_EXP_HEADER: in (now, now + SESSION_EXP_CAP_MS], else null. */
function parseSessionExp(v: string | null, now: number): number | null {
  const exp = parseDecimal(v);
  if (exp === null || exp <= now || exp > now + SESSION_EXP_CAP_MS) return null;
  return exp;
}

/** Ordered like the SQL: namespace, then lower(name), then name. */
function byNamespaceName(
  a: Pick<AgentRow, "namespace" | "name">,
  b: Pick<AgentRow, "namespace" | "name">,
): number {
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

const AGENT_DTO_COLS = `a.id, a.namespace, a.name, a.last_name as lastName, a.kind,
  a.machine_id as machineId, a.native_ref as nativeRef, a.global, a.live,
  a.updated_at as updatedAt, m.label as machineLabel, a.status,
  a.status_label as statusLabel, a.status_at as statusAt`;

/**
 * The dashboard's agent list (listAgents and the dashboard feed). Open agents
 * of unrevoked machines, joined to machines (primary key) for the label. All
 * agents: one ordered scan of agents_live_ns_lname, stopping at the cap. One
 * namespace: that namespace on agents_live_ns_lname plus the globals on
 * agents_global_name, merged here (as roster() does).
 */
function agentList(ctx: DurableObjectState, namespace?: string): Agent[] {
  const sql = ctx.storage.sql;
  const cap = LIMITS.maxRosterAgents;
  const from = "from agents a join machines m on m.id = a.machine_id";
  let rows: AgentWithMachine[];
  if (namespace === undefined) {
    rows = all<AgentWithMachine>(
      sql,
      `select ${AGENT_DTO_COLS} ${from} where a.org_id = ? and a.live = 1 and m.revoked_at is null order by a.namespace, lower(a.name), a.name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
  } else {
    const local = all<AgentWithMachine>(
      sql,
      `select ${AGENT_DTO_COLS} ${from} where a.org_id = ? and a.namespace = ? and a.live = 1 and m.revoked_at is null order by lower(a.name), a.name limit ?`,
      OWNER_ORG_ID,
      namespace,
      cap,
    );
    // Forced onto the globals-only index: the planner otherwise walks every
    // live agent in order and filters out the non-globals.
    const globals = all<AgentWithMachine>(
      sql,
      `select ${AGENT_DTO_COLS} from agents a indexed by agents_global_name join machines m on m.id = a.machine_id where a.org_id = ? and a.live = 1 and a.global = 1 and m.revoked_at is null order by a.namespace, lower(a.name), a.name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
    const seen = new Set(local.map((r) => r.id));
    rows = [...local, ...globals.filter((r) => !seen.has(r.id))]
      .sort(byNamespaceName)
      .slice(0, cap);
  }
  const online = new Map<string, boolean>();
  // The owner sees every role its holder still holds (HOLDER_SQL), in any
  // namespace; an agent holds at most one.
  const roles = rolesOf(
    sql,
    rows.map((r) => r.id),
    null,
  );
  const dtos = rows.map((r) => {
    let on = online.get(r.machineId);
    if (on === undefined) {
      on = machineOnline(ctx, r.machineId);
      online.set(r.machineId, on);
    }
    return agentDto(r, on, roles.get(r.id));
  });
  // A bad stored row is skipped, never allowed to break the whole list.
  return validAgents(dtos);
}

const machineList = (ctx: DurableObjectState): Machine[] =>
  machineDtos(machineRows(ctx));

function readPushDue(sql: SqlStorage): number | null {
  const row = one<{ value: string }>(
    sql,
    "select value from meta where org_id = ? and key = ?",
    OWNER_ORG_ID,
    PUSH_DUE_KEY,
  );
  const n = row ? Number(row.value) : Number.NaN;
  return Number.isSafeInteger(n) ? n : null;
}

function writePushDue(sql: SqlStorage, due: number): void {
  sql.exec(
    "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
    OWNER_ORG_ID,
    PUSH_DUE_KEY,
    String(due),
  );
}

function clearPushDue(sql: SqlStorage): void {
  sql.exec(
    "delete from meta where org_id = ? and key = ?",
    OWNER_ORG_ID,
    PUSH_DUE_KEY,
  );
}

/** Best effort: a failed send closes the dashboard (1011) to free its slot. */
function sendDashboard(ws: WebSocket, payload: string): void {
  try {
    ws.send(payload);
  } catch {
    closeSocket(ws, SEND_FAILED_CODE, "send failed");
  }
}

// --------------------------------------------------------------------- mail
//
// Target resolution (CONTRACT.md "send targeting", B6 scope). Names compare
// case-insensitively; every query is on agents_live_lname or agents_lname.
// For a global sender, "the name in namespace X" means what X's roster shows:
// a live agent in X or a live global (globals are visible everywhere). A
// non-global sender's to_namespace X reaches only a live global whose HOME
// namespace is X (liveGlobalHomedIn). Live global names are unique among all
// live agents, so a lookup never sees two rows.

/**
 * Held (pushed, unacked inline) bodies are capped in memory across the hub;
 * past the cap a body is stored in `mail` instead (write-on-miss early). Each
 * entry is charged at least HELD_ENTRY_BYTES so tiny bodies are bounded too.
 */
export const HELD_BYTES_CAP = 8 * 1024 * 1024;
const HELD_ENTRY_BYTES = 256;

/** A held body: `at` is when it was pushed (its ack deadline is at + ackTimeoutMs). */
type Held = {
  toAgent: string;
  body: string;
  cost: number;
  at: number;
  createdAt: number;
  expiresAt: number;
};

/** The live agent `lname` names in namespace `ns` (in `ns`, or a global). */
function liveVisibleIn(
  sql: SqlStorage,
  ns: string,
  lname: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 and (namespace = ? or global = 1) order by global desc limit 1`,
    OWNER_ORG_ID,
    lname,
    ns,
  );
}

/** The live global named `lname` whose home namespace is `ns` (case 2). */
function liveGlobalHomedIn(
  sql: SqlStorage,
  ns: string,
  lname: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 and global = 1 and namespace = ? limit 1`,
    OWNER_ORG_ID,
    lname,
    ns,
  );
}

/**
 * Why a name with no live match is gone, or null when no closed agent had it:
 * the most recently updated closed agent named `lname` in scope decides, so a
 * name reused after a revoke and then closed normally is `closed` (B9 L1).
 * Scope is namespace `ns` or a global; null `ns` means every namespace.
 * One probe on agents_lname_recent, then the machines primary key.
 */
function goneReason(
  sql: SqlStorage,
  ns: string | null,
  lname: string,
): "revoked" | "closed" | null {
  const scope = ns === null ? "" : "and (a.namespace = ? or a.global = 1)";
  const r = one<{ revoked: number }>(
    sql,
    `select (m.revoked_at is not null) as revoked from agents a indexed by agents_lname_recent
       left join machines m on m.id = a.machine_id
      where a.org_id = ? and lower(a.name) = ? and a.live = 0 ${scope}
      order by a.updated_at desc, a.rowid desc limit 1`,
    OWNER_ORG_ID,
    lname,
    ...(ns === null ? [] : [ns]),
  );
  return r === null ? null : r.revoked ? "revoked" : "closed";
}

/** Up to `limit` live agents named `lname`, in any namespace. */
function liveAnywhere(
  sql: SqlStorage,
  lname: string,
  limit: number,
): AgentRow[] {
  return all<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 order by global desc limit ?`,
    OWNER_ORG_ID,
    lname,
    limit,
  );
}

const refused = (reason: RefusalReason): Resolution => ({ ok: false, reason });

function resolveTarget(
  sql: SqlStorage,
  sender: AgentRow,
  toName: string,
  toNamespace: string | undefined,
): Resolution {
  const lname = toName.toLowerCase();
  // AC2a: a role the sender can reach wins (a role never equals a visible
  // open agent's name, so this shadows nothing reachable).
  const role = resolveRole(sql, sender, lname, toNamespace);
  if (role) return role;
  if (sender.global !== 1) {
    if (toNamespace !== undefined && toNamespace !== sender.namespace) {
      // Only a live global homed in X is reachable. Everything else is the
      // same refusal, so it cannot probe what exists in another namespace.
      const hit = liveGlobalHomedIn(sql, toNamespace, lname);
      return hit ? { ok: true, agent: hit } : refused("other_namespace");
    }
    const hit = liveVisibleIn(sql, sender.namespace, lname);
    if (hit) return { ok: true, agent: hit };
    // B9: the newest closed agent with the name says revoked or closed.
    const gone = goneReason(sql, sender.namespace, lname);
    if (gone) return refused(gone);
    // Other namespaces are invisible and unreachable (spec goal 5, scenario
    // 6): a name live only elsewhere is unknown_agent, so no probe can tell
    // it exists. other_namespace answers an explicit to_namespace only.
    return refused("unknown_agent");
  }
  if (toNamespace !== undefined) {
    const hit = liveVisibleIn(sql, toNamespace, lname);
    if (hit) return { ok: true, agent: hit };
    const gone = goneReason(sql, toNamespace, lname);
    if (gone) return refused(gone);
    return refused("unknown_agent");
  }
  // A live global sorts first and is the only live agent with its name.
  const live = liveAnywhere(sql, lname, 2);
  const first = live[0];
  if (first && (first.global === 1 || live.length === 1))
    return { ok: true, agent: first };
  if (live.length > 1) return refused("ambiguous");
  const gone = goneReason(sql, null, lname);
  if (gone) return refused(gone);
  return refused("unknown_agent");
}

/**
 * True when the agent's current session already has `inboxCap` pending
 * receipts (receipts_to_age). A previous session's pending mail, still
 * draining after a close (B11), does not count.
 */
function inboxFull(sql: SqlStorage, agent: AgentRow): boolean {
  const row = one<{ n: number }>(
    sql,
    "select count(*) as n from (select 1 from receipts where to_agent = ? and state = 'pending' and rowid > ? limit ?)",
    agent.id,
    agent.sessionStartRowid,
    LIMITS.inboxCap,
  );
  return (row?.n ?? 0) >= LIMITS.inboxCap;
}

/** A refused send: a fresh msg_id and no stored row (no send key either, B14). */
function refuseSend(ws: WebSocket, id: string, reason: RefusalReason): void {
  sendFrame(ws, {
    v: 1,
    id,
    type: "receipt",
    msg_id: newId(),
    state: "refused",
    reason: refusalFor(ws, reason),
  });
}

/**
 * B14: the hash a send key compares on a resend: the target as resolution
 * sees it (to_name case-folded, to_namespace or ""), then the body's SHA-256.
 * A non-global sender's explicit own namespace is a no-op for resolution, so
 * it hashes as absent; a global sender's is not (absent may resolve to a
 * global or another namespace), so it stays as sent. Synchronous
 * (node:crypto), so the key check and insert stay in one turn.
 */
function payloadHash(f: SendFrame, sender: AgentRow): string {
  const body = createHash("sha256").update(f.body, "utf8").digest("hex");
  const ns =
    sender.global !== 1 && f.to_namespace === sender.namespace
      ? ""
      : (f.to_namespace ?? "");
  return createHash("sha256")
    .update(`${f.to_name.toLowerCase()}\n${ns}\n${body}`)
    .digest("hex");
}

type SendKey = { payloadHash: string; msgId: string; createdAt: number };
type SendKeyCheck =
  | { kind: "new"; hash: string; dropped: boolean }
  | { kind: "resend"; msgId: string }
  | { kind: "reused" };

/**
 * B14: looks up the send key (sender agent id, frame id). A key exists only
 * for a send that created a pending receipt; a refused send stores none, so
 * its resend is evaluated again. A key older than SEND_KEY_RETAIN_MS that the
 * alarm has not swept yet counts as gone (deleted here, so the fresh key
 * takes a new rowid and the cap's oldest-first order holds). #send looks up,
 * resolves and inserts in one synchronous turn, so two sends of the same key
 * can never both deliver.
 */
function findSendKey(
  sql: SqlStorage,
  sender: AgentRow,
  f: SendFrame,
  now: number,
): SendKeyCheck {
  const agentId = sender.id;
  const hash = payloadHash(f, sender);
  const key = one<SendKey>(
    sql,
    "select payload_hash as payloadHash, msg_id as msgId, created_at as createdAt from send_keys where from_agent = ? and frame_id = ?",
    agentId,
    f.id,
  );
  if (!key) return { kind: "new", hash, dropped: false };
  if (key.createdAt >= now - SEND_KEY_RETAIN_MS)
    return key.payloadHash === hash
      ? { kind: "resend", msgId: key.msgId }
      : { kind: "reused" };
  sql.exec(
    "delete from send_keys where from_agent = ? and frame_id = ?",
    agentId,
    f.id,
  );
  return { kind: "new", hash, dropped: true };
}

/**
 * B14: stores the key of a send whose receipt was just created pending
 * (insert ... on conflict do nothing: findSendKey ran in the same turn, so it
 * never conflicts). Room was made first (Hub.#roomForKey).
 */
function insertSendKey(
  sql: SqlStorage,
  agentId: string,
  frameId: string,
  hash: string,
  msgId: string,
  now: number,
): void {
  sql.exec(
    `insert into send_keys (from_agent, frame_id, org_id, payload_hash, msg_id, created_at)
     values (?, ?, ?, ?, ?, ?) on conflict (from_agent, frame_id) do nothing`,
    agentId,
    frameId,
    OWNER_ORG_ID,
    hash,
    msgId,
    now,
  );
}

/**
 * B14: the agent's oldest final key (its receipt left pending), through the
 * partial index send_keys_agent_final: one index seek, no scan.
 */
export const AGENT_FINAL_KEY_SQL =
  "select rowid as k from send_keys indexed by send_keys_agent_final where from_agent = ? and final = 1 order by created_at limit 1";
/** B14: the hub's oldest final key, through the partial index send_keys_final. */
export const HUB_FINAL_KEY_SQL =
  "select rowid as k from send_keys indexed by send_keys_final where final = 1 order by created_at limit 1";

/** B14: the send's key (if any) is final: its receipt just left pending. */
function finalizeKey(sql: SqlStorage, msgId: string): void {
  sql.exec("update send_keys set final = 1 where msg_id = ?", msgId);
}

function storeBody(
  sql: SqlStorage,
  id: string,
  toAgent: string,
  body: string,
  now: number,
  expiresAt: number,
): void {
  sql.exec(
    "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, ?, ?, ?) on conflict(id) do nothing",
    id,
    OWNER_ORG_ID,
    toAgent,
    body,
    now,
    expiresAt,
  );
}

/** The rows deleteDeliveredBodies deletes: params (agentId, through, limit). */
export const DELIVERED_BODIES_SELECT_SQL = `select m.rowid from mail m indexed by mail_to join receipts r on r.id = m.id
       where m.to_agent = ? and r.state = 'delivered' and r.rowid <= ? limit ?`;

/** The body cleanup deleteDeliveredBodies runs (exported so a test plans this exact SQL). */
export const DELETE_DELIVERED_BODIES_SQL = `delete from mail where rowid in (${DELIVERED_BODIES_SELECT_SQL}) returning rowid`;

/**
 * Deletes up to `limit` stored bodies of the agent's delivered (acked,
 * unfetched notice) receipts with rowid <= `through`; returns how many.
 * Driven by mail_to (B11 H1): it walks only the agent's rows that hold a
 * body, never its retained delivered history.
 */
function deleteDeliveredBodies(
  sql: SqlStorage,
  agentId: string,
  limit: number,
  through: number = Number.MAX_SAFE_INTEGER,
): number {
  return all(sql, DELETE_DELIVERED_BODIES_SQL, agentId, through, limit).length;
}

/** A close-drain queue row's value, or null when it does not parse. */
function parseCloseEntry(v: string): { through: number; ids: string[] } | null {
  try {
    const o = JSON.parse(v) as { through?: unknown; ids?: unknown };
    if (
      typeof o.through === "number" &&
      Number.isSafeInteger(o.through) &&
      Array.isArray(o.ids) &&
      o.ids.every((x) => typeof x === "string")
    )
      return { through: o.through, ids: o.ids as string[] };
  } catch {
    // Unreadable: dropped by the drain.
  }
  return null;
}

/**
 * The agent ids a revoke drain row written before M2 (value: a rowid cursor)
 * still has to visit: the machine's closed agents past the cursor with
 * pending mail or a stored body. Read once per such row, then stored as ids.
 */
function legacyRevokeIds(
  sql: SqlStorage,
  machineId: string,
  cursor: number,
): string[] {
  return all<{ id: string }>(
    sql,
    `select a.id from agents a
      where a.machine_id = ? and a.live = 0 and a.rowid > ?
        and (exists (select 1 from receipts r where r.to_agent = a.id and r.state = 'pending')
          or exists (select 1 from mail m indexed by mail_to where m.to_agent = a.id))
      order by a.rowid`,
    machineId,
    cursor,
  ).map((r) => r.id);
}

/** The revoke drain's queue value (M2): the agent ids still to drain, or null. */
function parseRevokeEntry(v: string): string[] | null {
  try {
    const o = JSON.parse(v) as { ids?: unknown };
    if (
      o !== null &&
      typeof o === "object" &&
      Array.isArray(o.ids) &&
      o.ids.every((x) => typeof x === "string")
    )
      return o.ids as string[];
  } catch {
    // Not JSON: a cursor written before M2 (or unreadable).
  }
  return null;
}

/** The closed-agent purge cursor (M1), or null (no pass under way). */
function parsePurgeCursor(
  v: string,
): { u: number; r: number; kept: number } | null {
  try {
    const o = JSON.parse(v) as { u?: unknown; r?: unknown; kept?: unknown };
    if (
      Number.isSafeInteger(o.u) &&
      Number.isSafeInteger(o.r) &&
      Number.isSafeInteger(o.kept)
    )
      return { u: o.u as number, r: o.r as number, kept: o.kept as number };
  } catch {
    // Unreadable: a new pass starts.
  }
  return null;
}

/**
 * Resolves a pending receipt for an ack or refuse from `machineId`: only the
 * recipient agent's machine may, and only while it is pending. Returns the
 * sender agent id on success, null (ignored) otherwise.
 *
 * The check is by machine, not socket: a late ack that a replaced socket of
 * the recipient's machine sent before it was replaced is accepted on purpose,
 * since that machine is still the recipient. (Frames arriving on a socket
 * after it is marked replaced never get here.)
 *
 * How it was delivered follows from `size`: above inlineBodyBytes it went as
 * a notice. Acking a notice means the harness took the notice, so the receipt
 * is delivered but the stored body stays for fetch. A refusal drops either.
 */
function settle(
  sql: SqlStorage,
  machineId: string,
  msgId: string,
  outcome: "delivered" | "refused",
  now: number,
): string | null {
  const r = one<{ fromAgent: string; size: number }>(
    sql,
    `select r.from_agent as fromAgent, r.size from receipts r join agents a on a.id = r.to_agent
     where r.id = ? and r.org_id = ? and r.state = 'pending' and a.machine_id = ?
       and r.rowid > a.session_start_rowid`,
    msgId,
    OWNER_ORG_ID,
    machineId,
  );
  if (!r) return null;
  // R7 (accepted): an ack after expires_at but before the sweep counts as
  // delivered; the harness really did take it.
  if (outcome === "delivered")
    sql.exec(
      "update receipts set state = 'delivered', acked_at = ?, final_at = ? where id = ? and state = 'pending'",
      now,
      now,
      msgId,
    );
  else
    sql.exec(
      "update receipts set state = 'refused', reason = 'closed', final_at = ? where id = ? and state = 'pending'",
      now,
      msgId,
    );
  finalizeKey(sql, msgId);
  // A notice's body stays for fetch (#fetch deletes it); B7's expiry sweep
  // deletes it otherwise.
  if (outcome === "refused" || r.size <= LIMITS.inlineBodyBytes)
    sql.exec("delete from mail where id = ?", msgId);
  return r.fromAgent;
}

// ------------------------------------------------------------------- expiry
//
// One alarm serves every deadline (B7). Each step touches at most BATCH rows
// through an index; a full batch re-arms at now + 1 instead of looping, so a
// run stays inside the Workers Free CPU budget.

/**
 * Rows one alarm step (or one replay, flush or close) handles before
 * re-arming at now + 1. 50 keeps a notify-heavy run well inside the ~10 ms
 * CPU budget (200 expiries plus notifies measured ~9 ms locally). It equals
 * inboxCap, so one batch covers an agent's whole inbox.
 */
export const SWEEP_BATCH = 50;
const BATCH = SWEEP_BATCH;
/**
 * The persisted revoke drain (B9, B11): one meta row per revoked machine whose
 * agents still need their inboxes expired, keyed DRAIN_PREFIX + machine id;
 * the value is the rowid of the last agent fully drained. Ranges on meta's
 * primary key: DRAIN_END is the first key past the prefix.
 */
const DRAIN_PREFIX = "revoke_drain:";
const DRAIN_END = "revoke_drain;";
/**
 * The persisted close drain (B11): one meta row per closed agent whose old
 * session still has pending mail or stored notice bodies past the inline
 * batch, keyed CLOSE_PREFIX + agent id; the value is the close time. Only
 * receipts created at or before it are touched, so a session reopened under
 * the same ref mid-drain keeps its own new mail.
 */
const CLOSE_PREFIX = "close_drain:";
/**
 * Pending expiries (and, separately, notice-body deletes) one sessions{closed}
 * or agent_down frame spends inline (B11); the rest goes to the close drain.
 * Lower than SWEEP_BATCH: the frame also closes up to maxAgentsPerMachine
 * agents and queues them, and the worst case (1000 refs, 200 live, 10,000
 * pending) must stay near the ~10 ms Workers Free CPU budget. Measured
 * locally by hub.b11.test.ts ("B11 measure").
 */
export const CLOSE_INLINE_BATCH = 10;
const CLOSE_END = "close_drain;";
/** Final receipts are kept this long after the sender was told (or, untold, past expiry). */
const RETAIN_MS = 24 * HOUR_MS;
/**
 * B14: how long a send key (sender agent id, send frame id) dedupes. At least
 * LIMITS.mailTtlSec (the contract's 1 h); twice it, so a resend that comes
 * just after the message expired still gets its `expired` receipt instead of
 * sending again. A receipt outlives its key: it stays pending at most
 * mailTtlSec, then is kept RETAIN_MS (24 h) past final or told.
 */
export const SEND_KEY_RETAIN_MS = 2 * LIMITS.mailTtlSec * 1000;
/**
 * B14: send keys kept per sender agent (inboxCap x 4). A new key past the cap
 * evicts that agent's oldest key whose send is final (delivered, expired or
 * refused), never a pending one, so a pending send is never delivered twice.
 * With every key pending (the agent has this many undelivered sends in
 * flight) the new send is refused `rate_limited` (SEND_KEYS_MESSAGE).
 * Trade-off: an evicted final send loses its dedupe (a late resend of it
 * sends again); a legitimate flood is already limited by the B11 frame
 * budget and the recipients' inbox caps.
 */
export const SEND_KEYS_PER_AGENT = LIMITS.inboxCap * 4;
/**
 * B14: send keys kept hub-wide. Agent ids are per (machine, native_ref) and
 * never deleted, so ref churn would multiply the per-agent cap; this bounds
 * the table. Same rule: evict the hub's oldest final key (send_keys_final, no scan
 * limit: refused only when no key anywhere is final), else `rate_limited`.
 */
export const SEND_KEYS_TOTAL = 20_000;
/** The `rate_limited` message for a send refused at a send-key cap. */
export const SEND_KEYS_MESSAGE = "Too many sends in flight";
/**
 * Final review M1: a closed agent (live = 0) with no work left is deleted by
 * the alarm this long after it closed (updated_at). No work: no pending
 * receipt to or from it, no mail row to it, no send key within
 * SEND_KEY_RETAIN_MS and no final receipt it was never told about
 * (IDLE_AGENT_SQL). Agent ids are random (newId) and never reused, so a ref
 * that comes back after its row was purged gets a new id.
 */
export const CLOSED_AGENT_RETAIN_MS = 24 * HOUR_MS;
/**
 * Final review M1: closed agents kept per machine. A new agent_up (a ref the
 * machine has no row for) at the cap first purges that machine's oldest idle
 * closed agent inline, whatever its age, searching all of its closed agents;
 * with none idle it is refused `rate_limited` with the pinned
 * AGENT_CAP_MESSAGES.machine (clients match on those constants). So ref
 * churn by one machine token holder never grows the table past the cap.
 */
export const CLOSED_AGENTS_PER_MACHINE = 1000;
/**
 * The alarm's purge pass over closed agents (agents_closed order): the
 * cursor ({u: updated_at, r: rowid, kept}) while a pass is under way, and
 * the time before which no new pass starts once a pass ended with agents
 * kept for their work (their own deadlines clear it; the retry stops the
 * alarm from spinning on them).
 */
const AGENT_PURGE_KEY = "agent_purge";
const AGENT_PURGE_RETRY_KEY = "agent_purge_retry";
const AGENT_PURGE_RETRY_MS = HOUR_MS;
/**
 * True (1) when closed agent `a` has no work left. One parameter: the send
 * key cutoff (now - SEND_KEY_RETAIN_MS). Each probe is one indexed lookup.
 */
const IDLE_AGENT_SQL = `(not exists (select 1 from receipts r indexed by receipts_to where r.to_agent = a.id and r.state = 'pending')
  and not exists (select 1 from receipts r indexed by receipts_from_pending where r.from_agent = a.id and r.state = 'pending')
  and not exists (select 1 from mail m indexed by mail_to where m.to_agent = a.id)
  and not exists (select 1 from send_keys k indexed by send_keys_agent where k.from_agent = a.id and k.created_at >= ?)
  and not exists (select 1 from receipts r indexed by receipts_unnotified where r.from_agent = a.id and r.notified_at is null and r.state != 'pending'))`;
/** Device codes are purged this long past expiry. */
const DEVICE_CODE_GRACE_MS = 24 * HOUR_MS;

const isRefusalReason = (r: string | null): r is RefusalReason =>
  (REFUSAL_REASONS as readonly (string | null)[]).includes(r);

/** The receipt_update for a final state as stored, or null if the row is not final. */
function updateFrame(
  msgId: string,
  state: string,
  reason: string | null,
): ServerFrame | null {
  const base = {
    v: 1,
    id: frameId(),
    type: "receipt_update",
    msg_id: msgId,
  } as const;
  if (state === "delivered") return { ...base, state };
  // A revoked recipient is gone: the wire says recipient_closed; the row keeps `revoked` for audit.
  if (state === "expired")
    return reason === "recipient_closed" || reason === "revoked"
      ? { ...base, state, reason: "recipient_closed" }
      : { ...base, state };
  if (state === "refused" && isRefusalReason(reason))
    return { ...base, state, reason };
  return null;
}

/**
 * Runs a bounded `delete ... where rowid in (select rowid ... limit ?)
 * returning rowid` with BATCH as the last parameter; true if the batch was full.
 */
function purge(sql: SqlStorage, q: string, ...b: SqlStorageValue[]): boolean {
  return all(sql, q, ...b, BATCH).length >= BATCH;
}

/** The one not_found detail for fetch, whatever the cause. */
const FETCH_NOT_FOUND = "No such message";

/** A frame that names a sender must name an agent this socket registered. */
function senderRef(f: ClientFrame): string | null {
  return f.type === "send" ||
    f.type === "list" ||
    f.type === "fetch" ||
    f.type === "status" ||
    f.type === "card_request"
    ? f.from_ref
    : null;
}

/**
 * The hub: one SQLite Durable Object per owner. B3 holds machines and the
 * auth storage B1/B1b call; later tasks add the socket, mail and alarm paths.
 *
 * Every method on this class is on the RPC surface; the test allowlist in
 * hub.machines.test.ts pins it. Helpers live outside the class.
 */
export class Hub extends DurableObject<Env> {
  /** A frozen clock for tests; null in production. Never on the RPC surface. */
  #clock: number | null = null;

  /**
   * Tests only, inside `runInDurableObject`. Static, so it is not on the
   * prototype and a stub cannot call it over RPC.
   */
  static setTestClock(hub: Hub, ms: number | null): void {
    hub.#clock = ms;
  }

  /** Card secrets over this.env, for tests (AC4c); null in production. */
  #testCardEnv: Partial<Env> | null = null;
  /** Tests: card signing waits for this before re-checking the socket. */
  #cardHold: Promise<void> | null = null;
  /** Card replies being signed (awaited by webSocketMessage). */
  #cardsInFlight = new Set<Promise<void>>();

  static setCardEnvForTests(hub: Hub, env: Partial<Env> | null): void {
    hub.#testCardEnv = env;
  }

  static holdCardsForTests(hub: Hub, p: Promise<void> | null): void {
    hub.#cardHold = p;
  }

  static cardsSettledForTests(hub: Hub): Promise<void> {
    return Promise.all(hub.#cardsInFlight).then(() => undefined);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Every socket (daemon and dashboard) gets "pong" for "ping" from the
    // runtime, without waking the hub; set here so a fresh hub with no
    // daemon still answers a dashboard's keepalive.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(HUB_SCHEMA);
      migrateHub(ctx.storage.sql);
      await this.#armOnWake();
    });
  }

  #now(): number {
    return this.#clock ?? Date.now();
  }

  /**
   * On wake, when work exists (pending mail, a stored body or an untold
   * final receipt) but no alarm is set, arm for its earliest deadline. One
   * indexed exists query; covers hubs whose rows never armed (B6-era).
   */
  async #armOnWake(): Promise<void> {
    const work = one<{ x: number }>(
      this.ctx.storage.sql,
      `select (exists (select 1 from receipts where state = 'pending')
            or exists (select 1 from mail)
            or exists (select 1 from send_keys)
            or exists (select 1 from receipts where notified_at is null and state != 'pending')
            or exists (select 1 from agents indexed by agents_closed where live = 0)
            or exists (select 1 from agents indexed by agents_status_due where status_due is not null)
            or exists (select 1 from meta where org_id = ? and key >= ? and key < ?)
            or exists (select 1 from meta where org_id = ? and key >= ? and key < ?)) as x`,
      OWNER_ORG_ID,
      DRAIN_PREFIX,
      DRAIN_END,
      OWNER_ORG_ID,
      CLOSE_PREFIX,
      CLOSE_END,
    );
    if (!work?.x) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    const at = this.#nextDeadline(null);
    const t = at === null ? null : alarmTime(Math.max(at, this.#now() + 1));
    if (t !== null) await this.ctx.storage.setAlarm(t);
  }

  /**
   * Inline bodies pushed and not yet acked, by msg_id, with their charged
   * bytes and when they were pushed (`at`, mirrored in receipts.held_at). In
   * memory only, at most HELD_BYTES_CAP in total. The alarm moves a body to
   * `mail` once its ack is ackTimeoutMs late; a body lost to an eviction
   * before then is found by held_at and its receipt expires (never delivered).
   */
  #held = new Map<string, Held>();
  #heldBytes = 0;
  /** The earliest alarm time asked for while handling one event; committed after it. */
  #armWant: number | null = null;
  /**
   * Senders whose missed receipt_updates did not fit one replay batch; the
   * alarm sends the rest. Lost on eviction: the next agent_up replays again.
   */
  #replayQueue = new Set<string>();
  /** FRAME_BUDGET buckets by machine id (in memory; a wake clears them). */
  #machineBudgets = new Map<string, Budget>();
  /** DASHBOARD_FRAME_BUDGET buckets per dashboard socket. */
  #dashboardBudgets = new WeakMap<WebSocket, Budget>();
  /** Sockets already closed (and logged) for their budget. */
  #rateClosed = new WeakSet<WebSocket>();

  /** The hub-wide send-key cap (SEND_KEYS_TOTAL; tests may lower it). */
  #sendKeysCap = SEND_KEYS_TOTAL;
  /**
   * Rows in send_keys, counted once on first need and then kept by every
   * insert and delete here (null: count again; the alarm sweep resets it).
   */
  #sendKeys: number | null = null;

  /** Tests only: static, so not on the RPC surface. */
  static heldStats(hub: Hub): { bytes: number; ids: string[] } {
    return { bytes: hub.#heldBytes, ids: [...hub.#held.keys()] };
  }

  /**
   * Tests only (static, not RPC): sets a socket's FRAME_BUDGET tokens, so a
   * test can start near empty instead of sending a whole burst first.
   */
  static setFrameTokensForTests(hub: Hub, ws: WebSocket, tokens: number): void {
    const b = { tokens, at: hub.#now(), cooldownUntil: 0 };
    const machineId = machineOf(ws);
    if (machineId === null) hub.#dashboardBudgets.set(ws, b);
    else hub.#machineBudgets.set(machineId, b);
  }

  /**
   * Tests only (static, not RPC): the hub-wide send-key cap (null:
   * SEND_KEYS_TOTAL); also drops the cached count, so a test may edit
   * send_keys directly.
   */
  static setSendKeysTotalForTests(hub: Hub, cap: number | null): void {
    hub.#sendKeysCap = cap ?? SEND_KEYS_TOTAL;
    hub.#sendKeys = null;
  }

  /** Tests only (static, not RPC): the closed-agent cap check (#roomForClosed). */
  static roomForClosedForTests(
    hub: Hub,
    machineId: string,
    ref: string,
  ): boolean {
    return hub.#roomForClosed(machineId, ref);
  }

  /** Tests only (static, not RPC): an eviction drops every held body. */
  static dropHeldForTests(hub: Hub): void {
    hub.#held.clear();
    hub.#heldBytes = 0;
  }

  // ---------------------------------------------------------------- machines

  /**
   * Called by the device flow once a user code is approved. The label must
   * already pass MachineLabelSchema (callers sanitize with newMachineLabel);
   * an invalid label or id throws (a programmer error). At MAX_ACTIVE_MACHINES
   * active machines it returns `{ ok: false, code: "machine_limit" }`.
   * Stores only the token's SHA-256 and returns the token once.
   */
  async createMachine(
    label: string,
    id: string = newId(),
  ): Promise<CreateMachineResult> {
    if (!MachineLabelSchema.safeParse(label).success)
      throw new Error("invalid machine label");
    if (!isId(id)) throw new Error("invalid machine id");
    const token = newMachineToken();
    // The only await is here, before the cap check: the check and the insert
    // below are one synchronous step, so concurrent creates cannot both pass.
    const tokenHash = await sha256Hex(token);
    const sql = this.ctx.storage.sql;
    const active = one<{ n: number }>(
      sql,
      "select count(*) as n from machines where org_id = ? and (revoked_at is null) = 1",
      OWNER_ORG_ID,
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_MACHINES)
      return { ok: false, code: "machine_limit" };
    sql.exec(
      "insert into machines (id, org_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
      id,
      OWNER_ORG_ID,
      label,
      tokenHash,
      this.#now(),
    );
    this.#notifyDashboards();
    await this.#commitArm();
    return { ok: true, id, label, token };
  }

  /** One lookup per WebSocket upgrade; last_used is throttled to once an hour. */
  async verifyToken(
    tokenHash: string,
  ): Promise<{ id: string; label: string } | null> {
    const sql = this.ctx.storage.sql;
    const row = one<{
      id: string;
      label: string;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>(
      sql,
      "select id, label, revoked_at as revokedAt, last_used as lastUsedAt from machines where token_hash = ? and org_id = ? limit 1",
      tokenHash,
      OWNER_ORG_ID,
    );
    if (!row || row.revokedAt !== null) return null;
    const now = this.#now();
    if (row.lastUsedAt === null || row.lastUsedAt < now - HOUR_MS)
      sql.exec("update machines set last_used = ? where id = ?", now, row.id);
    return { id: row.id, label: row.label };
  }

  /**
   * Active machines newest first, then revoked newest first, at most
   * maxMachinesListed. Active machines are capped at the same number, so every
   * active machine is always listed.
   */
  async listMachines(): Promise<MachineRow[]> {
    return machineRows(this.ctx);
  }

  /** Every role (AC2b), with its holder while it holds it (hub/roles.ts). */
  async listRoles(): Promise<RoleRow[]> {
    return roleRows(this.ctx.storage.sql);
  }

  /**
   * Points role `role` in `ns` at `agentId` (setRole; the caller validates
   * the values). On "ok", roster_changed reaches the role's namespace and
   * the old and new holders', and the dashboards are told.
   */
  async putRole(
    ns: string,
    role: string,
    agentId: string,
  ): Promise<SetRoleResult> {
    const sql = this.ctx.storage.sql;
    const before = roleHolderId(sql, ns, role);
    const r = setRole(sql, ns, role, agentId, this.#now());
    if (r === "ok")
      await this.#rolesChanged(roleChange(sql, ns, [before, agentId]));
    return r;
  }

  /** Removes role `role` (any case) from `ns`; false when there was none. */
  async deleteRole(ns: string, role: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const before = roleHolderId(sql, ns, role);
    if (!dropRole(sql, ns, role)) return false;
    await this.#rolesChanged(roleChange(sql, ns, [before]));
    return true;
  }

  async #rolesChanged(change: RosterChange): Promise<void> {
    notifyRoster(this.ctx, change);
    this.#notifyDashboards();
    await this.#commitArm();
  }

  /**
   * The dashboard's agents (B10): open agents of unrevoked machines, live
   * while the machine's daemon is connected, queued otherwise. With a
   * namespace, that namespace's agents plus every global; without, all.
   * Ordered by namespace, then name case-insensitively; at most
   * maxRosterAgents. An invalid namespace returns [] (never throws).
   *
   * `undefined` (or no argument) means all agents. Over RPC `null` is not
   * `undefined`: `null`, `""` and any other non-namespace return [].
   * Rows that fail AgentSchema are skipped (logged, without contents).
   */
  async listAgents(namespace?: string): Promise<Agent[]> {
    if (namespace === undefined) return agentList(this.ctx);
    if (!WireNamespaceSchema.safeParse(namespace).success) return [];
    return agentList(this.ctx, namespace);
  }

  /**
   * Linked apps (AC4b). `aud` must be a canonical origin (parseOrigin);
   * anything else is false with no side effects. linkApp: true when linked
   * afterwards (a relink keeps its first linked_at), false for a new app at
   * MAX_LINKED_APPS. unlinkApp: true when it removed a link.
   */
  async linkApp(aud: string): Promise<boolean> {
    return (
      this.#canonical(aud) &&
      linked.linkApp(this.ctx.storage.sql, aud, this.#now())
    );
  }

  /** Newest first, at most MAX_LINKED_APPS; linkedAt in epoch ms. */
  async listLinkedApps(): Promise<linked.LinkedAppRow[]> {
    return linked.listLinkedApps(this.ctx.storage.sql);
  }

  async unlinkApp(aud: string): Promise<boolean> {
    return this.#canonical(aud) && linked.unlinkApp(this.ctx.storage.sql, aud);
  }

  #canonical(aud: unknown): aud is string {
    return typeof aud === "string" && parseOrigin(aud, this.env) === aud;
  }

  /**
   * Revokes a machine (B9): true the first time; false, with no side effects,
   * for a malformed, unknown or already-revoked id. Its daemon sockets are
   * marked dead and closed with 4403, its open agents close (dropped from
   * every roster and the dashboard), pending mail to them expires (reason
   * `revoked`, bodies and held bytes dropped, each sender told once now or on
   * replay) and acked notices lose their bodies. Mail its agents sent is left
   * alone. One roster_changed per affected namespace, one dashboard push.
   *
   * Bounded: the machine is queued in meta (DRAIN_PREFIX) and one
   * #drainRevoked step runs here; the alarm drains the rest from that
   * persisted queue, so neither an eviction mid-drain nor the agent count
   * leaves an inbox to the TTL sweep.
   */
  async revokeMachine(id: string): Promise<boolean> {
    if (typeof id !== "string" || !isMachineId(id)) return false;
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const res = sql.exec(
      "update machines set revoked_at = ? where id = ? and org_id = ? and revoked_at is null",
      now,
      id,
      OWNER_ORG_ID,
    );
    if (res.rowsWritten === 0) return false;

    // Marked first (as a replaced socket is), so a frame still in flight is
    // never processed and the close that lands later runs no bookkeeping.
    for (const ws of this.ctx.getWebSockets(id)) {
      try {
        ws.serializeAttachment({
          machineId: id,
          revoked: true,
        } satisfies Attachment);
      } catch {
        // Already closed.
      }
      closeSocket(ws, LIMITS.revokeCloseCode, "machine revoked");
    }

    // The roster change is read while the agents are still open.
    const change = machineChange(sql, id);
    // M2: the drain walks the agents open at the revoke (agents_machine, at
    // most maxAgentsPerMachine), never the machine's closed history. A
    // closed agent's leftover mail is the close drain's (#closeSessions
    // queued it at its close), so only these can still receive.
    const ids = sql
      .exec(
        `update agents set live = 0, last_name = name, updated_at = ?, ${STATUS_CLEAR} where machine_id = ? and live = 1 returning id`,
        now,
        id,
      )
      .toArray()
      .map((r) => String(r.id));
    vacateRoles(sql, ids);
    sql.exec(
      "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do nothing",
      OWNER_ORG_ID,
      DRAIN_PREFIX + id,
      JSON.stringify({ ids }),
    );
    this.#arm(now + CLOSED_AGENT_RETAIN_MS);
    logEvent("machine_revoked", { machineId: id });
    this.#machineBudgets.delete(id);
    if (this.#drainRevoked()) this.#arm(now + 1);

    notifyRoster(this.ctx, change);
    this.#notifyDashboards();
    await this.#commitArm();
    return true;
  }

  // ----------------------------------------------------------------- sockets
  // DurableObject handlers. workerd reserves these names: a stub cannot call
  // them over RPC (DurableObjectStub omits them).

  /**
   * The Worker's /hub route forwards a verified upgrade here with only
   * `Upgrade` and `X-Ob-Machine-Id` (never the client's headers).
   */
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === EVENTS_DO_PATH) return this.#acceptDashboard(req);
    if (path !== "/hub") return new Response("Not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const machineId = req.headers.get("X-Ob-Machine-Id") ?? "";
    if (!activeMachine(this.ctx, machineId)) {
      logEvent("hub_reject", { code: "unauthorized", machineId });
      return new Response("Unknown machine", { status: 401 });
    }
    // Closed with 4429 within the cooldown: refused before any socket is
    // accepted, for daemons that do not back off.
    const cooldown = this.#machineBudgets.get(machineId)?.cooldownUntil ?? 0;
    if (cooldown > this.#now()) {
      logEvent("hub_reject", { code: "rate_limited", machineId });
      return new Response("rate limited", {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((cooldown - this.#now()) / 1000)),
        },
      });
    }

    // One socket per machine: a reconnect replaces the previous one. The old
    // socket is marked dead first, so frames it still sends are ignored.
    const wasOnline = machineOnline(this.ctx, machineId);
    for (const old of this.ctx.getWebSockets(machineId)) {
      try {
        old.serializeAttachment({
          machineId,
          replaced: true,
        } satisfies Attachment);
      } catch {
        // Already closed.
      }
      closeSocket(old, 1000, "replaced");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [DAEMON_TAG, machineId]);
    server.serializeAttachment({ machineId } satisfies Attachment);
    // The machine's open agents flip from queued to live.
    if (!wasOnline) {
      notifyRoster(
        this.ctx,
        machineChange(this.ctx.storage.sql, machineId),
        server,
      );
      this.#notifyDashboards();
    }
    await this.#commitArm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (this.#overBudget(ws)) return;
    // Dashboards only listen: whatever they send is dropped, never decoded
    // ("ping" is answered by the auto-response before the hub wakes).
    if (notDaemon(this.ctx, ws)) return;
    const card = this.#onMessage(ws, message);
    await this.#commitArm();
    if (card) await card;
  }

  /**
   * Takes one token from the frame's bucket (the machine's FRAME_BUDGET, or
   * the dashboard socket's DASHBOARD_FRAME_BUDGET); with none left, closes
   * the socket (4429 "rate limited", logged once per socket), starts the
   * machine's reconnect cooldown and returns true.
   */
  #overBudget(ws: WebSocket): boolean {
    const now = this.#now();
    const machineId = machineOf(ws);
    let ok: boolean;
    if (machineId === null) {
      let b = this.#dashboardBudgets.get(ws);
      if (!b) {
        b = { tokens: DASHBOARD_FRAME_BUDGET.burst, at: now, cooldownUntil: 0 };
        this.#dashboardBudgets.set(ws, b);
      }
      ok =
        !this.#rateClosed.has(ws) && takeToken(b, now, DASHBOARD_FRAME_BUDGET);
    } else {
      const b = this.#machineBudget(machineId, now);
      ok = !this.#rateClosed.has(ws) && takeToken(b, now, FRAME_BUDGET);
      // The cooldown starts when this socket trips, not on its late frames.
      if (!ok && !this.#rateClosed.has(ws))
        b.cooldownUntil = now + LIMITS.rateLimitCooldownMs;
    }
    if (ok) return false;
    if (!this.#rateClosed.has(ws)) {
      this.#rateClosed.add(ws);
      logEvent(
        "rate_limited",
        machineId === null
          ? { kind: "dashboard_frames" }
          : { kind: "frames", machineId },
      );
    }
    closeSocket(ws, LIMITS.rateLimitCloseCode, "rate limited");
    return true;
  }

  #machineBudget(machineId: string, now: number): Budget {
    let b = this.#machineBudgets.get(machineId);
    if (!b) {
      b = { tokens: FRAME_BUDGET.burst, at: now, cooldownUntil: 0 };
      this.#machineBudgets.set(machineId, b);
    }
    return b;
  }

  /** Returns the pending card reply (AC4c), if any; it never rejects. */
  #onMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> | undefined {
    // A replaced socket is dead: nothing it sends is processed.
    if (isRevokedSocket(ws)) {
      closeSocket(ws, LIMITS.revokeCloseCode, "machine revoked");
      return;
    }
    if (isReplaced(ws)) {
      closeSocket(ws, 1000, "replaced");
      return;
    }
    const machineId = machineOf(ws);
    // revokeMachine marks and closes this machine's sockets (above); this
    // check covers a revoke whose socket was never marked (not expected).
    const machine = machineId ? activeMachine(this.ctx, machineId) : null;
    if (!machineId || !machine) {
      closeSocket(ws, LIMITS.revokeCloseCode, "machine revoked");
      return;
    }
    if (typeof message !== "string") {
      reject(ws, machineId, undefined, "bad_frame", "Text frames only");
      return;
    }
    if (message === PING) {
      // Normally answered by the auto-response before the hub wakes.
      try {
        ws.send(PONG);
      } catch {
        // Closing.
      }
      return;
    }
    const res = decodeClientFrame(message);
    // A card_request the strict schema refused only for its nonce or aud is
    // still answered card_refused (hub/card.ts).
    const lax =
      !res.ok && res.error === "bad_frame" && res.id !== undefined
        ? laxCardRequest(message)
        : null;
    if (!res.ok && !lax) {
      reject(ws, machineId, res.id, res.error, "Unreadable frame");
      return;
    }
    const f: ClientFrame | CardRequest = res.ok
      ? res.frame
      : (lax as CardRequest);
    const sql = this.ctx.storage.sql;

    // AC4c, check 1, before the attestation: below the gate a daemon cannot
    // decode `card` or `card_refused`.
    if (f.type === "card_request" && !gated(ws)) {
      reject(
        ws,
        machineId,
        f.id,
        "bad_frame",
        "card_request needs a newer client",
      );
      return;
    }

    // Review Focus 1: a socket acts only for agents it registered itself.
    const ref = senderRef(f);
    const sender = ref === null ? null : registeredAgent(sql, machineId, ref);
    if (ref !== null && !sender) {
      reject(
        ws,
        machineId,
        f.id,
        "not_registered",
        "from_ref is not registered on this socket",
      );
      return;
    }

    switch (f.type) {
      case "hello":
        try {
          ws.serializeAttachment({
            machineId,
            clientVersion: f.client_version,
          } satisfies Attachment);
        } catch {
          // Closing; without a version the roster gate fails closed.
        }
        sendFrame(ws, {
          v: 1,
          id: f.id,
          type: "hello_ok",
          machine_id: machine.id,
          machine_label: machine.label,
          server_version: version(this.env),
        });
        return;
      case "sessions": {
        // Open sessions come back with their own agent_up; closed ones end.
        const change: RosterChange = { namespaces: [], global: false };
        // One statement closes every listed live agent (refs passed as one
        // JSON parameter, json_each; no per-ref query), then one bounded
        // inline batch and one queue row (B11).
        const downed = all<{ id: string; namespace: string; global: number }>(
          sql,
          `update agents set live = 0, last_name = name, updated_at = ?, ${STATUS_CLEAR}
            where machine_id = ? and live = 1 and org_id = ?
              and native_ref in (select value from json_each(?))
           returning id, namespace, global`,
          this.#now(),
          machineId,
          OWNER_ORG_ID,
          JSON.stringify(f.closed),
        );
        for (const a of downed) {
          change.namespaces.push(a.namespace);
          if (a.global === 1) change.global = true;
        }
        vacateRoles(
          sql,
          downed.map((a) => a.id),
        );
        this.#closeSessions(downed.map((a) => a.id));
        notifyRoster(this.ctx, change, ws);
        if (change.namespaces.length > 0) this.#notifyDashboards();
        return;
      }
      case "agent_up": {
        const cap = capRefusal(sql, machineId, f.agent_ref);
        if (cap !== null) {
          logEvent("cap_refused", { kind: cap, machineId });
          sendError(ws, f.id, "rate_limited", AGENT_CAP_MESSAGES[cap]);
          return;
        }
        if (!this.#roomForClosed(machineId, f.agent_ref)) {
          logEvent("cap_refused", { kind: "closed", machineId });
          sendError(ws, f.id, "rate_limited", AGENT_CAP_MESSAGES.machine);
          return;
        }
        const { reply, change, rowChanged } = agentUp(
          sql,
          machineId,
          f,
          this.#now(),
        );
        sendFrame(ws, reply);
        notifyRoster(this.ctx, change, ws);
        if (rowChanged) this.#notifyDashboards();
        const a = registeredAgent(sql, machineId, f.agent_ref);
        if (a) {
          // Its queued mail, then what it missed as a sender.
          this.#flush(ws, a);
          if (this.#replay(a.id)) {
            this.#replayQueue.add(a.id);
            this.#arm(this.#now() + 1);
          }
        }
        return;
      }
      case "agent_down": {
        const a = agentDown(sql, machineId, f.agent_ref, this.#now());
        if (a === null) return;
        this.#closeSessions([a.id]);
        notifyRoster(
          this.ctx,
          { namespaces: [a.namespace], global: a.global === 1 },
          ws,
        );
        this.#notifyDashboards();
        return;
      }
      case "list":
        if (sender)
          sendFrame(
            ws,
            roster(this.ctx, sender, f.id, preTokenKinds(ws), gated(ws)),
          );
        return;
      case "send":
        if (sender) this.#send(ws, f, sender);
        return;
      case "ack":
      case "refuse":
        // No reply either way: anything but the recipient's own pending mail
        // is silently ignored.
        this.#settle(
          machineId,
          f.msg_id,
          f.type === "ack" ? "delivered" : "refused",
        );
        return;
      case "fetch":
        if (sender) this.#fetch(ws, f, sender, machineId);
        return;
      case "status":
        if (sender) this.#status(ws, f, sender);
        return;
      case "card_request":
        return sender
          ? this.#card(ws, machineId, machine.label, f, sender)
          : undefined;
    }
  }

  /**
   * `card_request` (AC4c), past the gate and the attestation: card_refused
   * now, or the card once signed. After the await the reply goes out only
   * if `ws` is still the machine's live socket (not replaced or revoked).
   */
  #card(
    ws: WebSocket,
    machineId: string,
    machineLabel: string,
    f: CardRequest,
    sender: AgentRow,
  ): Promise<void> | undefined {
    const env = this.#testCardEnv
      ? { ...this.env, ...this.#testCardEnv }
      : this.env;
    const r = issueCard(
      this.ctx.storage.sql,
      env,
      sender,
      machineLabel,
      f,
      this.#now(),
    );
    if ("code" in r) {
      sendFrame(ws, { v: 1, id: f.id, type: "card_refused", code: r.code });
      return undefined;
    }
    const hold = this.#cardHold;
    const done = (async () => {
      const jwt = await r.jwt;
      if (hold) await hold;
      // Still this machine's live socket, still gated, the agent still open
      // and saying what the card says; else nothing (it has no session to
      // answer). An aud unlinked meanwhile is refused as a new request is.
      const sql = this.ctx.storage.sql;
      if (
        liveSocket(this.ctx, machineId) !== ws ||
        !activeMachine(this.ctx, machineId) ||
        !gated(ws)
      )
        return;
      const agent = registeredAgent(sql, machineId, f.from_ref);
      if (agent?.id !== sender.id || !stillTrue(sql, agent, r.snap)) return;
      if (!linked.isLinked(sql, f.aud))
        sendFrame(ws, {
          v: 1,
          id: f.id,
          type: "card_refused",
          code: "not_linked",
        });
      else if (jwt === null)
        sendError(ws, f.id, "internal", "Cannot sign a card");
      else sendFrame(ws, { v: 1, id: f.id, type: "card", jwt });
    })()
      .catch(() => {
        // Never unhandled: the daemon's request times out.
      })
      .finally(() => this.#cardsInFlight.delete(done));
    this.#cardsInFlight.add(done);
    return done;
  }

  /**
   * A `status` frame (AC3). No reply on success. Applied now: roster_changed
   * and a dashboard push. Coalesced: the alarm applies it when due.
   */
  #status(
    ws: WebSocket,
    f: Extract<ClientFrame, { type: "status" }>,
    sender: AgentRow,
  ): void {
    const r = applyStatus(
      this.ctx.storage.sql,
      sender.id,
      { state: f.state, ...(f.label === undefined ? {} : { label: f.label }) },
      this.#now(),
    );
    if (r.applied) this.#statusChanged([sender], ws);
    else if (r.due !== null) this.#arm(r.due);
  }

  /** Applied status changes: one roster_changed per namespace, one dashboard push. */
  #statusChanged(
    changed: Pick<StatusChange, "namespace" | "global">[],
    except?: WebSocket,
  ): void {
    if (changed.length === 0) return;
    notifyRoster(
      this.ctx,
      {
        namespaces: changed.map((c) => c.namespace),
        global: changed.some((c) => c.global === 1),
      },
      except,
    );
    this.#notifyDashboards();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005/1006 are never sent on the wire.
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
    // A dashboard's close runs no daemon or machine bookkeeping.
    if (notDaemon(this.ctx, ws)) return;
    this.#socketGone(ws);
    await this.#commitArm();
  }

  override async webSocketError(
    ws: WebSocket,
    _error?: unknown,
  ): Promise<void> {
    // Closed first, as in webSocketClose: a socket left OPEN would still count
    // as connected (machineOnline) in the push #socketGone triggers.
    closeSocket(ws, 1011, "error");
    if (notDaemon(this.ctx, ws)) return;
    this.#socketGone(ws);
    await this.#commitArm();
  }

  /**
   * The machine's open agents flip to queued. They stay open: their sessions
   * may still be running (sessions{closed} and agent_down end them).
   */
  #socketGone(ws: WebSocket): void {
    const machineId = machineOf(ws);
    if (!machineId || isReplaced(ws)) return;
    if (machineOnline(this.ctx, machineId, ws)) return;
    notifyRoster(this.ctx, machineChange(this.ctx.storage.sql, machineId), ws);
    this.#notifyDashboards();
  }

  // -------------------------------------------------------------- dashboards

  /** True while a push is queued for this turn's microtask (coalescing). */
  #dashboardPushPending = false;
  /**
   * When the last push went out. In memory: after an eviction the next push
   * goes out at once (one extra push at most).
   */
  #lastPushAt: number | null = null;
  /** Mirror of the persisted PUSH_DUE_KEY this instance wrote; null if none. */
  #pushDue: number | null = null;

  /**
   * GET /events (B10-ws): the dashboard's WebSocket feed. No session check
   * here: the hub is reachable only through the Worker (stub.fetch), and the
   * Worker's /api/v1/events route checks the session and Origin, then sets
   * SESSION_EXP_HEADER and SESSION_GEN_HEADER. 426 without an upgrade; 400
   * when the expiry is missing, not a decimal of at most 16 digits, past, or
   * beyond now + max age + 1 min, or the generation is missing, malformed or
   * not the hub's current one.
   */
  async #acceptDashboard(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    // Everything is checked before acceptWebSocket: a refusal leaves no socket.
    const exp = parseSessionExp(
      req.headers.get(SESSION_EXP_HEADER),
      this.#now(),
    );
    if (exp === null)
      return new Response(`Missing or bad ${SESSION_EXP_HEADER}`, {
        status: 400,
      });
    // Read in this DO turn, so a bump that landed after the Worker's session
    // check (logout in another tab) is seen here: the socket is refused.
    const gen = parseDecimal(req.headers.get(SESSION_GEN_HEADER));
    if (gen === null || gen !== readSessionGeneration(this.ctx.storage.sql))
      return new Response(`Missing or stale ${SESSION_GEN_HEADER}`, {
        status: 400,
      });
    const existing = this.ctx.getWebSockets(DASHBOARD_TAG);
    if (existing.length >= MAX_DASHBOARDS) {
      // Non-open dashboards first (they free a slot without evicting anyone),
      // then the oldest open ones until there is room for this one.
      for (const w of existing)
        if (w.readyState !== OPEN) closeSocket(w, EVICT_CODE, "evicted");
      const open = existing
        .filter((w) => w.readyState === OPEN)
        .sort((a, b) => dashboardSeq(a) - dashboardSeq(b));
      for (const w of open.slice(
        0,
        Math.max(0, open.length - MAX_DASHBOARDS + 1),
      ))
        closeSocket(w, EVICT_CODE, "too many dashboards");
    }
    const seq = existing.reduce((n, w) => Math.max(n, dashboardSeq(w)), 0) + 1;
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [DASHBOARD_TAG]);
    server.serializeAttachment({
      dashboard: true,
      seq,
      exp,
      gen,
    } satisfies DashboardAttachment);
    // hello tells the dashboard to refetch; the full lists seed its caches.
    sendDashboard(server, JSON.stringify({ type: "hello" }));
    sendDashboard(
      server,
      JSON.stringify({ type: "machines", machines: machineList(this.ctx) }),
    );
    sendDashboard(
      server,
      JSON.stringify({ type: "agents", agents: agentList(this.ctx) }),
    );
    // The alarm closes it with 4401 at its expiry.
    this.#arm(exp);
    await this.#commitArm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Closes every dashboard socket whose session expiry has come (4401); with
   * `all`, every dashboard socket (the session generation was bumped).
   * Returns the open sockets left.
   */
  #closeEndedDashboards(all = false): WebSocket[] {
    const now = this.#now();
    const left: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets(DASHBOARD_TAG)) {
      if (all || dashboardExp(ws) <= now)
        closeSocket(ws, SESSION_CLOSE, "session ended");
      else if (ws.readyState === OPEN) left.push(ws);
    }
    return left;
  }

  /** The earliest session expiry among dashboard sockets (at most 16); null if none. */
  #nextDashboardExp(): number | null {
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets(DASHBOARD_TAG)) {
      if (ws.readyState !== OPEN) continue;
      const exp = dashboardExp(ws);
      if (next === null || exp < next) next = exp;
    }
    return next;
  }

  /**
   * Called only on a real change. Full machines and agents frames to every
   * dashboard, coalesced and throttled:
   * - at most once per turn: the first call queues a microtask, later ones in
   *   the same turn join it;
   * - at most once per DASHBOARD_PUSH_INTERVAL_MS: inside the window the due
   *   time is persisted (meta) and the multiplexed alarm armed for it (the
   *   caller commits the arm), so an eviction cannot lose the trailing push.
   * With no dashboards it runs no query at all.
   */
  #notifyDashboards(): void {
    if (this.#dashboardPushPending) return;
    if (this.ctx.getWebSockets(DASHBOARD_TAG).length === 0) return;
    const last = this.#lastPushAt;
    if (last !== null && this.#now() - last < DASHBOARD_PUSH_INTERVAL_MS) {
      const due = last + DASHBOARD_PUSH_INTERVAL_MS;
      if (this.#pushDue !== due) {
        writePushDue(this.ctx.storage.sql, due);
        this.#pushDue = due;
      }
      this.#arm(due);
      return;
    }
    this.#dashboardPushPending = true;
    queueMicrotask(() => {
      this.#dashboardPushPending = false;
      this.#pushDashboards();
    });
  }

  /**
   * Sends the push now (best effort) and clears any pending due time. A
   * socket past its session expiry is closed with 4401, never sent to.
   */
  #pushDashboards(): void {
    try {
      const sockets = this.#closeEndedDashboards();
      if (sockets.length === 0) return;
      this.#lastPushAt = this.#now();
      if (this.#pushDue !== null) {
        clearPushDue(this.ctx.storage.sql);
        this.#pushDue = null;
      }
      const payloads = [
        JSON.stringify({ type: "machines", machines: machineList(this.ctx) }),
        JSON.stringify({ type: "agents", agents: agentList(this.ctx) }),
      ];
      for (const ws of sockets)
        for (const p of payloads) {
          if (ws.readyState !== OPEN) break;
          sendDashboard(ws, p);
        }
    } catch {
      // Best effort: the next change pushes full lists again.
    }
  }

  // -------------------------------------------------------------------- mail

  /**
   * The receipt row is written before any delivery attempt, so a receipt never
   * claims more than happened. A refusal stores nothing, not even a send key
   * (B14): it delivered nothing, so a resend with the same id is evaluated
   * again.
   */
  #send(ws: WebSocket, f: SendFrame, sender: AgentRow): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    // B14: dedupe on (sender agent id, frame id) before anything else.
    const key = findSendKey(sql, sender, f, now);
    if (key.kind === "reused") {
      sendError(ws, f.id, "bad_frame", "frame id reused");
      return;
    }
    if (key.kind === "resend") {
      this.#resend(ws, f.id, key.msgId);
      return;
    }
    if (key.dropped && this.#sendKeys !== null) this.#sendKeys--;
    const res = resolveTarget(sql, sender, f.to_name, f.to_namespace);
    if (!res.ok) {
      refuseSend(ws, f.id, res.reason);
      return;
    }
    const target = res.agent;
    if (inboxFull(sql, target)) {
      refuseSend(ws, f.id, "inbox_full");
      return;
    }
    if (!this.#roomForKey(sender.id)) {
      sendError(ws, f.id, "rate_limited", SEND_KEYS_MESSAGE);
      return;
    }

    const msgId = newId();
    const size = utf8Bytes(f.body);
    const expiresAt = now + LIMITS.mailTtlSec * 1000;
    const socket = liveSocket(this.ctx, target.machineId);
    const inline = size <= LIMITS.inlineBodyBytes;
    // Held in memory only for an inline push to a live socket under the cap.
    const held = socket !== null && inline && this.#fits(size);
    sql.exec(
      `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, reason, size, created_at, expires_at, acked_at, held_at)
       values (?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, ?, null, ?)`,
      msgId,
      OWNER_ORG_ID,
      sender.namespace,
      target.id,
      target.name,
      sender.id,
      sender.name,
      size,
      now,
      expiresAt,
      held ? now : null,
    );
    insertSendKey(sql, sender.id, f.id, key.hash, msgId, now);
    if (this.#sendKeys !== null) this.#sendKeys++;
    this.#arm(now + SEND_KEY_RETAIN_MS + 1);
    // Write-on-miss: an offline machine (agent queued), an oversized body or
    // a full held cap is stored; only an inline push to a live socket is held.
    if (held) this.#hold(msgId, target.id, f.body, size, now, expiresAt, now);
    else storeBody(sql, msgId, target.id, f.body, now, expiresAt);
    this.#arm(expiresAt);
    if (held) this.#arm(now + LIMITS.ackTimeoutMs);
    sendFrame(ws, {
      v: 1,
      id: f.id,
      type: "receipt",
      msg_id: msgId,
      state: "pending",
      ...(gated(ws) ? { to_name: target.name } : {}),
    });
    if (!socket) return;

    const head = {
      v: 1,
      id: frameId(),
      type: "deliver",
      msg_id: msgId,
      to_ref: target.nativeRef,
      from_name: sender.name,
      namespace: sender.namespace,
    } as const;
    if (inline) sendFrame(socket, { ...head, body: f.body });
    else sendFrame(socket, { ...head, notice: { size, msg_id: msgId } });
  }

  /**
   * B14: makes room for one more send key under SEND_KEYS_PER_AGENT and
   * SEND_KEYS_TOTAL, evicting only final keys (see there). Both evictions are
   * looked up before either is deleted, so a refusal evicts nothing. False
   * (nothing changed) when a cap is reached and has no final key to drop.
   */
  #roomForKey(agentId: string): boolean {
    const sql = this.ctx.storage.sql;
    const evict = new Set<number>();
    const n =
      one<{ n: number }>(
        sql,
        "select count(*) as n from (select 1 from send_keys where from_agent = ? limit ?)",
        agentId,
        SEND_KEYS_PER_AGENT,
      )?.n ?? 0;
    if (n >= SEND_KEYS_PER_AGENT) {
      const k = one<{ k: number }>(sql, AGENT_FINAL_KEY_SQL, agentId)?.k;
      if (k === undefined) return false;
      evict.add(k);
    }
    this.#sendKeys ??=
      one<{ n: number }>(sql, "select count(*) as n from send_keys")?.n ?? 0;
    if (this.#sendKeys - evict.size >= this.#sendKeysCap) {
      const k = one<{ k: number }>(sql, HUB_FINAL_KEY_SQL)?.k;
      if (k === undefined) return false;
      evict.add(k);
    }
    for (const k of evict) {
      sql.exec("delete from send_keys where rowid = ?", k);
      this.#sendKeys--;
    }
    return true;
  }

  /**
   * B14: the reply to a resend of an accepted send, from its key and receipt
   * row; nothing is created, delivered, stored or sent to the recipient. The
   * original `receipt` (pending: the send receipt is only pending or refused
   * on the wire) and, once final, a `receipt_update` with the current state
   * (receipt_update is idempotent per msg_id; this may repeat one the sender
   * already got), which also marks the sender told. A receipt row missing
   * within the key's window (receipts outlive keys) would read as expired.
   */
  #resend(ws: WebSocket, id: string, msgId: string): void {
    const sql = this.ctx.storage.sql;
    const r = one<{
      state: string;
      reason: string | null;
      toName: string | null;
    }>(
      sql,
      "select state, reason, to_name as toName from receipts where id = ?",
      msgId,
    ) ?? { state: "expired", reason: null, toName: null };
    sendFrame(ws, {
      v: 1,
      id,
      type: "receipt",
      msg_id: msgId,
      state: "pending",
      ...(gated(ws) && r.toName !== null ? { to_name: r.toName } : {}),
    });
    const update = updateFrame(msgId, r.state, r.reason);
    if (!update) return;
    sendFrame(ws, update);
    sql.exec(
      "update receipts set notified_at = coalesce(notified_at, ?) where id = ?",
      this.#now(),
      msgId,
    );
  }

  /**
   * The recipient fetches a stored body. Served only to the receipt's own
   * agent, from `mail`, while pending or delivered (an acked notice keeps its
   * body until fetched); the row is deleted on the way out. Everything else
   * (someone else's mail, unknown or final ids, held inline bodies, a lost
   * body, a body or pending receipt past its deadline) gets the same
   * not_found, so the reply never shows whether the id exists. Past a
   * deadline the expiry is left to the alarm. A pending receipt becomes delivered through #settle, so the
   * sender is told once; a lost body is left to the alarm's lost-body and
   * TTL steps.
   */
  #fetch(
    ws: WebSocket,
    f: FetchFrame,
    sender: AgentRow,
    machineId: string,
  ): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const r = one<{ state: string; body: string }>(
      sql,
      `select r.state as state, m.body as body from receipts r join mail m on m.id = r.id
       where r.id = ? and r.org_id = ? and r.to_agent = ? and m.expires_at > ?
         and r.rowid > ?
         and (r.state = 'delivered' or (r.state = 'pending' and r.expires_at > ?))`,
      f.msg_id,
      OWNER_ORG_ID,
      sender.id,
      now,
      sender.sessionStartRowid,
      now,
    );
    if (!r) {
      sendError(ws, f.id, "not_found", FETCH_NOT_FOUND);
      return;
    }
    sendFrame(ws, {
      v: 1,
      id: f.id,
      type: "body",
      msg_id: f.msg_id,
      body: r.body,
    });
    if (r.state === "pending") this.#settle(machineId, f.msg_id, "delivered");
    sql.exec("delete from mail where id = ?", f.msg_id);
  }

  /** ack or refuse from `machineId`; tells the sender (now or on its next agent_up). */
  #settle(
    machineId: string,
    msgId: string,
    outcome: "delivered" | "refused",
  ): void {
    const from = settle(
      this.ctx.storage.sql,
      machineId,
      msgId,
      outcome,
      this.#now(),
    );
    if (from === null) return;
    this.#release(msgId);
    this.#tell(msgId, from, outcome, outcome === "refused" ? "closed" : null);
  }

  /**
   * Sends a final receipt_update to the sender's machine if it has a live
   * socket and records notified_at. With no socket notified_at stays null and
   * the update is replayed when the sender next registers (#replay).
   */
  #tell(
    msgId: string,
    fromAgent: string,
    state: "delivered" | "refused" | "expired",
    reason: string | null,
  ): void {
    const sql = this.ctx.storage.sql;
    const frame = updateFrame(msgId, state, reason);
    if (!frame) return;
    const m = one<{ machineId: string }>(
      sql,
      "select machine_id as machineId from agents where id = ?",
      fromAgent,
    );
    // N4 (accepted): a closed sender's machine is still told while online;
    // a session reopened later gets no replay (mail is not kept across it).
    const socket = m && liveSocket(this.ctx, m.machineId);
    if (!socket) return;
    sendFrame(socket, frame);
    sql.exec(
      "update receipts set notified_at = ? where id = ?",
      this.#now(),
      msgId,
    );
  }

  /**
   * pending -> expired, once: the guarded update is the only transition, so a
   * receipt is never expired (or the sender told) twice, and an expired one
   * never becomes delivered (settle also requires pending).
   */
  #expire(
    msgId: string,
    fromAgent: string,
    reason?: "recipient_closed" | "revoked",
  ): void {
    const sql = this.ctx.storage.sql;
    const hit = all(
      sql,
      "update receipts set state = 'expired', reason = ?, final_at = ? where id = ? and state = 'pending' returning id",
      reason ?? null,
      this.#now(),
      msgId,
    );
    if (hit.length === 0) return;
    finalizeKey(sql, msgId);
    sql.exec("delete from mail where id = ?", msgId);
    this.#release(msgId);
    this.#tell(msgId, fromAgent, "expired", reason ?? null);
  }

  /**
   * The agents' sessions ended (B11): their pending mail expires as
   * recipient_closed (spec "queue or refuse"), bodies dropped, and their acked
   * notices lose their bodies (the session that could fetch them is gone, and
   * a session reopened under the same ref must not read them; fetch also
   * checks the session). The receipts stay (delivered is true).
   *
   * Bounded: CLOSE_INLINE_BATCH expiries and as many body deletes inline,
   * for the whole call; every agent whose work may not be done is queued in
   * ONE meta row (CLOSE_PREFIX + close time + id, value
   * {"through": max receipts rowid at the close, "ids": [...]}) for the
   * alarm's close drain. The boundary is a rowid, not a timestamp (B11 L1):
   * a session reopened in the same millisecond starts past it.
   */
  #closeSessions(agentIds: string[]): void {
    if (agentIds.length === 0) return;
    const sql = this.ctx.storage.sql;
    const closedAt = this.#now();
    // M1: the closed rows' purge deadline.
    this.#arm(closedAt + CLOSED_AGENT_RETAIN_MS);
    // Rowid boundary (F3, accepted): relies on receipts rowids never being
    // renumbered; DO SQLite exposes no VACUUM, and the purge keeps the newest.
    const through =
      one<{ n: number | null }>(sql, "select max(rowid) as n from receipts")
        ?.n ?? 0;
    let receipts = CLOSE_INLINE_BATCH;
    let bodies = CLOSE_INLINE_BATCH;
    const left: string[] = [];
    for (const agentId of agentIds) {
      if (receipts === 0 || bodies === 0) {
        left.push(agentId);
        continue;
      }
      const rows = all<{ id: string; fromAgent: string }>(
        sql,
        "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' and rowid <= ? limit ?",
        agentId,
        through,
        receipts,
      );
      for (const r of rows) this.#expire(r.id, r.fromAgent, "recipient_closed");
      const fullR = rows.length >= receipts;
      receipts -= rows.length;
      const n = fullR
        ? 0
        : deleteDeliveredBodies(sql, agentId, bodies, through);
      if (fullR || n >= bodies) left.push(agentId);
      bodies -= n;
    }
    if (left.length === 0) return;
    sql.exec(
      "insert into meta (org_id, key, value) values (?, ?, ?)",
      OWNER_ORG_ID,
      `${CLOSE_PREFIX}${String(closedAt).padStart(16, "0")}:${newId()}`,
      JSON.stringify({ through, ids: left }),
    );
    this.#arm(closedAt + 1);
  }

  /**
   * M1, CLOSED_AGENTS_PER_MACHINE: false when an agent_up of `ref` (a ref the
   * machine has no row for) would pass the machine's closed-agent cap and no
   * idle closed agent could be purged to make room. At the cap, deletes the
   * machine's oldest idle closed agent, searching its whole closed set
   * (agents_machine_closed, at most CLOSED_AGENTS_PER_MACHINE rows, five
   * index probes each), so it refuses only when none is idle (re-review R1).
   * A known ref adds no row and always passes. Bounded: one count capped at
   * the limit, one probe over at most the limit.
   */
  #roomForClosed(machineId: string, ref: string): boolean {
    const sql = this.ctx.storage.sql;
    if (
      one(
        sql,
        "select 1 as x from agents where machine_id = ? and native_ref = ? and org_id = ?",
        machineId,
        ref,
        OWNER_ORG_ID,
      )
    )
      return true;
    const closed =
      one<{ n: number }>(
        sql,
        "select count(*) as n from (select 1 from agents indexed by agents_machine_closed where machine_id = ? and live = 0 limit ?)",
        machineId,
        CLOSED_AGENTS_PER_MACHINE,
      )?.n ?? 0;
    if (closed < CLOSED_AGENTS_PER_MACHINE) return true;
    const victim = one<{ rid: number }>(
      sql,
      `select a.rid from (select rowid as rid, id from agents indexed by agents_machine_closed
          where machine_id = ? and live = 0 order by updated_at, rowid limit ?) a
        where ${IDLE_AGENT_SQL} limit 1`,
      machineId,
      CLOSED_AGENTS_PER_MACHINE,
      this.#now() - SEND_KEY_RETAIN_MS,
    );
    if (!victim) return false;
    sql.exec("delete from agents where rowid = ? and live = 0", victim.rid);
    return true;
  }

  /**
   * M1: one bounded step of the alarm's purge of idle closed agents: up to
   * BATCH closed agents past CLOSED_AGENT_RETAIN_MS, oldest first
   * (agents_closed), from the persisted cursor; the idle ones are deleted,
   * the others kept and passed over. A pass that kept any starts again no
   * sooner than AGENT_PURGE_RETRY_MS later. True while the pass has more.
   */
  #purgeClosedAgents(now: number): boolean {
    const sql = this.ctx.storage.sql;
    const raw = one<{ value: string }>(
      sql,
      "select value from meta where org_id = ? and key = ?",
      OWNER_ORG_ID,
      AGENT_PURGE_KEY,
    )?.value;
    const cur = raw === undefined ? null : parsePurgeCursor(raw);
    if (cur === null) {
      const retry = this.#purgeRetry();
      if (retry !== null && retry > now) return false;
    }
    const u = cur?.u ?? -1;
    const r = cur?.r ?? 0;
    const rows = all<{ rid: number; u: number; idle: number }>(
      sql,
      `select a.rowid as rid, a.updated_at as u, ${IDLE_AGENT_SQL} as idle
         from agents a indexed by agents_closed
        where a.live = 0 and a.updated_at < ?
          and (a.updated_at > ? or (a.updated_at = ? and a.rowid > ?))
        order by a.updated_at, a.rowid limit ?`,
      now - SEND_KEY_RETAIN_MS,
      now - CLOSED_AGENT_RETAIN_MS,
      u,
      u,
      r,
      BATCH,
    );
    const gone = rows.filter((x) => x.idle === 1).map((x) => x.rid);
    if (gone.length > 0)
      sql.exec(
        "delete from agents where live = 0 and rowid in (select value from json_each(?))",
        JSON.stringify(gone),
      );
    if (gone.length > 0) logEvent("agents_purged", { n: gone.length });
    const kept = (cur?.kept ?? 0) + rows.length - gone.length;
    const last = rows.at(-1);
    if (rows.length >= BATCH && last) {
      sql.exec(
        "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
        OWNER_ORG_ID,
        AGENT_PURGE_KEY,
        JSON.stringify({ u: last.u, r: last.rid, kept }),
      );
      return true;
    }
    // The pass is over.
    sql.exec(
      "delete from meta where org_id = ? and key = ?",
      OWNER_ORG_ID,
      AGENT_PURGE_KEY,
    );
    if (kept > 0)
      sql.exec(
        "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
        OWNER_ORG_ID,
        AGENT_PURGE_RETRY_KEY,
        String(now + AGENT_PURGE_RETRY_MS),
      );
    else
      sql.exec(
        "delete from meta where org_id = ? and key = ?",
        OWNER_ORG_ID,
        AGENT_PURGE_RETRY_KEY,
      );
    return false;
  }

  /**
   * M1: when the closed-agent purge next has work: the oldest closed agent's
   * retention end (agents_closed), no sooner than a pending retry; now + 1
   * while a pass is under way. Null with no closed agent.
   */
  #purgeDeadline(): number | null {
    const sql = this.ctx.storage.sql;
    const oldest = one<{ t: number | null }>(
      sql,
      "select min(updated_at) as t from agents indexed by agents_closed where live = 0",
    )?.t;
    if (oldest === null || oldest === undefined) return null;
    if (
      one(
        sql,
        "select 1 as x from meta where org_id = ? and key = ?",
        OWNER_ORG_ID,
        AGENT_PURGE_KEY,
      )
    )
      return this.#now() + 1;
    const due = oldest + CLOSED_AGENT_RETAIN_MS + 1;
    const retry = this.#purgeRetry();
    return retry === null ? due : Math.max(due, retry);
  }

  /** The time before which no new closed-agent purge pass starts, or null. */
  #purgeRetry(): number | null {
    const v = one<{ value: string }>(
      this.ctx.storage.sql,
      "select value from meta where org_id = ? and key = ?",
      OWNER_ORG_ID,
      AGENT_PURGE_RETRY_KEY,
    )?.value;
    return v === undefined ? null : parseDecimal(v);
  }

  /**
   * One bounded step of the close drain, oldest queue row first: for each
   * queued agent, pending mail up to the close's rowid boundary expires as
   * recipient_closed (sender told or left for replay) and its acked notices
   * lose their bodies. At most BATCH agents, BATCH receipts and BATCH bodies
   * per step; a row is rewritten with the agents still to do, and deleted
   * once empty (or unreadable). True while any row remains.
   */
  #drainClosed(): boolean {
    const sql = this.ctx.storage.sql;
    let visits = 0;
    let receipts = BATCH;
    let bodies = BATCH;
    const queue = all<{ key: string; value: string }>(
      sql,
      "select key, value from meta where org_id = ? and key >= ? and key < ? order by key limit ?",
      OWNER_ORG_ID,
      CLOSE_PREFIX,
      CLOSE_END,
      BATCH,
    );
    for (const q of queue) {
      const entry = parseCloseEntry(q.value);
      const ids = entry?.ids ?? [];
      let done = 0;
      for (const agentId of ids) {
        if (visits >= BATCH) break;
        visits++;
        const rows = all<{ id: string; fromAgent: string }>(
          sql,
          "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' and rowid <= ? limit ?",
          agentId,
          entry?.through ?? 0,
          receipts,
        );
        for (const r of rows)
          this.#expire(r.id, r.fromAgent, "recipient_closed");
        receipts -= rows.length;
        if (receipts === 0) break;
        bodies -= deleteDeliveredBodies(
          sql,
          agentId,
          bodies,
          entry?.through ?? 0,
        );
        if (bodies === 0) break;
        done++;
      }
      if (done >= ids.length)
        sql.exec(
          "delete from meta where org_id = ? and key = ?",
          OWNER_ORG_ID,
          q.key,
        );
      else {
        sql.exec(
          "update meta set value = ? where org_id = ? and key = ?",
          JSON.stringify({
            through: entry?.through ?? 0,
            ids: ids.slice(done),
          }),
          OWNER_ORG_ID,
          q.key,
        );
        break;
      }
    }
    if (receipts < BATCH || bodies < BATCH)
      logEvent("drain_step", {
        kind: "closed",
        expired: BATCH - receipts,
        bodies: BATCH - bodies,
      });
    return (
      one(
        sql,
        "select 1 as x from meta where org_id = ? and key >= ? and key < ? limit 1",
        OWNER_ORG_ID,
        CLOSE_PREFIX,
        CLOSE_END,
      ) !== null
    );
  }

  /**
   * One bounded step of revoke expiry, from the persisted queue (meta rows
   * under DRAIN_PREFIX, value {"ids": [...]}): for each queued machine, the
   * agents that were open at the revoke, in order; their pending mail
   * expires as `revoked` (#expire: bodies and held bytes dropped, sender told
   * or left for replay) and their acked notices lose their bodies. At most
   * BATCH agents, BATCH receipts and BATCH bodies per step; an agent whose
   * work did not fit stays at the head of the list. Each visit is one lookup
   * on receipts_to and one on mail_to (final review M2): the cost never
   * depends on the machine's closed-agent history. True while any machine
   * remains queued.
   */
  #drainRevoked(): boolean {
    const sql = this.ctx.storage.sql;
    let visits = 0;
    let receipts = BATCH;
    let bodies = BATCH;
    const queue = all<{ key: string; value: string }>(
      sql,
      "select key, value from meta where org_id = ? and key >= ? and key < ? order by key limit ?",
      OWNER_ORG_ID,
      DRAIN_PREFIX,
      DRAIN_END,
      BATCH,
    );
    for (const q of queue) {
      const machineId = q.key.slice(DRAIN_PREFIX.length);
      const ids =
        parseRevokeEntry(q.value) ??
        legacyRevokeIds(sql, machineId, parseDecimal(q.value) ?? 0);
      let done = 0;
      for (const agentId of ids) {
        if (visits >= BATCH) break;
        visits++;
        const rows = all<{ id: string; fromAgent: string }>(
          sql,
          "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' limit ?",
          agentId,
          receipts,
        );
        for (const r of rows) this.#expire(r.id, r.fromAgent, "revoked");
        receipts -= rows.length;
        // Out of budget: this agent may have more; it stays queued.
        if (receipts === 0) break;
        bodies -= deleteDeliveredBodies(sql, agentId, bodies);
        if (bodies === 0) break;
        done++;
      }
      if (done >= ids.length)
        sql.exec(
          "delete from meta where org_id = ? and key = ?",
          OWNER_ORG_ID,
          q.key,
        );
      else {
        sql.exec(
          "update meta set value = ? where org_id = ? and key = ?",
          JSON.stringify({ ids: ids.slice(done) }),
          OWNER_ORG_ID,
          q.key,
        );
        break;
      }
    }
    return (
      one(
        sql,
        "select 1 as x from meta where org_id = ? and key >= ? and key < ? limit 1",
        OWNER_ORG_ID,
        DRAIN_PREFIX,
        DRAIN_END,
      ) !== null
    );
  }

  /**
   * Reconnect flush: the agent's pending mail to its live socket, oldest
   * first. A body in `mail` is sent from there and its row kept until the
   * ack (inline) or expiry; only a never-persisted held body is re-held.
   * Oversized bodies go as a notice. Bounded by inboxCap (50): an agent never
   * has more pending than that, which SWEEP_BATCH covers. Arms for each
   * row's expiry (a B6-era row may never have armed one). A receipt past its TTL, or with no body anywhere (lost to an
   * eviction), expires instead: never delivered. The daemon dedupes by
   * msg_id, so redelivering an unacked held body is safe.
   */
  #flush(ws: WebSocket, agent: AgentRow): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    for (const r of all<ReceiptRow>(
      sql,
      `select ${RECEIPT_COLS} from receipts where to_agent = ? and state = 'pending' and rowid > ? order by created_at, rowid limit ?`,
      agent.id,
      agent.sessionStartRowid,
      BATCH,
    )) {
      if (r.expiresAt <= now) {
        this.#expire(r.id, r.fromAgent);
        continue;
      }
      const h = this.#held.get(r.id);
      const body =
        h?.body ??
        one<{ body: string }>(sql, "select body from mail where id = ?", r.id)
          ?.body ??
        null;
      if (body === null) {
        this.#expire(r.id, r.fromAgent);
        continue;
      }
      this.#arm(r.expiresAt);
      const head = {
        v: 1,
        id: frameId(),
        type: "deliver",
        msg_id: r.id,
        to_ref: agent.nativeRef,
        from_name: r.fromName,
        namespace: r.namespace,
      } as const;
      if (r.size > LIMITS.inlineBodyBytes) {
        sendFrame(ws, { ...head, notice: { size: r.size, msg_id: r.id } });
        continue;
      }
      // A body already on disk stays there until ack or expiry (never moved
      // into memory, so an eviction cannot lose it). A held body, never
      // persisted, is re-held with a fresh ack deadline.
      if (h) {
        this.#hold(r.id, agent.id, body, r.size, r.createdAt, r.expiresAt, now);
        sql.exec("update receipts set held_at = ? where id = ?", now, r.id);
        this.#arm(now + LIMITS.ackTimeoutMs);
      }
      sendFrame(ws, { ...head, body });
    }
  }

  /**
   * Replays, oldest first, up to BATCH final receipt_updates the sender's
   * machine was never told (notified_at null), marking each as sent. True when
   * the batch was full (more may remain).
   */
  #replay(agentId: string): boolean {
    const sql = this.ctx.storage.sql;
    const m = one<{ machineId: string }>(
      sql,
      "select machine_id as machineId from agents where id = ?",
      agentId,
    );
    const socket = m && liveSocket(this.ctx, m.machineId);
    if (!socket) return false;
    const now = this.#now();
    const rows = all<{ id: string; state: string; reason: string | null }>(
      sql,
      "select id, state, reason from receipts where from_agent = ? and notified_at is null and state != 'pending' order by created_at, rowid limit ?",
      agentId,
      BATCH,
    );
    for (const r of rows) {
      const frame = updateFrame(r.id, r.state, r.reason);
      if (frame) sendFrame(socket, frame);
      sql.exec("update receipts set notified_at = ? where id = ?", now, r.id);
    }
    return rows.length >= BATCH;
  }

  #fits(size: number): boolean {
    return this.#heldBytes + Math.max(size, HELD_ENTRY_BYTES) <= HELD_BYTES_CAP;
  }

  /** Callers check #fits first; byte accounting is only ever done here and in #release. */
  #hold(
    msgId: string,
    toAgent: string,
    body: string,
    size: number,
    createdAt: number,
    expiresAt: number,
    at: number,
  ): void {
    const cost = Math.max(size, HELD_ENTRY_BYTES);
    this.#release(msgId);
    this.#held.set(msgId, { toAgent, body, cost, at, createdAt, expiresAt });
    this.#heldBytes += cost;
  }

  #release(msgId: string): void {
    const h = this.#held.get(msgId);
    if (!h) return;
    this.#held.delete(msgId);
    this.#heldBytes -= h.cost;
  }

  // ------------------------------------------------------------------- alarm

  /** Asks for the alarm at `t` (the earliest ask wins); committed after the event. */
  #arm(t: number): void {
    if (this.#armWant === null || t < this.#armWant) this.#armWant = t;
  }

  /** setAlarm only when none is set or `t` is earlier than the one set. */
  async #commitArm(): Promise<void> {
    const want = this.#armWant;
    if (want === null) return;
    this.#armWant = null;
    const t = alarmTime(want);
    if (t === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || t < cur) await this.ctx.storage.setAlarm(t);
  }

  /**
   * The one alarm (a DurableObject handler: workerd reserves the name, so it
   * is not callable over RPC). In order: ack timeout, lost bodies, revoke
   * drain, TTL, expired mail bodies, replay continuation, housekeeping, the
   * dashboard push and dashboard session expiry; then re-arm for
   * the earliest remaining deadline, or now + 1 if any batch was full.
   */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    let more = false;

    // 1. Ack timeout (write-on-miss): a held body whose ack is late moves to
    // mail; the receipt stays pending and the next flush redelivers it.
    let n = 0;
    for (const [id, h] of this.#held) {
      if (h.at + LIMITS.ackTimeoutMs > now) continue;
      if (n++ >= BATCH) {
        more = true;
        break;
      }
      storeBody(sql, id, h.toAgent, h.body, h.createdAt, h.expiresAt);
      sql.exec("update receipts set held_at = null where id = ?", id);
      this.#release(id);
    }

    // 2. Lost bodies: held_at set, no mail row and not in memory means the
    // body died with an eviction. Expired, never delivered.
    const lost = all<{ id: string; fromAgent: string }>(
      sql,
      `select id, from_agent as fromAgent from receipts
       where state = 'pending' and held_at is not null and held_at <= ?
         and not exists (select 1 from mail where mail.id = receipts.id)
       order by held_at limit ?`,
      now - LIMITS.ackTimeoutMs,
      BATCH,
    );
    if (lost.length >= BATCH) more = true;
    for (const r of lost)
      if (!this.#held.has(r.id)) this.#expire(r.id, r.fromAgent);

    // 2b. Revoked machines' inboxes that did not fit revokeMachine's batch,
    // before TTL so their receipts keep the `revoked` reason (B9 L2).
    if (this.#drainRevoked()) more = true;
    // 2c. Closed sessions' leftovers (B11), also before TTL (recipient_closed).
    if (this.#drainClosed()) more = true;

    // 3. TTL: pending past expires_at expires, bodies dropped, sender told.
    const due = all<{ id: string; fromAgent: string }>(
      sql,
      "select id, from_agent as fromAgent from receipts where state = 'pending' and expires_at <= ? order by expires_at limit ?",
      now,
      BATCH,
    );
    if (due.length >= BATCH) more = true;
    for (const r of due) this.#expire(r.id, r.fromAgent);

    // 4. Expired bodies, whatever the receipt state (acked notices included).
    if (
      purge(
        sql,
        "delete from mail where rowid in (select rowid from mail where expires_at <= ? limit ?) returning rowid",
        now,
      )
    )
      more = true;

    // 5. Missed receipt_updates that did not fit the agent_up batch.
    const next = this.#replayQueue.values().next();
    if (!next.done) {
      if (!this.#replay(next.value)) this.#replayQueue.delete(next.value);
      if (this.#replayQueue.size > 0) more = true;
    }

    // 5b. Coalesced status updates whose window closed (AC3).
    const statuses = applyDueStatus(sql, now, BATCH);
    if (statuses.length >= BATCH) more = true;
    this.#statusChanged(statuses);

    // 6. Housekeeping: consumed OIDC states, old device codes, B14 send keys
    // past SEND_KEY_RETAIN_MS, and final receipts told over 24 h ago (or never told, final over 24 h ago: keyed
    // on final_at, so a receipt finalized in this run is never deleted in it).
    for (const [q, t] of [
      [
        "delete from oidc_states where rowid in (select rowid from oidc_states where expires_at < ? limit ?) returning rowid",
        now - STATE_GRACE_MS,
      ],
      [
        "delete from device_codes where rowid in (select rowid from device_codes where expires_at < ? limit ?) returning rowid",
        now - DEVICE_CODE_GRACE_MS,
      ],
      [
        // Never the newest receipt (B11 L1): max(rowid) must never go back,
        // since session and close boundaries are receipts rowids.
        "delete from receipts where rowid in (select rowid from receipts where notified_at is not null and notified_at < ? and rowid < (select max(rowid) from receipts) limit ?) returning rowid",
        now - RETAIN_MS,
      ],
      [
        "delete from receipts where rowid in (select rowid from receipts where notified_at is null and state != 'pending' and final_at < ? and rowid < (select max(rowid) from receipts) limit ?) returning rowid",
        now - RETAIN_MS,
      ],
    ] as const)
      if (purge(sql, q, t)) more = true;
    // B14: send keys past their window (send_keys_due), kept off the count.
    const swept = all(
      sql,
      "delete from send_keys where rowid in (select rowid from send_keys where created_at < ? limit ?) returning rowid",
      now - SEND_KEY_RETAIN_MS,
      BATCH,
    ).length;
    if (swept >= BATCH) more = true;
    if (this.#sendKeys !== null) this.#sendKeys -= swept;
    // AC4c: card rate-limit windows that have ended.
    if (purge(sql, CARD_RL_PURGE_SQL, now - CARD_WINDOW_MS)) more = true;
    // M1: closed agents idle past CLOSED_AGENT_RETAIN_MS (after the sweeps
    // above, so work they just cleared counts).
    if (this.#purgeClosedAgents(now)) more = true;

    // 7. The throttled dashboard push (B10), once its due time has come.
    const pushDue = readPushDue(sql);
    if (pushDue !== null && pushDue <= now) {
      clearPushDue(sql);
      this.#pushDue = null;
      this.#pushDashboards();
    }

    // 8. Dashboard sockets whose session expired close with 4401 (B10-ws).
    this.#closeEndedDashboards();

    const want = this.#armWant;
    this.#armWant = null;
    const deadline = more ? now + 1 : this.#nextDeadline(want);
    const at =
      deadline === null ? null : alarmTime(Math.max(deadline, now + 1));
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }

  /** The earliest remaining deadline, each one indexed lookup; null if none. */
  #nextDeadline(want: number | null): number | null {
    const sql = this.ctx.storage.sql;
    const min = (q: string, add = 0): number | null => {
      const t = one<{ t: number | null }>(sql, q)?.t ?? null;
      return t === null ? null : t + add;
    };
    let heldNext: number | null = null;
    for (const h of this.#held.values())
      if (heldNext === null || h.at < heldNext) heldNext = h.at;
    const ts = [
      want,
      readPushDue(sql),
      this.#nextDashboardExp(),
      heldNext === null ? null : heldNext + LIMITS.ackTimeoutMs,
      min(
        "select min(held_at) as t from receipts where state = 'pending' and held_at is not null",
        LIMITS.ackTimeoutMs,
      ),
      min("select min(expires_at) as t from receipts where state = 'pending'"),
      min("select min(expires_at) as t from mail"),
      min(
        "select min(notified_at) as t from receipts where notified_at is not null",
        RETAIN_MS,
      ),
      min(
        "select min(final_at) as t from receipts where notified_at is null and state != 'pending'",
        RETAIN_MS,
      ),
      min("select min(created_at) as t from send_keys", SEND_KEY_RETAIN_MS + 1),
      this.#purgeDeadline(),
      nextStatusDue(sql),
    ].filter((t): t is number => t !== null);
    return ts.length === 0 ? null : Math.min(...ts);
  }

  // ------------------------------------------------------------- device flow

  /**
   * Registers a pending device code (B4). The label is sanitized here too
   * (newMachineLabel) so a stored label always passes MachineLabelSchema.
   * Stores only the SHA-256 of the device secret, which is returned once.
   * Purges a bounded batch of long-expired rows, then refuses with
   * `rate_limited` at MAX_DEVICE_CODES outstanding codes, or when `ipTag`
   * (the Worker's HMAC of the client IP) already holds DEVICE_CODES_PER_IP
   * live codes. Never evicts.
   */
  async createDeviceCode(
    label: string,
    ipTag: string,
  ): Promise<CreateDeviceCodeResult> {
    if (typeof ipTag !== "string" || !IP_TAG_RE.test(ipTag))
      throw new Error("invalid ip tag");
    const clean = MachineLabelSchema.safeParse(label).success
      ? label
      : newMachineLabel(typeof label === "string" ? label : "");
    const deviceCode = newDeviceSecret();
    // The only await: the cap check and the insert below are one synchronous step.
    const codeHash = await sha256Hex(deviceCode);
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    sql.exec(
      "delete from device_codes where rowid in (select rowid from device_codes indexed by device_codes_due where expires_at < ? limit ?)",
      now - DEVICE_CODE_GRACE_MS,
      BATCH,
    );
    const live =
      one<{ n: number }>(
        sql,
        "select count(*) as n from (select 1 from device_codes indexed by device_codes_due where expires_at > ? limit ?)",
        now,
        MAX_DEVICE_CODES,
      )?.n ?? 0;
    if (live >= MAX_DEVICE_CODES) {
      logEvent("rate_limited", { kind: "device_code_cap" });
      return { ok: false, code: "rate_limited" };
    }
    const mine =
      one<{ n: number }>(
        sql,
        `select count(*) as n from (select 1 from device_codes indexed by device_codes_ip
           where ip_tag = ? and expires_at > ? and consumed_at is null limit ?)`,
        ipTag,
        now,
        DEVICE_CODES_PER_IP,
      )?.n ?? 0;
    if (mine >= DEVICE_CODES_PER_IP) {
      logEvent("rate_limited", { kind: "device_code_ip" });
      return { ok: false, code: "rate_limited" };
    }
    // 32^8 codes: a collision (with a row kept for the grace period) is
    // vanishingly rare; retry a few times rather than fail.
    for (let i = 0; i < 4; i++) {
      const userCode = formatUserCode(newUserCode());
      const cur = sql.exec(
        `insert into device_codes (user_code, org_id, code_hash, label, created_at, expires_at, ip_tag)
         values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
        userCode,
        OWNER_ORG_ID,
        codeHash,
        clean,
        now,
        now + LIMITS.deviceCodeTtlSec * 1000,
        ipTag,
      );
      if (cur.rowsWritten > 0) return { ok: true, deviceCode, userCode };
    }
    throw new Error("could not allocate a user code");
  }

  /**
   * One /device/token poll, looked up by the secret's hash (unique index).
   * Pending until approved; slow_down when the same row was polled less than
   * the interval (less 1 s of slack) ago; denied after a deny; expired past
   * expires_at, once redeemed, and for an unknown code. An approved row is
   * claimed (consumed_at) before the machine is minted, so concurrent polls
   * mint at most one machine and a token is never issued twice; at the
   * machine limit the claim is released and `machine_limit` returned.
   */
  async pollDevice(deviceCode: string): Promise<DevicePoll> {
    if (!isDeviceSecret(deviceCode)) return { status: "expired" };
    const codeHash = await sha256Hex(deviceCode);
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const row = one<DeviceCodeRow>(
      sql,
      `select ${DEVICE_CODE_COLS} from device_codes where code_hash = ? and org_id = ?`,
      codeHash,
      OWNER_ORG_ID,
    );
    if (!row || row.consumedAt !== null || row.expiresAt <= now)
      return { status: "expired" };
    if (row.deniedAt !== null) return { status: "denied" };
    const tooFast =
      row.lastPolledAt !== null && now - row.lastPolledAt < POLL_MIN_MS;
    sql.exec(
      "update device_codes set last_polled_at = ? where user_code = ?",
      now,
      row.userCode,
    );
    if (tooFast) return { status: "slow_down" };
    if (row.approvedAt === null) return { status: "pending" };
    // The claim carries the machine id minted for it, so a failure after
    // createMachine's insert is told apart from one before it (adv-B4 L3).
    const machineId = newId();
    sql.exec(
      "update device_codes set consumed_at = ?, machine_id = ? where user_code = ? and consumed_at is null",
      now,
      machineId,
      row.userCode,
    );
    const release = () => {
      // Only when no machine row with this id exists: otherwise the approval
      // already minted one (its token is lost) and must never mint another.
      if (one(sql, "select 1 as x from machines where id = ?", machineId))
        return;
      sql.exec(
        "update device_codes set consumed_at = null, machine_id = null where user_code = ?",
        row.userCode,
      );
    };
    let made: CreateMachineResult;
    try {
      made = await this.createMachine(row.label, machineId);
    } catch (err) {
      release();
      throw err;
    }
    if (!made.ok) {
      release();
      logEvent("device_machine_limit");
      return { status: "machine_limit" };
    }
    logEvent("device_redeemed", { machine: made.id });
    return { status: "approved", token: made.token, machineId: made.id };
  }

  /**
   * The approval page's lookup: the pending code's label and age, or `gone`
   * for any other code (unknown, expired, decided or redeemed alike). `gen`
   * is the session's generation: `limited` once its POST misses reached
   * APPROVE_FAIL_CAP. A GET miss never counts (adv-B4 L1: a cross-site
   * navigation carries the Lax cookie, and reloads of decided pages are not
   * guesses); only approveDevice / denyDevice misses do.
   */
  async deviceForApproval(
    userCode: string,
    gen: number,
  ): Promise<DeviceForApproval> {
    const now = this.#now();
    if (this.#approveFailures(gen, now) >= APPROVE_FAIL_CAP)
      return { ok: false, reason: "limited" };
    const key = userCodeKey(userCode);
    const row =
      key === null
        ? null
        : one<{ userCode: string; label: string; createdAt: number }>(
            this.ctx.storage.sql,
            `select user_code as userCode, label, created_at as createdAt from device_codes
             where user_code = ? and org_id = ? and approved_at is null and denied_at is null
               and consumed_at is null and expires_at > ?`,
            key,
            OWNER_ORG_ID,
            now,
          );
    if (!row) return { ok: false, reason: "gone" };
    return {
      ok: true,
      userCode: row.userCode,
      label: row.label,
      ageMs: Math.max(0, now - row.createdAt),
    };
  }

  /**
   * Approves a pending code (one conditional update, so a code is decided at
   * most once). `label`, when given, must pass MachineLabelSchema and renames
   * the machine to be minted. The next poll redeems it.
   */
  async approveDevice(
    userCode: string,
    gen: number,
    label?: string,
  ): Promise<DeviceApproval> {
    if (label !== undefined && !MachineLabelSchema.safeParse(label).success)
      throw new Error("invalid machine label");
    return this.#decide(userCode, gen, "approved_at", label ?? null);
  }

  /** Denies a pending code; its next poll answers `denied`. */
  async denyDevice(userCode: string, gen: number): Promise<DeviceApproval> {
    return this.#decide(userCode, gen, "denied_at", null);
  }

  #decide(
    userCode: string,
    gen: number,
    column: "approved_at" | "denied_at",
    label: string | null,
  ): DeviceApproval {
    const now = this.#now();
    if (this.#approveFailures(gen, now) >= APPROVE_FAIL_CAP)
      return { ok: false, reason: "limited" };
    const key = userCodeKey(userCode);
    const rows =
      key === null
        ? []
        : all<{ userCode: string; label: string }>(
            this.ctx.storage.sql,
            // `column` is one of two fixed literals, never input.
            `update device_codes set ${column} = ?, label = coalesce(?, label)
             where user_code = ? and org_id = ? and approved_at is null and denied_at is null
               and consumed_at is null and expires_at > ?
             returning user_code as userCode, label`,
            now,
            label,
            key,
            OWNER_ORG_ID,
            now,
          );
    const row = rows[0];
    if (!row) {
      this.#approveFailed(gen, now);
      return { ok: false, reason: "gone" };
    }
    logEvent(column === "approved_at" ? "device_approved" : "device_denied");
    return { ok: true, userCode: row.userCode, label: row.label };
  }

  /** Failures in the current window for this session generation. */
  #approveFailures(gen: number, now: number): number {
    if (!Number.isSafeInteger(gen))
      throw new Error("invalid session generation");
    const w = readApproveFailures(this.ctx.storage.sql);
    if (!w || w.gen !== gen || now - w.start >= APPROVE_FAIL_WINDOW_MS)
      return 0;
    return w.n;
  }

  #approveFailed(gen: number, now: number): void {
    const sql = this.ctx.storage.sql;
    const w = readApproveFailures(sql);
    const fresh =
      !w || w.gen !== gen || now - w.start >= APPROVE_FAIL_WINDOW_MS;
    const next = fresh ? { gen, start: now, n: 1 } : { ...w, n: w.n + 1 };
    sql.exec(
      "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
      OWNER_ORG_ID,
      APPROVE_FAIL_KEY,
      `${next.gen}:${next.start}:${next.n}`,
    );
    if (next.n === APPROVE_FAIL_CAP)
      logEvent("rate_limited", { kind: "approve_guess" });
  }

  // ------------------------------------------------------------ auth storage

  /**
   * Marks an OIDC state as used: true the first time, false on any reuse.
   * Also false, storing nothing, when the state is empty or over 256 chars, or
   * expiresAt is not an integer in (now, now + 1 h] (so a replay after the
   * purge fails). Atomic: the DO is single-threaded and the insert is one
   * statement. Also purges a bounded batch of states expired over an hour ago.
   * Also false (storing nothing, logged rate_limited) when MAX_OIDC_STATES
   * are stored and the state is new (B11): the callback is refused, so the
   * flow fails closed. Always a boolean: callers treat any truthy result as
   * consumed.
   */
  async consumeState(state: string, expiresAt: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    sql.exec(
      "delete from oidc_states where rowid in (select rowid from oidc_states where expires_at < ? limit ?)",
      now - STATE_GRACE_MS,
      STATE_PURGE_BATCH,
    );
    if (
      typeof state !== "string" ||
      state.length === 0 ||
      state.length > MAX_STATE_CHARS
    )
      return false;
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MAX_STATE_TTL_MS
    )
      return false;
    const known = one(
      sql,
      "select 1 as x from oidc_states where org_id = ? and state = ?",
      OWNER_ORG_ID,
      state,
    );
    if (known) return false;
    const stored =
      one<{ n: number }>(
        sql,
        // Unexpired only (M1), on oidc_states_due: an expired state needs no
        // guard (expiresAt <= now is refused before the insert).
        "select count(*) as n from (select 1 from oidc_states indexed by oidc_states_due where expires_at > ? limit ?)",
        now,
        MAX_OIDC_STATES,
      )?.n ?? 0;
    // Never evict a stored state (it is the replay guard): at the cap the
    // new login is refused until states expire and are purged.
    if (stored >= MAX_OIDC_STATES) {
      logEvent("rate_limited", { kind: "oidc_state" });
      return false;
    }
    const cur = sql.exec(
      "insert into oidc_states (org_id, state, expires_at) values (?, ?, ?) on conflict(org_id, state) do nothing",
      OWNER_ORG_ID,
      state,
      expiresAt,
    );
    return cur.rowsWritten > 0;
  }

  /**
   * The current session generation: 0 before the first bump.
   *
   * Callers must compare a session's generation with `!==` only, never `<`:
   * -1 means the stored value is corrupt, and since no session carries -1,
   * `!==` then refuses every session (fails closed).
   */
  async sessionGeneration(): Promise<number> {
    return readSessionGeneration(this.ctx.storage.sql);
  }

  /**
   * Invalidates every session (logout, revoke-all) and returns the new
   * generation. A corrupt stored value restarts at 1. Every dashboard socket
   * closes with 4401 (B10-ws): its session is no longer valid.
   */
  async bumpSessionGeneration(): Promise<number> {
    const sql = this.ctx.storage.sql;
    const cur = readSessionGeneration(sql);
    const next = cur < 0 ? 1 : cur + 1;
    sql.exec(
      "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
      OWNER_ORG_ID,
      SESSION_GEN_KEY,
      String(next),
    );
    this.#closeEndedDashboards(true);
    return next;
  }
}

/**
 * The type the Worker and tests hold. Every method on `Hub.prototype` is
 * callable over RPC; helpers are module-level functions, which are not.
 */
export type HubStub = Hub;

/** A user code as stored (formatted), or null when it cannot be one. */
function userCodeKey(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const raw = normalizeUserCode(input);
  return raw === null ? null : formatUserCode(raw);
}

/** The approval guess window; null when absent or corrupt (a fresh window). */
function readApproveFailures(
  sql: SqlStorage,
): { gen: number; start: number; n: number } | null {
  const v = one<{ value: string }>(
    sql,
    "select value from meta where org_id = ? and key = ?",
    OWNER_ORG_ID,
    APPROVE_FAIL_KEY,
  )?.value;
  const m =
    v === undefined ? null : /^(\d{1,15}):(\d{1,16}):(\d{1,9})$/.exec(v);
  if (!m) return null;
  return { gen: Number(m[1]), start: Number(m[2]), n: Number(m[3]) };
}

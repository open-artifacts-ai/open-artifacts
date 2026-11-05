import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  AGENT_CAP_MESSAGES,
  type AgentKind,
  type AgentUpFrame,
  BUS_CAPS,
  BusNameSchema,
  type ClientFrame,
  candidateName,
  decodeClientFrame,
  encodeFrame,
  FALLBACK_BUS_NAME,
  type FormerName,
  frameId,
  hasCap,
  isId,
  LIMITS,
  MachineLabelSchema,
  type NameKind,
  newId,
  PING,
  PONG,
  REFUSAL_REASONS,
  RENAME_MESSAGES,
  type RefusalReason,
  type SendFrame,
  type ServerFrame,
  suffixName,
  utf8Bytes,
} from "@oa/bus-protocol";
import {
  BUS_ROLE_MAX,
  type BusAgent,
  type BusRole,
  type BusRoleProposal,
} from "@oa/shared";
import type { Env } from "../env.js";
import { logError, logInfo } from "../log.js";
import { INDEX_REPORT_MS, socketIndexStub } from "../runtime/presence.js";
import {
  type BusCloseKind,
  busCloseKind,
  MAX_ACTIVE_MACHINES,
} from "../services/bus.js";
import { VERSION } from "../version.gen.js";
import { type AgentWithMachine, agentDto, validAgents } from "./dto.js";
import {
  type DecideResult,
  decideProposal,
  expireProposals,
  listProposals,
  type ProposalAudit,
  type ProposeInput,
  type ProposeResult,
  propose,
  type ViewResult,
  viewProposal,
} from "./role-proposals.js";
import {
  deleteRole,
  formerReservedSql,
  listRoles,
  type PutRoleResult,
  putRole,
  resolveRoleAnywhere,
  resolveRoleIn,
  roleTakenSql,
} from "./roles.js";
import {
  AGENT_COLS,
  type AgentRow,
  MACHINE_COLS,
  type MachineRow,
  RECEIPT_COLS,
  type ReceiptRow,
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
// dashboard socket feed (the dashboard polls REST), card roles, agent cards,
// linked apps and the client-version gates (role addresses came back in
// #1296, bus/roles.ts). org_id stays on every row, always
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
function activeMachine(ctx: DurableObjectState, id: string): MachineRow | null {
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
 * processed and its close runs no bookkeeping.
 */
type Attachment = {
  machineId: string;
  replaced?: true;
  revoked?: true;
  /**
   * The capability tokens of the socket's latest `hello` (#1325), kept in
   * the attachment so they survive hibernation. Absent: no hello with caps.
   */
  caps?: string[];
};

function attachmentOf(ws: WebSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return typeof a?.machineId === "string" ? a : null;
}

/**
 * The rename wire (#1325, OpenBus #393: roster `former_names`, a former-name
 * receipt `to_name`) goes only to a socket whose hello listed
 * BUS_CAPS.rename. Every other socket resolves the same, without those
 * fields. Fails closed: no hello, or a hello without caps, gets none.
 */
const renameGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.rename);
};

/**
 * Reply ids (BUS_CAPS.ids): `deliver.from_id`, `send.to_id` and the
 * `agent_gone` refusal go only to a socket whose hello listed it. Fails
 * closed, like renameGated.
 */
const idsGated = (ws: WebSocket | null): boolean => {
  const caps = ws ? attachmentOf(ws)?.caps : undefined;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.ids);
};

/** What this hub supports, listed in `hello_ok.caps` to a hello that listed ids. */
const HUB_CAPS = [BUS_CAPS.rename, BUS_CAPS.roles, BUS_CAPS.ids];

/**
 * Role addresses (#1296): `role_vacant` and a role hit's receipt `to_name`
 * go only to a socket whose hello listed BUS_CAPS.roles. Fails closed, as
 * renameGated does.
 */
const rolesGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.roles);
};

/**
 * A receipt's `to_name`: the resolved agent's current name, only when the
 * send resolved through a role address (`viaRole`), to a roles-capable
 * socket, or through a former name (it differs from the name sent to,
 * beyond case), to a rename-capable socket.
 */
const toNameShown = (
  ws: WebSocket,
  sentTo: string,
  toName: string,
  viaRole: boolean,
): boolean =>
  viaRole
    ? rolesGated(ws)
    : renameGated(ws) && sentTo.toLowerCase() !== toName.toLowerCase();

/**
 * The refusal reason a socket may see: `role_vacant` only on a roles-capable
 * socket and `agent_gone` only on an ids-capable one (an older client's
 * strict decoder refuses the reason, failing the whole frame); any other gets
 * `unknown_agent`, as if the role or the agent did not exist.
 */
const wireReason = (ws: WebSocket, reason: RefusalReason): RefusalReason =>
  (reason === "role_vacant" && !rolesGated(ws)) ||
  (reason === "agent_gone" && !idsGated(ws))
    ? "unknown_agent"
    : reason;

function machineOf(ws: WebSocket): string | null {
  return attachmentOf(ws)?.machineId ?? null;
}

const isReplaced = (ws: WebSocket): boolean => {
  const a = attachmentOf(ws);
  return a?.replaced === true || a?.revoked === true;
};

const isRevokedSocket = (ws: WebSocket): boolean =>
  attachmentOf(ws)?.revoked === true;

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
 * (4429) "rate limited", and that machine's /bus/connect upgrades get 429 for
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
 * maxAgentsPerMachine live agents on the machine, or maxRosterAgents on the
 * member's bus. A re-up of an agent already live adds none and always passes. Bounded
 * counts on agents_machine and the live-only agents_live_lname.
 */
function capRefusal(
  sql: SqlStorage,
  machineId: string,
  ref: string,
): "machine" | "member" | null {
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
    return "member";
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
 * Names compare case-insensitively (bus names are ASCII). A global agent's
 * name must be free among ALL live agents (it is visible everywhere); a
 * non-global's must be free in its namespace and among live globals.
 * R393b: an agent's chosen former name in that same scope is taken too
 * (reserved for its grace); the agent's own former names are free to it.
 * OpenBus #451: a former name's scope is the one it was left in (former_names
 * namespace, global), not its agent's current one, so a move or flip keeps
 * it reserved where it was (formerReservedSql, shared with putRole). A
 * `held` row (a name an agent left a scope under: close, move or flip; a
 * revoke frees them, #1448) is taken the same way, and so is a chosen row of a closed agent:
 * both reserve whether or not the agent is live.
 * #1296: a role address in that scope is taken too (a role in the
 * namespace; for a global, a role in any namespace), vacant or not.
 * Reservations are per member: each member has its own hub.
 * OpenBus #446: a name minted for ANOTHER agent is taken in every scope, for
 * good (a minted name is never handed to another agent again); its own agent
 * may take it back. Default former names reserve nothing themselves: the
 * minted_names row does. One statement on agents_live_lname,
 * former_names_lname, the minted_names primary key and roles.
 */
function nameTaken(
  sql: SqlStorage,
  namespace: string,
  name: string,
  global: boolean,
  selfId: string,
  now: number,
): boolean {
  const lname = name.toLowerCase();
  const scope = global ? "" : "and (a.namespace = ? or a.global = 1)";
  const role = roleTakenSql(OWNER_ORG_ID, lname, namespace, global);
  const former = formerReservedSql(
    OWNER_ORG_ID,
    lname,
    now,
    namespace,
    global,
    selfId,
  );
  return (
    one<{ x: number }>(
      sql,
      `select (exists (select 1 from agents a where a.org_id = ? and lower(a.name) = ? and a.live = 1 and a.id != ? ${scope})
           or ${former.sql}
           or exists (select 1 from minted_names m where m.org_id = ? and m.lname = ? and m.agent_id != ?)
           or ${role.sql}) as x`,
      OWNER_ORG_ID,
      lname,
      selfId,
      ...(global ? [] : [namespace]),
      ...former.binds,
      OWNER_ORG_ID,
      lname,
      selfId,
      ...role.binds,
    )?.x === 1
  );
}

const RENAME_RL_PURGE_SQL =
  "delete from rename_rl where rowid in (select rowid from rename_rl indexed by rename_rl_at where at <= ? limit ?) returning rowid";

const FORMER_PURGE_SQL =
  "delete from former_names where rowid in (select rowid from former_names indexed by former_names_due where expires_at <= ? limit ?) returning rowid";

/**
 * OpenBus #451 (user decision 2026-11-04): a closed agent leaves its scope.
 * Its current name is held there (holdNames) and its chosen former names in
 * grace stay reserved, both resolving to no one while it is closed
 * (liveFormer needs a live agent); its default former names go, as on a
 * move. Call after the agents rows are closed (their name and scope are
 * read). OpenBus #446: a close keeps the rename log, so a reopen (the same
 * agent id) is still limited, and the alarm purges it by the rolling hour.
 * A revoke holds nothing (releaseMachineNames). Returns the holds' end, for
 * the alarm, or null for no agents.
 */
function leaveNames(
  sql: SqlStorage,
  agentIds: string[],
  now: number,
): number | null {
  if (agentIds.length === 0) return null;
  const ids = JSON.stringify(agentIds);
  sql.exec(
    "delete from former_names where agent_id in (select value from json_each(?)) and (kind = 'default' or expires_at <= ?)",
    ids,
    now,
  );
  return holdNames(sql, ids, now);
}

/**
 * #1448: a revoked machine's agents never come back (a re-approved
 * workstation is a new machine with new agent ids), so the revoke frees
 * every name they hold or reserve at once: the held names of agents closed
 * before or by the revoke, and their chosen and default former names, in
 * every scope. A re-approved machine, or anyone, then gets the plain names;
 * agents of other machines keep theirs. Minted names stay minted (OpenBus
 * #446: never handed to another agent). The rename log of the agents the
 * revoke closed (`closedIds`) goes too.
 *
 * Bounded (M2): never walks the machine's closed history. The agents the
 * revoke closed lose every row by former_names_agent (at most
 * maxAgentsPerMachine agents). Agents closed before it can block a name
 * only through a held or chosen row still in its grace, so those are found
 * from former_names_due (rows unexpired now: bounded by the last hour's
 * renames and closes, not by history), each checked against its agent by
 * primary key. Expired rows reserve nothing; the alarm purges them.
 */
function releaseMachineNames(
  sql: SqlStorage,
  machineId: string,
  closedIds: string[],
  now: number,
): void {
  if (closedIds.length > 0) {
    const ids = JSON.stringify(closedIds);
    sql.exec(
      "delete from former_names where agent_id in (select value from json_each(?))",
      ids,
    );
    sql.exec(
      "delete from rename_rl where agent_id in (select value from json_each(?))",
      ids,
    );
  }
  sql.exec(
    `delete from former_names where rowid in
       (select f.rowid from former_names f indexed by former_names_due
          join agents a on a.id = f.agent_id
         where f.expires_at > ? and f.kind in ('chosen', 'held')
           and a.machine_id = ?)`,
    now,
    machineId,
  );
}

/**
 * OpenBus #451: holds each agent's CURRENT name (from its agents row, so
 * call before a move rewrites it) in its current scope for
 * LIMITS.formerNameGraceMs, as a `held` former_names row: reserved there
 * (nameTaken, putRole), never resolving (liveFormer and the roster skip it,
 * even for a live agent back in that scope under another name), counted as
 * a reservation for ambiguity (heldElsewhere, nameOutside), but not in
 * formerRoom (the rename limit bounds them instead). It replaces the
 * agent's row for that name and scope (a chosen one a -2 move just left).
 * Its own agent takes it back by taking the name there again (nameTaken
 * skips its own rows; commitName drops the row). A hold is never dropped
 * before its hour: an agent holds at most one per scope change plus one per
 * close, and agentUp counts every scope change in rename_rl, so holds are
 * bounded by the hourly limit. `ids` is a JSON array. Returns the holds'
 * end.
 */
function holdNames(sql: SqlStorage, ids: string, now: number): number {
  const expires = now + LIMITS.formerNameGraceMs;
  sql.exec(
    `delete from former_names where rowid in
       (select f.rowid from former_names f join agents a on a.id = f.agent_id
         where f.agent_id in (select value from json_each(?))
           and f.lname = lower(a.name) and f.global = a.global
           and (f.global = 1 or f.namespace = a.namespace))`,
    ids,
  );
  sql.exec(
    `insert into former_names (agent_id, org_id, name, lname, kind, expires_at, namespace, global)
     select id, org_id, name, lower(name), 'held', ?, namespace, global from agents
      where id in (select value from json_each(?))`,
    expires,
    ids,
  );
  return expires;
}

/**
 * OpenBus #451: a namespace move or global flip keeps the agent's chosen
 * former names in the scope they were left in, reserving them there
 * (nameTaken, putRole) until their grace ends and resolving to no one
 * (liveFormer: a row resolves only in its agent's current scope). Its
 * default former names and expired rows go: a default name needs no
 * reservation (minted_names).
 */
function keepScopedNames(sql: SqlStorage, agentId: string, now: number): void {
  sql.exec(
    "delete from former_names where agent_id = ? and (kind = 'default' or expires_at <= ?)",
    agentId,
    now,
  );
}

/** A name scope: a namespace, and whether the agent is global. */
type Scope = { namespace: string; global: boolean };

/**
 * An assigned name, and for a default name minted now the minted_names row
 * to write (commitName), so a refused rename mints nothing.
 */
type Assigned = {
  name: string;
  mint: { lname: string; name: string; lbase: string } | null;
};

/**
 * The proposed name, else `-2`, `-3`... up to the roster cap, else the
 * fallback name suffixed the same way, else a random fallback suffix. Never
 * fails: a name collision is not an error. A `default` name is minted
 * instead (mintName). Writes nothing.
 */
function assignName(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
  now: number,
  kind: NameKind = "chosen",
): Assigned {
  if (kind === "default")
    return mintName(sql, namespace, proposed, global, selfId, now);
  const free = (n: string) =>
    !nameTaken(sql, namespace, n, global, selfId, now);
  for (const base of new Set([candidateName(proposed), FALLBACK_BUS_NAME])) {
    if (free(base)) return { name: base, mint: null };
    for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
      const next = suffixName(base, n);
      if (free(next)) return { name: next, mint: null };
    }
  }
  for (;;) {
    const next = suffixName(
      FALLBACK_BUS_NAME,
      MAX_NAME_SUFFIX + 1 + Math.floor(Math.random() * 1e9),
    );
    if (free(next)) return { name: next, mint: null };
  }
}

/** Random tries at a 4-hex suffix before the suffix grows to 8 hex. */
const MINT_TRIES = 32;

function randomHex(digits: number): string {
  const b = new Uint8Array(digits / 2);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** `<base>-<hex>` within the name cap (as suffixName trims). */
function mintedName(base: string, hex: string): string {
  const suffix = `-${hex}`;
  const stem = base
    .slice(0, LIMITS.maxBusNameChars - suffix.length)
    .replace(/[ .]+$/, "");
  return `${stem}${suffix}`;
}

/**
 * R393b: a `default` name (the harness's fallback, which nobody chose) is
 * `<base>-<4 hex>`. The agent's own minted name for this base comes back to
 * it while no one else holds it (a reconnect or reopen keeps its name);
 * otherwise a name never minted before, for anyone, so it needs no
 * reservation. After MINT_TRIES taken 4-hex names the suffix is 8 hex.
 */
function mintName(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
  now: number,
): Assigned {
  const proposedBase = candidateName(proposed);
  // Never loops on a base that cannot carry a suffix (not expected).
  const base = BusNameSchema.safeParse(mintedName(proposedBase, "0000")).success
    ? proposedBase
    : FALLBACK_BUS_NAME;
  const lbase = base.toLowerCase();
  const free = (n: string) =>
    !nameTaken(sql, namespace, n, global, selfId, now);
  const own = all<{ name: string }>(
    sql,
    "select name from minted_names indexed by minted_names_agent where agent_id = ? and lbase = ? order by created_at desc limit 4",
    selfId,
    lbase,
  );
  for (const o of own) if (free(o.name)) return { name: o.name, mint: null };
  for (let i = 0; ; i++) {
    const name = mintedName(base, randomHex(i < MINT_TRIES ? 4 : 8));
    const lname = name.toLowerCase();
    const minted = one(
      sql,
      "select 1 as x from minted_names where org_id = ? and lname = ?",
      OWNER_ORG_ID,
      lname,
    );
    if (minted === null && free(name))
      return { name, mint: { lname, name, lbase } };
  }
}

/**
 * Writes the minted_names row of a freshly minted name, and drops the
 * agent's former name equal to its new name in its scope `at` (a former name
 * never equals the current one in that scope, case-insensitively; OpenBus
 * #451: one left in another scope stays reserved there). Nothing of another agent's goes: its
 * chosen former names are reserved and its default ones are names minted for
 * it, which nameTaken never hands to anyone else (OpenBus #446), so the new
 * name is never another agent's live former name in scope. Should two agents
 * ever hold one former name in a scope, resolution refuses it as ambiguous.
 */
function commitName(
  sql: SqlStorage,
  agentId: string,
  a: Assigned,
  at: Scope,
  now: number,
): void {
  if (a.mint)
    sql.exec(
      "insert into minted_names (org_id, lname, name, agent_id, lbase, created_at) values (?, ?, ?, ?, ?, ?) on conflict do nothing",
      OWNER_ORG_ID,
      a.mint.lname,
      a.mint.name,
      agentId,
      a.mint.lbase,
      now,
    );
  const lname = a.name.toLowerCase();
  sql.exec(
    "delete from former_names where agent_id = ? and lname = ? and global = ? and (global = 1 or namespace = ?)",
    agentId,
    lname,
    at.global ? 1 : 0,
    at.namespace,
  );
}

/**
 * R393b: whether the agent may change its name now: under
 * LIMITS.renamesPerHour changes in the rolling hour (rename_rl, its expired
 * rows dropped first).
 */
function renameAllowed(sql: SqlStorage, agentId: string, now: number): boolean {
  sql.exec(
    "delete from rename_rl where agent_id = ? and at <= ?",
    agentId,
    now - HOUR_MS,
  );
  const count =
    one<{ n: number }>(
      sql,
      "select count(*) as n from rename_rl where agent_id = ?",
      agentId,
    )?.n ?? 0;
  return count < LIMITS.renamesPerHour;
}

/**
 * Who `lname` was minted for, from this agent's side: `self` (a default
 * name), `other` (taken through the hole OpenBus #446 closed; never this
 * agent's to keep) or null (never minted).
 */
function mintedFor(
  sql: SqlStorage,
  agentId: string,
  lname: string,
): "self" | "other" | null {
  const owner = one<{ agentId: string }>(
    sql,
    "select agent_id as agentId from minted_names where org_id = ? and lname = ?",
    OWNER_ORG_ID,
    lname,
  )?.agentId;
  return owner === undefined ? null : owner === agentId ? "self" : "other";
}

/**
 * OpenBus #449 B1: whether a change from `former` to `name` has room for the
 * former-name row it leaves. A chosen former name is reserved and is never
 * dropped inside its grace, so at LIMITS.maxFormerNames chosen rows in grace
 * (not counting the two names involved: the new one's own row in its scope
 * goes, the old one's in its scope is replaced) a change that leaves another
 * chosen row is refused. OpenBus #451: rows left in another scope by a move
 * or flip count too: they still hold reservations. Held names (holdNames)
 * do not: the rename limit bounds them, and a same-name move must not block
 * an in-place rename for an hour. A case-only change or a
 * minted (default) former name always has room.
 */
function formerRoom(
  sql: SqlStorage,
  agentId: string,
  former: string,
  from: Scope,
  name: string,
  to: Scope,
  now: number,
): boolean {
  const lformer = former.toLowerCase();
  const lname = name.toLowerCase();
  if (lformer === lname || mintedFor(sql, agentId, lformer) !== null)
    return true;
  const chosen =
    one<{ n: number }>(
      sql,
      `select count(*) as n from former_names indexed by former_names_agent
        where agent_id = ? and expires_at > ? and kind = 'chosen'
          and not (lname = ? and global = ? and (global = 1 or namespace = ?))
          and not (lname = ? and global = ? and (global = 1 or namespace = ?))`,
      agentId,
      now,
      lformer,
      from.global ? 1 : 0,
      from.namespace,
      lname,
      to.global ? 1 : 0,
      to.namespace,
    )?.n ?? 0;
  return chosen < LIMITS.maxFormerNames;
}

/** R393b: counts one name change in rename_rl; returns its purge time. */
function countRename(sql: SqlStorage, agentId: string, now: number): number {
  sql.exec("insert into rename_rl (agent_id, at) values (?, ?)", agentId, now);
  return now + HOUR_MS;
}

/**
 * R393b: records a name change from `former` (in scope `from`) to `name` (in
 * `to`; OpenBus #451: they differ on a move or flip, and the row stays in
 * `from`) (they differ exactly; formerRoom allowed it): one rename_rl row,
 * and unless only the
 * case changed (the old name already resolves) a former-name row for
 * LIMITS.formerNameGraceMs, `default` when the name was minted for this
 * agent (it is never handed on, so it needs no reservation), else `chosen`.
 * OpenBus #446/#449: at most LIMITS.maxFormerNames rows are stored per
 * agent. Past it the oldest DEFAULT rows go (they stop resolving; the minted
 * rule still keeps the name from anyone else); a chosen row in grace never
 * goes. Returns the times to arm the alarm for (the rename log's purge, the
 * grace's end).
 */
function recordRename(
  sql: SqlStorage,
  agentId: string,
  former: string,
  from: Scope,
  name: string,
  to: Scope,
  now: number,
): number[] {
  const arms = [countRename(sql, agentId, now)];
  const lformer = former.toLowerCase();
  const lname = name.toLowerCase();
  // One row per name per agent and scope: a reused former name is replaced,
  // and the new name's own row goes (commitName would drop it too), as do
  // expired rows, before the cap is applied. A row in another scope stays.
  sql.exec(
    `delete from former_names where agent_id = ? and (expires_at <= ?
       or (lname = ? and global = ? and (global = 1 or namespace = ?))
       or (lname = ? and global = ? and (global = 1 or namespace = ?)))`,
    agentId,
    now,
    lformer,
    from.global ? 1 : 0,
    from.namespace,
    lname,
    to.global ? 1 : 0,
    to.namespace,
  );
  if (lformer === lname) return arms;
  const minted = mintedFor(sql, agentId, lformer);
  // OpenBus #449 N3: a name minted for another agent, held through the old
  // hole, leaves no former row: it goes back to its own agent at once.
  if (minted === "other") return arms;
  const expires = now + LIMITS.formerNameGraceMs;
  sql.exec(
    "insert into former_names (agent_id, org_id, name, lname, kind, expires_at, namespace, global) values (?, ?, ?, ?, ?, ?, ?, ?)",
    agentId,
    OWNER_ORG_ID,
    former,
    lformer,
    minted === "self" ? "default" : "chosen",
    expires,
    from.namespace,
    from.global ? 1 : 0,
  );
  const excess =
    (one<{ n: number }>(
      sql,
      "select count(*) as n from former_names where agent_id = ? and kind != 'held'",
      agentId,
    )?.n ?? 0) - LIMITS.maxFormerNames;
  if (excess > 0)
    sql.exec(
      `delete from former_names where rowid in
         (select rowid from former_names where agent_id = ? and kind = 'default' order by expires_at, rowid limit ?)`,
      agentId,
      excess,
    );
  arms.push(expires);
  return arms;
}

/**
 * Registers (or re-registers) an agent; returns the reply, the changed
 * namespaces and the alarm times a name change needs.
 *
 * OpenBus #446: a re-sent agent_up that changes a LIVE agent's name (#1323)
 * is a rename: it counts in rename_rl and, in an unchanged scope, leaves a
 * former name as `rename` does. Where `rename` would answer rate_limited
 * (the hourly limit, or OpenBus #449 no room for another chosen former name)
 * the agent_up still succeeds (it must never fail: it is also a reconnect)
 * but keeps the current name, logged as `rename_kept`. OpenBus #451: a
 * namespace move or global flip keeps the chosen former names reserved in
 * the old scope (keepScopedNames), still counting in formerRoom, and (user
 * decision 2026-11-04) a live one holds its current name there for the
 * grace (holdNames), whether the name changes (a rename, a -2, or a
 * rename_kept -2) or not. Every scope change counts once in rename_rl (a
 * same-name one too); at the limit it is kept (`move_kept`, below).
 *
 * OpenBus #449 N1: a reopen (the agent was closed) under a new name counts
 * too, so close and reopen is no way around the limit, but leaves no former
 * name: the close already holds the old name (leaveNames), never resolving.
 * OpenBus #451 nit 1: on a reopen or in an unchanged scope, a name
 * de-collided from the current one (asked for the current name, ignoring
 * case, given a suffix) is not a rename: it counts nothing and leaves no
 * former name.
 */
function agentUp(
  sql: SqlStorage,
  machineId: string,
  frame: AgentUpFrame,
  now: number,
): {
  reply: ServerFrame;
  change: RosterChange;
  rowChanged: boolean;
  arms: number[];
} {
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
    frame.agent_ref,
    OWNER_ORG_ID,
  );
  const id = existing?.id ?? newId();
  // OpenBus #451 review: every scope change (a namespace move or global
  // flip, live or on a reopen, same name or not) counts in rename_rl, which
  // bounds the names an agent can hold (holdNames) to the hourly limit. At
  // the limit the agent_up still succeeds (it must never fail) but keeps the
  // agent in its current scope under its current name, logged as
  // `move_kept`; the daemon is not told (agent_ok carries no namespace,
  // open-bus #455).
  const moves =
    existing !== null &&
    (existing.global !== (frame.global ? 1 : 0) ||
      (!frame.global && existing.namespace !== frame.namespace));
  const f: AgentUpFrame =
    existing && moves && !renameAllowed(sql, existing.id, now)
      ? {
          ...frame,
          namespace: existing.namespace,
          global: existing.global === 1,
          proposed_name: existing.name,
          name_kind: undefined,
        }
      : frame;
  if (f !== frame)
    logEvent("move_kept", { machineId, reopen: existing?.live !== 1 });
  let counted = false;
  // A repeat agent_up for a live agent may rename it (#1323).
  let assigned = assignName(
    sql,
    f.namespace,
    f.proposed_name,
    f.global,
    id,
    now,
    f.name_kind,
  );
  const wasLive = existing?.live === 1;
  const to: Scope = { namespace: f.namespace, global: f.global };
  const asked = candidateName(f.proposed_name).toLowerCase();
  // A global's scope is every namespace: moving its home is no move.
  const sameScope =
    existing !== null &&
    existing.global === (f.global ? 1 : 0) &&
    (f.global || existing.namespace === f.namespace);
  // Nit 1 applies to a reopen or an unchanged scope only: a live move whose
  // name gets a suffix leaves the old name in the old scope (#451 review).
  const decollided =
    existing !== null &&
    (!wasLive || sameScope) &&
    asked === existing.name.toLowerCase() &&
    assigned.name.toLowerCase() !== asked;
  let arms: number[] = [];
  if (existing && assigned.name !== existing.name && !decollided) {
    const from: Scope = {
      namespace: existing.namespace,
      global: existing.global === 1,
    };
    const former = wasLive;
    if (
      renameAllowed(sql, id, now) &&
      (!former ||
        formerRoom(sql, id, existing.name, from, assigned.name, to, now))
    ) {
      counted = true;
      arms = former
        ? recordRename(sql, id, existing.name, from, assigned.name, to, now)
        : [countRename(sql, id, now)];
    } else {
      // OpenBus #449 N2: the agent_up succeeds under its current name; the
      // daemon is not told, so the kept name is logged.
      logEvent("rename_kept", { machineId, reopen: !wasLive });
      // The current name (its own, minted or not), de-collided only when a
      // move or a reopen finds it taken.
      assigned = assignName(sql, f.namespace, existing.name, f.global, id, now);
    }
  }
  const name = assigned.name;
  if (existing && !sameScope && !counted) arms.push(countRename(sql, id, now));
  // OpenBus #451: a live agent leaving its scope holds its current name
  // there, read from its row before the update below rewrites it.
  if (wasLive && !sameScope)
    arms.push(holdNames(sql, JSON.stringify([id]), now));
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
  // OpenBus #451: a namespace move or a global flip keeps the chosen former
  // names reserved in the old scope, where they resolve to no one.
  if (existing && !sameScope) keepScopedNames(sql, id, now);
  commitName(sql, id, assigned, to, now);
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
    arms,
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
  return one<{ id: string; namespace: string; global: number }>(
    sql,
    `update agents set live = 0, last_name = name, updated_at = ?, ${STATUS_CLEAR} where machine_id = ? and native_ref = ? and live = 1 and org_id = ? returning id, namespace, global`,
    now,
    machineId,
    ref,
    OWNER_ORG_ID,
  );
}

/**
 * A non-global agent sees its namespace plus every global agent; a global
 * agent sees every open agent. `state` is always sent: live while the
 * agent's machine holds an open, current socket (machineOnline, as the
 * dashboard and the send path decide it), queued otherwise. Each row
 * carries its self-reported status (AC3), and, with `formerFields`
 * (renameGated), its live former names (R393b).
 */
function roster(
  ctx: DurableObjectState,
  agent: AgentRow,
  id: string,
  formerFields: boolean,
  now: number,
): ServerFrame {
  const sql = ctx.storage.sql;
  const cap = LIMITS.maxRosterAgents;
  let rows: AgentRow[];
  if (agent.global === 1) {
    rows = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1 order by namespace, name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
  } else {
    // Two indexed queries (agents_live_name, agents_global_name), merged here.
    const local = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and namespace = ? and live = 1 order by name limit ?`,
      OWNER_ORG_ID,
      agent.namespace,
      cap,
    );
    const globals = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1 and global = 1 order by name limit ?`,
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
  const formers = formerFields
    ? formerNamesOf(sql, rows, now)
    : new Map<string, FormerName[]>();
  return {
    v: 1,
    id,
    type: "roster",
    agents: rows.map((r) => {
      const label = labels.get(r.machineId);
      const former = formers.get(r.id);
      return {
        bus_name: r.name,
        kind: r.kind as AgentKind,
        namespace: r.namespace,
        global: r.global === 1,
        state: stateOf(r.machineId),
        // The key is omitted, never null, if a row's machine has no label.
        ...(label === undefined ? {} : { machine_label: label }),
        ...statusWire(r),
        ...(former === undefined ? {} : { former_names: former }),
      };
    }),
  };
}

/**
 * R393b: each row's live former names for the roster (OpenBus #451: those
 * left in its current scope, the ones that resolve), newest first, at most
 * LIMITS.maxFormerNames (recordRename stores no more; the cap here is a
 * guard, never a hidden row). One statement on former_names_agent, ids as one JSON parameter.
 */
function formerNamesOf(
  sql: SqlStorage,
  rows: AgentRow[],
  now: number,
): Map<string, FormerName[]> {
  const out = new Map<string, FormerName[]>();
  if (rows.length === 0) return out;
  const found = all<{ agentId: string; name: string; expiresAt: number }>(
    sql,
    `select f.agent_id as agentId, f.name, f.expires_at as expiresAt from former_names f
      join agents a on a.id = f.agent_id
      where f.agent_id in (select value from json_each(?)) and f.expires_at > ? and f.kind != 'held'
        and f.global = a.global and (f.global = 1 or f.namespace = a.namespace)
      order by f.agent_id, f.expires_at desc, f.rowid desc`,
    JSON.stringify(rows.map((r) => r.id)),
    now,
  );
  for (const f of found) {
    const list = out.get(f.agentId) ?? [];
    if (list.length >= LIMITS.maxFormerNames) continue;
    list.push({
      name: f.name,
      expires_at: new Date(f.expiresAt).toISOString(),
    });
    out.set(f.agentId, list);
  }
  return out;
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

/**
 * True when a socket event must skip the daemon paths: a socket this DO never
 * accepted (getTags throws; seen when a test or the runtime closes a socket
 * before acceptWebSocket), which has nothing to clean up.
 */
const notDaemon = (ctx: DurableObjectState, ws: WebSocket): boolean => {
  try {
    return !ctx.getTags(ws).includes(DAEMON_TAG);
  } catch {
    return true;
  }
};

/**
 * A stored decimal as a safe integer of at most 16 digits, else null.
 * Number() alone would accept "", " ", "0x10", "1e15".
 */
function parseDecimal(v: string | null): number | null {
  if (v === null || !/^[0-9]{1,16}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
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
 * The dashboard's agent list (snapshot, GET /api/v1/bus/agents). Open agents
 * of unrevoked machines, joined to machines (primary key) for the label. All
 * agents: one ordered scan of agents_live_ns_lname, stopping at the cap. One
 * namespace: that namespace on agents_live_ns_lname plus the globals on
 * agents_global_name, merged here (as roster() does).
 */
function agentList(ctx: DurableObjectState, namespace?: string): BusAgent[] {
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
  const dtos = rows.map((r) => {
    let on = online.get(r.machineId);
    if (on === undefined) {
      on = machineOnline(ctx, r.machineId);
      online.set(r.machineId, on);
    }
    return agentDto(r, on);
  });
  // A bad stored row is skipped, never allowed to break the whole list.
  return validAgents(dtos);
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

/** `viaRole`: the send resolved through a role address (#1296). */
type Resolution =
  | { ok: true; agent: AgentRow; viaRole?: true }
  | { ok: false; reason: RefusalReason };

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

/**
 * R393b: live agents with the live former name `lname` (former_names_lname),
 * optionally in a scope: `ns` (namespace or global, as liveVisibleIn sees
 * it) or a global homed in `homedIn`. Globals first. A former name is never
 * held twice within a scope (nameTaken), so `limit` > 1 only finds a
 * seeded or racing duplicate, or matches across namespaces. OpenBus #451:
 * only a name left in the agent's current scope resolves (a global's scope
 * is every namespace: a global moving its home keeps them); one left before
 * a move or flip is reserved there and reaches no one, as does a `held` row
 * (a name left by a close, move or flip: holdNames) anywhere.
 */
function liveFormer(
  sql: SqlStorage,
  lname: string,
  now: number,
  scope: { ns: string } | { homedIn: string } | null,
  limit = 1,
): AgentRow[] {
  const where =
    scope === null
      ? ""
      : "ns" in scope
        ? "and (namespace = ? or global = 1)"
        : "and global = 1 and namespace = ?";
  return all<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and live = 1
       and id in (select f.agent_id from former_names f indexed by former_names_lname
                   where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind != 'held'
                     and f.global = agents.global and (f.global = 1 or f.namespace = agents.namespace))
       ${where} order by global desc limit ?`,
    OWNER_ORG_ID,
    OWNER_ORG_ID,
    lname,
    now,
    ...(scope === null ? [] : ["ns" in scope ? scope.ns : scope.homedIn]),
    limit,
  );
}

const refused = (reason: RefusalReason): Resolution => ({ ok: false, reason });

/**
 * #1296: whether a live agent outside namespace `ns`'s scope has `lname` as
 * its name, or as a live former name. A live agent of that scope never has
 * a role's name (nameTaken, putRole), so any live name counts; a resolving
 * former name of a non-global agent in `ns` (a default one) does not.
 * OpenBus #452, as heldElsewhere: a chosen or held former name in its grace
 * counts in any scope, live agent or not (one left behind by a move, flip
 * or close reaches no one, but is reserved: a role never shares its scope,
 * putRole), and the sender's own rows never count. One statement on
 * agents_live_lname and former_names_lname.
 */
function nameOutside(
  sql: SqlStorage,
  lname: string,
  ns: string,
  now: number,
  sender: string,
): boolean {
  return (
    one<{ x: number }>(
      sql,
      `select (exists (select 1 from agents where org_id = ? and lower(name) = ? and live = 1)
           or exists (select 1 from former_names f indexed by former_names_lname left join agents a on a.id = f.agent_id
                       where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.agent_id != ?
                         and (f.kind in ('chosen', 'held')
                           or (a.live = 1 and a.global = 0 and a.namespace != ? and f.global = 0 and f.namespace = a.namespace)))) as x`,
      OWNER_ORG_ID,
      lname,
      OWNER_ORG_ID,
      lname,
      now,
      sender,
      ns,
    )?.x === 1
  );
}

/**
 * OpenBus #452: whether an agent other than `target` and `sender` holds
 * `lname` as a former name in its grace: one that resolves (a live agent's,
 * in its scope), or a chosen or held one reserved in any scope, live agent
 * or not (left behind by a move, flip or close; the set nameTaken
 * reserves). The sender's own row never counts: it cannot mean itself.
 */
function heldElsewhere(
  sql: SqlStorage,
  lname: string,
  now: number,
  target: string,
  sender: string,
): boolean {
  return (
    one<{ x: number }>(
      sql,
      `select exists (select 1 from former_names f indexed by former_names_lname
         left join agents a on a.id = f.agent_id
         where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.agent_id != ? and f.agent_id != ?
           and (f.kind in ('chosen', 'held')
             or (a.live = 1 and f.global = a.global and (f.global = 1 or f.namespace = a.namespace)))) as x`,
      OWNER_ORG_ID,
      lname,
      now,
      target,
      sender,
    )?.x === 1
  );
}

/**
 * Within a scope a role address comes first (#1296: no live agent can share
 * its name there), then a current live name, then a live former name
 * (R393b), then goneReason. The sender's own namespace is looked at first; a
 * former name follows the visibility of its agent's current name. A role is
 * reached from its own namespace (or by a global sender); a non-global
 * sender's explicit other to_namespace never reaches one. Identical for
 * every client: the rename and roles gates only hide wire fields.
 */
function resolveTarget(
  sql: SqlStorage,
  sender: AgentRow,
  toName: string,
  toNamespace: string | undefined,
  now: number,
): Resolution {
  const lname = toName.toLowerCase();
  // A former name is never held by two agents in one scope (nameTaken);
  // if it ever were, the send is ambiguous rather than delivered to either.
  const formerIn = (
    scope: { ns: string } | { homedIn: string },
  ): Resolution | null => {
    const rows = liveFormer(sql, lname, now, scope, 2);
    const hit = rows[0];
    if (!hit) return null;
    return rows.length > 1 ? refused("ambiguous") : { ok: true, agent: hit };
  };
  const visibleIn = (ns: string): Resolution | null => {
    const role = resolveRoleIn(sql, OWNER_ORG_ID, ns, lname);
    if (role) return role;
    const hit = liveVisibleIn(sql, ns, lname);
    return hit ? { ok: true, agent: hit } : formerIn({ ns });
  };
  if (sender.global !== 1) {
    if (toNamespace !== undefined && toNamespace !== sender.namespace) {
      // Only a live global homed in X is reachable. Everything else is the
      // same refusal, so it cannot probe what exists in another namespace.
      const hit = liveGlobalHomedIn(sql, toNamespace, lname);
      if (hit) return { ok: true, agent: hit };
      return formerIn({ homedIn: toNamespace }) ?? refused("other_namespace");
    }
    const hit = visibleIn(sender.namespace);
    if (hit) return hit;
    // B9: the newest closed agent with the name says revoked or closed.
    const gone = goneReason(sql, sender.namespace, lname);
    if (gone) return refused(gone);
    // Other namespaces are invisible and unreachable (spec goal 5, scenario
    // 6): a name live only elsewhere is unknown_agent, so no probe can tell
    // it exists. other_namespace answers an explicit to_namespace only.
    return refused("unknown_agent");
  }
  if (toNamespace !== undefined) {
    const hit = visibleIn(toNamespace);
    if (hit) return hit;
    const gone = goneReason(sql, toNamespace, lname);
    if (gone) return refused(gone);
    return refused("unknown_agent");
  }
  // R393b: the sender's own namespace first, current then former names.
  const own = visibleIn(sender.namespace);
  if (own) return own;
  // #1296: a role in exactly one other namespace, unless a live agent (or a
  // live former name) outside that namespace's scope shares the name.
  const role = resolveRoleAnywhere(sql, OWNER_ORG_ID, lname, (ns) =>
    nameOutside(sql, lname, ns, now, sender.id),
  );
  if (role) return role;
  // A live global sorts first and is the only live agent with its name (and
  // no chosen former name can share it: nameTaken).
  const live = liveAnywhere(sql, lname, 2);
  const first = live[0];
  if (first?.global === 1) return { ok: true, agent: first };
  if (live.length > 1) return refused("ambiguous");
  // Then former names elsewhere, under the same ambiguity rule. OpenBus
  // #452: one live name in one namespace and another agent's former name in
  // another is ambiguous too (a chosen former name is reserved only in its
  // scope), counting a chosen one left behind by a move or flip.
  if (first)
    return heldElsewhere(sql, lname, now, first.id, sender.id)
      ? refused("ambiguous")
      : { ok: true, agent: first };
  const former = liveFormer(sql, lname, now, null, 2);
  const f = former[0];
  if (f && (f.global === 1 || former.length === 1))
    return heldElsewhere(sql, lname, now, f.id, sender.id)
      ? refused("ambiguous")
      : { ok: true, agent: f };
  if (former.length > 1) return refused("ambiguous");
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
    reason: wireReason(ws, reason),
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
  // A reply's to_id is part of what was sent: a resend with another one is
  // a different send, never the earlier receipt. Without one the hash is
  // unchanged, so keys stored before to_id still match.
  const to = f.to_id === undefined ? "" : `\n${f.to_id}`;
  return createHash("sha256")
    .update(`${f.to_name.toLowerCase()}\n${ns}\n${body}${to}`)
    .digest("hex");
}

type SendKey = {
  payloadHash: string;
  msgId: string;
  createdAt: number;
  viaRole: number;
};
type SendKeyCheck =
  | { kind: "new"; hash: string; dropped: boolean }
  | { kind: "resend"; msgId: string; viaRole: boolean }
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
    "select payload_hash as payloadHash, msg_id as msgId, created_at as createdAt, via_role as viaRole from send_keys where from_agent = ? and frame_id = ?",
    agentId,
    f.id,
  );
  if (!key) return { kind: "new", hash, dropped: false };
  if (key.createdAt >= now - SEND_KEY_RETAIN_MS)
    return key.payloadHash === hash
      ? { kind: "resend", msgId: key.msgId, viaRole: key.viaRole === 1 }
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
  viaRole: boolean,
): void {
  sql.exec(
    `insert into send_keys (from_agent, frame_id, org_id, payload_hash, msg_id, created_at, via_role)
     values (?, ?, ?, ?, ?, ?, ?) on conflict (from_agent, frame_id) do nothing`,
    agentId,
    frameId,
    OWNER_ORG_ID,
    hash,
    msgId,
    now,
    viaRole ? 1 : 0,
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
/**
 * open-bus #422: a machine with no daemon socket for this long has its live
 * agents closed by the alarm, as agent_down closes one. Safe: a reconnecting
 * daemon re-sends agent_up for every session it still has (bus-daemon
 * onOpen), and queued mail (LIMITS.mailTtlSec) has long expired by then.
 */
export const OFFLINE_REAP_MS = 24 * HOUR_MS;
/** Active machines that have live agents and an offline time, due first. */
const OFFLINE_DUE_SQL = `select id from machines
  where org_id = ? and revoked_at is null and disconnected_at is not null
    and disconnected_at <= ?
    and exists (select 1 from agents where agents.machine_id = machines.id and agents.live = 1)
  order by disconnected_at limit ?`;
/** Active machines with live agents and an offline time (the wake check, the deadline). */
const OFFLINE_LIVE_WHERE = `org_id = ? and revoked_at is null and disconnected_at is not null
    and exists (select 1 from agents where agents.machine_id = machines.id and agents.live = 1)`;
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
    f.type === "status"
    ? f.from_ref
    : null;
}

/**
 * The bus hub: one SQLite Durable Object per member (#1291). Reached only
 * through the Worker: GET /bus/connect forwards a verified daemon upgrade,
 * and the Worker calls the RPC methods below (snapshot, revokeMachine,
 * closeAll). Every method on this class is on the RPC surface (a test pins
 * the list). Helpers live outside the class.
 */
export class BusHub extends DurableObject<Env> {
  /** A frozen clock for tests; null in production. Never on the RPC surface. */
  #clock: number | null = null;

  /**
   * Tests only, inside `runInDurableObject`. Static, so it is not on the
   * prototype and a stub cannot call it over RPC.
   */
  static setTestClock(hub: BusHub, ms: number | null): void {
    hub.#clock = ms;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Every daemon socket gets "pong" for "ping" from the runtime, without
    // waking the hub.
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
   * final receipt), arm for its earliest deadline unless an earlier alarm is
   * set. One
   * indexed exists query; covers hubs whose rows never armed (B6-era).
   */
  async #armOnWake(): Promise<void> {
    this.#markOfflineMachines(this.#now());
    const work = one<{ x: number }>(
      this.ctx.storage.sql,
      `select (exists (select 1 from receipts where state = 'pending')
            or exists (select 1 from mail)
            or exists (select 1 from send_keys)
            or exists (select 1 from receipts where notified_at is null and state != 'pending')
            or exists (select 1 from agents indexed by agents_closed where live = 0)
            or exists (select 1 from agents indexed by agents_status_due where status_due is not null)
            or exists (select 1 from former_names)
            or exists (select 1 from rename_rl)
            or exists (select 1 from machines where ${OFFLINE_LIVE_WHERE})
            or exists (select 1 from meta where org_id = ? and key >= ? and key < ?)
            or exists (select 1 from meta where org_id = ? and key >= ? and key < ?)) as x`,
      OWNER_ORG_ID,
      OWNER_ORG_ID,
      DRAIN_PREFIX,
      DRAIN_END,
      OWNER_ORG_ID,
      CLOSE_PREFIX,
      CLOSE_END,
    );
    if (!work?.x) return;
    // Arms the earliest deadline even when a later alarm is set (a reap
    // deadline just started counting can be earlier than it).
    const at = this.#nextDeadline(null);
    if (at !== null) this.#arm(Math.max(at, this.#now() + 1));
    await this.#commitArm();
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
  static heldStats(hub: BusHub): { bytes: number; ids: string[] } {
    return { bytes: hub.#heldBytes, ids: [...hub.#held.keys()] };
  }

  /**
   * Tests only (static, not RPC): sets a socket's FRAME_BUDGET tokens, so a
   * test can start near empty instead of sending a whole burst first.
   */
  static setFrameTokensForTests(
    hub: BusHub,
    ws: WebSocket,
    tokens: number,
  ): void {
    const machineId = machineOf(ws);
    if (machineId !== null)
      hub.#machineBudgets.set(machineId, {
        tokens,
        at: hub.#now(),
        cooldownUntil: 0,
      });
  }

  /**
   * Tests only (static, not RPC): the hub-wide send-key cap (null:
   * SEND_KEYS_TOTAL); also drops the cached count, so a test may edit
   * send_keys directly.
   */
  static setSendKeysTotalForTests(hub: BusHub, cap: number | null): void {
    hub.#sendKeysCap = cap ?? SEND_KEYS_TOTAL;
    hub.#sendKeys = null;
  }

  /** Tests only (static, not RPC): the closed-agent cap check (#roomForClosed). */
  static roomForClosedForTests(
    hub: BusHub,
    machineId: string,
    ref: string,
  ): boolean {
    return hub.#roomForClosed(machineId, ref);
  }

  /** Tests only (static, not RPC): an eviction drops every held body. */
  static dropHeldForTests(hub: BusHub): void {
    hub.#held.clear();
    hub.#heldBytes = 0;
  }

  // ---------------------------------------------------------------- machines

  /**
   * The dashboard's one read (services/bus.ts busView): the machines with a
   * live socket now, and the open agents of unrevoked machines (agentList).
   */
  async snapshot(): Promise<{ connected: string[]; agents: BusAgent[] }> {
    const connected = all<StoredMachine>(
      this.ctx.storage.sql,
      `select ${MACHINE_COLS} from machines where org_id = ? and revoked_at is null`,
      OWNER_ORG_ID,
    )
      .filter((m) => machineOnline(this.ctx, m.id))
      .map((m) => m.id);
    return { connected, agents: agentList(this.ctx) };
  }

  // ------------------------------------------------------------------- roles

  /** Tests only (static, not RPC): the role cap (null: BUS_ROLE_MAX). */
  static setMaxRolesForTests(hub: BusHub, max: number | null): void {
    hub.#maxRoles = max ?? BUS_ROLE_MAX;
  }

  #maxRoles = BUS_ROLE_MAX;

  /**
   * #1296: the member's role addresses, for the dashboard (services/bus.ts).
   * Called only by the Worker, for the hub's own member: no frame reaches it.
   */
  async listRoles(): Promise<BusRole[]> {
    return listRoles(this.ctx.storage.sql, OWNER_ORG_ID, this.#maxRoles);
  }

  /**
   * #1296: sets, re-points or (agentId null) vacates role (namespace, name),
   * creating it if needed (roles.ts putRole). Mail already sent stays with
   * the agent it resolved to; only later sends follow. Worker only.
   */
  async putRole(
    namespace: string,
    name: string,
    agentId: string | null,
  ): Promise<PutRoleResult> {
    const r = putRole(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      namespace,
      name,
      agentId,
      this.#now(),
      newId,
      this.#maxRoles,
    );
    logEvent("role_set", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1296: removes role `id` (its name is free at once); false when unknown. Worker only. */
  async deleteRole(id: string): Promise<boolean> {
    return deleteRole(this.ctx.storage.sql, OWNER_ORG_ID, id);
  }

  /**
   * #1372: records an AI agent's role proposal under `tokenHash` (the
   * sha256 of its confirm link's secret, minted by the Worker). Changes no
   * role. Worker only (services/bus.ts proposeBusRole, from MCP).
   */
  async proposeRole(
    input: ProposeInput,
    tokenHash: string,
  ): Promise<ProposeResult> {
    const r = propose(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      input,
      tokenHash,
      this.#now(),
      newId,
      this.#maxRoles,
    );
    logEvent("role_proposed", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1372: the proposal behind `tokenHash`, for the confirm page; decides nothing but expiry. Worker only. */
  async viewRoleProposal(tokenHash: string): Promise<ViewResult> {
    return viewProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      this.#now(),
      this.#maxRoles,
    );
  }

  /**
   * #1372: confirms (applies, through putRole or deleteRole) or rejects the
   * proposal behind `tokenHash`, once. Worker only, and only from the
   * confirm page's POST (bus/role-confirm.ts: a browser session and its
   * form token); no frame and no MCP tool reaches it.
   */
  async decideRoleProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<DecideResult> {
    const r = decideProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      decision,
      this.#now(),
      newId,
      this.#maxRoles,
    );
    logEvent("role_decided", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1372: the newest role proposals, for GET R.busRoles; expires the overdue ones first. Worker only. */
  async listRoleProposals(): Promise<{
    proposals: BusRoleProposal[];
    expired: ProposalAudit[];
  }> {
    const sql = this.ctx.storage.sql;
    const expired = expireProposals(sql, OWNER_ORG_ID, this.#now());
    return { proposals: listProposals(sql, OWNER_ORG_ID), expired };
  }

  /** When the last closeAll started (ms), or null. */
  #revokedAt(): number | null {
    const v = one<{ value: string }>(
      this.ctx.storage.sql,
      "select value from meta where org_id = ? and key = ?",
      OWNER_ORG_ID,
      REVOKED_AT_KEY,
    )?.value;
    const n = v === undefined ? Number.NaN : Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }

  /**
   * The member's access was cut somewhere (runtime/presence.ts closeAll ->
   * services/bus.ts closeUserBus): revokedAt = now is written first, then
   * every daemon socket closes with 4403. A connect the Worker authorized at
   * or before revokedAt + SKEW_MS is refused (fetch), so no upgrade racing
   * this survives it; the daemon reconnects and the Worker checks again
   * (status, canConnect, the token). Machines are not revoked here: D1 does
   * that where the status changes. Returns the sockets closed.
   */
  /**
   * Erase (#1204, #1291): closes every daemon socket, then deletes all of
   * this hub's storage (machine mirror and labels, agents, mail, receipts,
   * send keys, meta) and its alarm, and starts again empty. Idempotent.
   */
  async wipe(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const m = machineOf(ws);
      try {
        if (m !== null)
          ws.serializeAttachment({
            machineId: m,
            revoked: true,
          } satisfies Attachment);
      } catch {
        // Already closed.
      }
      closeSocket(ws, LIMITS.revokeCloseCode, "erased");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#held.clear();
    this.#heldBytes = 0;
    this.#armWant = null;
    this.#replayQueue.clear();
    this.#machineBudgets.clear();
    this.#sendKeys = null;
    // The instance stays usable (empty), as on a first wake.
    this.ctx.storage.sql.exec(HUB_SCHEMA);
    migrateHub(this.ctx.storage.sql);
    logEvent("wiped");
  }

  async closeAll(
    reason: string,
    kind: BusCloseKind = busCloseKind(reason),
  ): Promise<number> {
    const now = this.#now();
    this.ctx.storage.sql.exec(
      `insert into meta (org_id, key, value) values (?, ?, ?)
       on conflict(org_id, key) do update set value = max(cast(value as integer), cast(excluded.value as integer))`,
      OWNER_ORG_ID,
      REVOKED_AT_KEY,
      String(now),
    );
    let n = 0;
    for (const ws of this.ctx.getWebSockets(DAEMON_TAG)) {
      const m = machineOf(ws);
      if (m === null) continue;
      try {
        ws.serializeAttachment({
          machineId: m,
          replaced: true,
        } satisfies Attachment);
      } catch {
        // Already closed.
      }
      closeSocket(ws, LIMITS.revokeCloseCode, "access changed");
      n++;
    }
    // #1350: a revocation's machines never come back: their offline clock
    // starts now (the sockets above are marked, so none counts as online),
    // and the 24 h reap closes their agents. Not at once: queued mail keeps
    // its TTL. A transient access change ("access") leaves it unset; the
    // daemons reconnect within seconds.
    if (kind !== "access") {
      this.#markOfflineMachines(now);
      const at = this.#offlineReapDeadline();
      if (at !== null) this.#arm(at);
      await this.#commitArm();
    }
    // `reason` is a fixed string from the caller; not logged (ids and counts only).
    void reason;
    logEvent("close_all", { closed: n, kind });
    return n;
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
    if (typeof id !== "string" || !isId(id)) return false;
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
    // #1448: nothing is held; every name its agents held or reserved is free.
    releaseMachineNames(sql, id, ids, now);
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
    await this.#commitArm();
    return true;
  }

  // ----------------------------------------------------------------- sockets
  // DurableObject handlers. workerd reserves these names: a stub cannot call
  // them over RPC (DurableObjectStub omits them).

  /**
   * GET /bus/connect (bus/connect.ts) forwards a verified upgrade here, to
   * CONNECT_DO_PATH, with only Upgrade, MACHINE_ID_HEADER,
   * MACHINE_LABEL_HEADER and AUTHZ_AT_HEADER (never the client's headers).
   * The Worker checked the token in D1 (unrevoked), the member (active,
   * canConnect) and that this is their hub. Here: an upgrade authorized at
   * or before the last closeAll (+ SKEW_MS) is refused 429 (the daemon
   * retries and the Worker checks again), and a machine this hub already
   * saw revoked is refused 401.
   */
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path !== CONNECT_DO_PATH)
      return new Response("Not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const machineId = req.headers.get(MACHINE_ID_HEADER) ?? "";
    const label = req.headers.get(MACHINE_LABEL_HEADER) ?? "";
    const authzAt = Number(req.headers.get(AUTHZ_AT_HEADER) ?? "");
    if (
      !isId(machineId) ||
      !MachineLabelSchema.safeParse(label).success ||
      !Number.isSafeInteger(authzAt)
    )
      return new Response("Bad upgrade", { status: 400 });
    const revokedAt = this.#revokedAt();
    if (revokedAt !== null && authzAt <= revokedAt + SKEW_MS) {
      logEvent("hub_reject", { code: "revoked_race", machineId });
      return new Response("retry", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(SKEW_MS / 1000) + 1) },
      });
    }
    // The hub's mirror of the D1 row: created on first accept, label kept
    // current; a row this hub already revoked stays revoked.
    this.ctx.storage.sql.exec(
      `insert into machines (id, org_id, label, created_at) values (?, ?, ?, ?)
       on conflict(id) do update set label = excluded.label where revoked_at is null`,
      machineId,
      OWNER_ORG_ID,
      label,
      this.#now(),
    );
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
    // open-bus #422: online again; the offline clock stops.
    this.ctx.storage.sql.exec(
      "update machines set disconnected_at = null where id = ? and disconnected_at is not null",
      machineId,
    );
    // The machine's open agents flip from queued to live.
    if (!wasOnline)
      notifyRoster(
        this.ctx,
        machineChange(this.ctx.storage.sql, machineId),
        server,
      );
    await this.#commitArm();
    // After the accept: a closeInstall that runs meanwhile finds this hub in
    // the index, and one that missed this report gets it on its later pass.
    await this.#reportToIndex();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** When this instance last reported to the socket index (ms; memory only). */
  #indexedAt = Number.NEGATIVE_INFINITY;

  /**
   * Tells the install's socket index (presence.ts INSTALL_INDEX) that this
   * hub holds a live socket, under its own DO name ("bus:" + user id), at
   * most once per INDEX_REPORT_MS per instance, so the platform's suspend
   * (closeInstall) closes bus sockets too. Fails open, as ArtifactRuntime's.
   */
  async #reportToIndex(): Promise<void> {
    const now = this.#now();
    if (now - this.#indexedAt < INDEX_REPORT_MS) return;
    const name = this.ctx.id.name;
    const idx = socketIndexStub(this.env);
    if (!idx || !name) return;
    try {
      await idx.seen(name);
      this.#indexedAt = now;
    } catch (e) {
      logError("socket_index_failed", e);
    }
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (notDaemon(this.ctx, ws)) return;
    if (this.#overBudget(ws)) return;
    this.#onMessage(ws, message);
    await this.#commitArm();
  }

  /**
   * Takes one token from the machine's FRAME_BUDGET; with none left, closes
   * the socket (4429 "rate limited", logged once per socket), starts the
   * machine's reconnect cooldown and returns true.
   */
  #overBudget(ws: WebSocket): boolean {
    const now = this.#now();
    const machineId = machineOf(ws);
    if (machineId === null) return false;
    const b = this.#machineBudget(machineId, now);
    const ok = !this.#rateClosed.has(ws) && takeToken(b, now, FRAME_BUDGET);
    if (ok) return false;
    // The cooldown starts when this socket trips, not on its late frames.
    if (!this.#rateClosed.has(ws)) {
      b.cooldownUntil = now + LIMITS.rateLimitCooldownMs;
      this.#rateClosed.add(ws);
      logEvent("rate_limited", { kind: "frames", machineId });
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

  #onMessage(ws: WebSocket, message: string | ArrayBuffer): void {
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
    if (!res.ok) {
      reject(ws, machineId, res.id, res.error, "Unreadable frame");
      return;
    }
    const f = res.frame;
    const sql = this.ctx.storage.sql;

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
        // #1325: the hello's caps gate the rename wire (renameGated). Kept
        // in the attachment so they survive hibernation; a later hello
        // replaces them. Other attachment fields are kept.
        {
          const { caps: _old, ...rest } = attachmentOf(ws) ?? { machineId };
          ws.serializeAttachment({
            ...rest,
            ...(f.caps === undefined ? {} : { caps: [...f.caps] }),
          } satisfies Attachment);
        }
        sendFrame(ws, {
          v: 1,
          id: f.id,
          type: "hello_ok",
          machine_id: machine.id,
          machine_label: machine.label,
          server_version: VERSION,
          // Only to a hello that listed ids: any other client decodes hello_ok
          // strictly, a rename-only one included.
          ...(hasCap(f, BUS_CAPS.ids) ? { caps: [...HUB_CAPS] } : {}),
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
        this.#closeSessions(downed.map((a) => a.id));
        notifyRoster(this.ctx, change, ws);
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
        const { reply, change, arms } = agentUp(sql, machineId, f, this.#now());
        for (const t of arms) this.#arm(t);
        sendFrame(ws, reply);
        notifyRoster(this.ctx, change, ws);
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
        return;
      }
      case "list":
        if (sender)
          sendFrame(
            ws,
            roster(this.ctx, sender, f.id, renameGated(ws), this.#now()),
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
      case "rename": {
        // R393b: only a live agent this socket registered may be renamed.
        const a = registeredAgent(sql, machineId, f.agent_ref);
        if (!a) {
          reject(
            ws,
            machineId,
            f.id,
            "not_registered",
            "agent_ref is not registered on this socket",
          );
          return;
        }
        this.#rename(ws, f, a);
        return;
      }
    }
  }

  /**
   * `rename` (R393b, #1325) for a live agent: `renamed`, or `error
   * rate_limited` past LIMITS.renamesPerHour name changes in a rolling hour
   * or with no room for one more chosen former name (formerRoom).
   * The name is assigned as agent_up assigns it (excluding self). A no-op
   * (the assigned name is the current one, exactly) answers without
   * `former`, records nothing and never counts. Otherwise the left name
   * becomes a former name for LIMITS.formerNameGraceMs (none when only its
   * case changed: it already resolves), and the roster changes. Status,
   * inbox and session boundary are untouched.
   */
  #rename(
    ws: WebSocket,
    f: Extract<ClientFrame, { type: "rename" }>,
    agent: AgentRow,
  ): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const global = agent.global === 1;
    const assigned = assignName(
      sql,
      agent.namespace,
      f.proposed_name,
      global,
      agent.id,
      now,
      f.name_kind,
    );
    const name = assigned.name;
    const reply = {
      v: 1,
      id: f.id,
      type: "renamed",
      agent_ref: f.agent_ref,
      bus_name: name,
    } as const;
    // The exact no-op check (assignName writes nothing), then the rate
    // limit, then the commit: a no-op never counts, a refusal changes nothing.
    if (name === agent.name) {
      sendFrame(ws, reply);
      return;
    }
    const at: Scope = { namespace: agent.namespace, global };
    if (!renameAllowed(sql, agent.id, now)) {
      logEvent("rate_limited", { kind: "rename", machineId: agent.machineId });
      sendError(ws, f.id, "rate_limited", RENAME_MESSAGES.rate);
      return;
    }
    if (!formerRoom(sql, agent.id, agent.name, at, name, at, now)) {
      logEvent("rate_limited", {
        kind: "rename_room",
        machineId: agent.machineId,
      });
      sendError(ws, f.id, "rate_limited", RENAME_MESSAGES.room);
      return;
    }
    const former = agent.name;
    for (const t of recordRename(sql, agent.id, former, at, name, at, now))
      this.#arm(t);
    sql.exec(
      "update agents set name = ?, updated_at = ? where id = ?",
      name,
      now,
      agent.id,
    );
    commitName(sql, agent.id, assigned, at, now);
    sendFrame(ws, { ...reply, former });
    notifyRoster(this.ctx, { namespaces: [agent.namespace], global }, ws);
  }

  /**
   * A `status` frame (AC3). No reply on success. Applied now: roster_changed.
   * Coalesced: the alarm applies it when due.
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

  /** Applied status changes: one roster_changed per namespace. */
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
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005/1006 are never sent on the wire.
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
    // A socket this DO never accepted has no bookkeeping.
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
    const sql = this.ctx.storage.sql;
    const change = machineChange(sql, machineId);
    // open-bus #422: the offline clock starts (kept if already running); the
    // reap deadline is armed only when there is something to reap.
    sql.exec(
      "update machines set disconnected_at = ? where id = ? and org_id = ? and revoked_at is null and disconnected_at is null",
      this.#now(),
      machineId,
      OWNER_ORG_ID,
    );
    if (change.namespaces.length > 0) {
      const since =
        one<{ t: number | null }>(
          sql,
          "select disconnected_at as t from machines where id = ?",
          machineId,
        )?.t ?? null;
      if (since !== null) this.#arm(since + OFFLINE_REAP_MS);
    }
    notifyRoster(this.ctx, change, ws);
  }

  /**
   * open-bus #422: starts the offline clock (now) for every active machine
   * with live agents, no open socket and none running: a hub that predates
   * the column, or a close the hub never heard (an eviction or deploy drops
   * sockets without a close; the hub then wakes here). Counting from now
   * means a deploy never reaps at once. Run on wake only; bounded by
   * MAX_ACTIVE_MACHINES.
   */
  #markOfflineMachines(now: number): void {
    const sql = this.ctx.storage.sql;
    const rows = all<{ id: string }>(
      sql,
      `select id from machines
        where org_id = ? and revoked_at is null and disconnected_at is null
          and exists (select 1 from agents where agents.machine_id = machines.id and agents.live = 1)
        limit ?`,
      OWNER_ORG_ID,
      MAX_ACTIVE_MACHINES,
    );
    for (const r of rows) {
      if (machineOnline(this.ctx, r.id)) continue;
      sql.exec(
        "update machines set disconnected_at = ? where id = ? and disconnected_at is null",
        now,
        r.id,
      );
    }
  }

  /** open-bus #422: the earliest offline reap deadline, scoped as OFFLINE_DUE_SQL; null if none. */
  #offlineReapDeadline(): number | null {
    const t =
      one<{ t: number | null }>(
        this.ctx.storage.sql,
        `select min(disconnected_at) as t from machines where ${OFFLINE_LIVE_WHERE}`,
        OWNER_ORG_ID,
      )?.t ?? null;
    return t === null ? null : t + OFFLINE_REAP_MS;
  }

  /**
   * open-bus #422: closes the live agents of machines offline past
   * OFFLINE_REAP_MS, at most BATCH agents per call, exactly as agent_down
   * closes one (live = 0, last_name, status cleared, #closeSessions holds
   * their names (OpenBus #451), expires
   * pending mail as recipient_closed and queues the rest), then tells the
   * roster and dashboards. A due machine that is online after all (a missed
   * clear) only has its clock cleared. True if the batch was full (the
   * caller re-arms at now + 1).
   */
  #reapOffline(now: number): boolean {
    const sql = this.ctx.storage.sql;
    const due = all<{ id: string }>(
      sql,
      OFFLINE_DUE_SQL,
      OWNER_ORG_ID,
      now - OFFLINE_REAP_MS,
      BATCH,
    );
    let budget = BATCH;
    const change: RosterChange = { namespaces: [], global: false };
    const closed: string[] = [];
    for (const m of due) {
      if (budget === 0) break;
      if (machineOnline(this.ctx, m.id)) {
        sql.exec(
          "update machines set disconnected_at = null where id = ?",
          m.id,
        );
        continue;
      }
      const rows = all<{ id: string; namespace: string; global: number }>(
        sql,
        `update agents set live = 0, last_name = name, updated_at = ?, ${STATUS_CLEAR}
          where rowid in (select rowid from agents where machine_id = ? and live = 1 and org_id = ? limit ?)
         returning id, namespace, global`,
        now,
        m.id,
        OWNER_ORG_ID,
        budget,
      );
      budget -= rows.length;
      for (const a of rows) {
        closed.push(a.id);
        change.namespaces.push(a.namespace);
        if (a.global === 1) change.global = true;
      }
      logEvent("machine_offline_reaped", {
        machineId: m.id,
        agents: rows.length,
      });
    }
    if (closed.length === 0) return false;
    this.#closeSessions(closed);
    notifyRoster(this.ctx, change);
    return budget === 0;
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
      this.#resend(ws, f.id, f.to_name, key.msgId, key.viaRole);
      return;
    }
    if (key.dropped && this.#sendKeys !== null) this.#sendKeys--;
    const res = resolveTarget(sql, sender, f.to_name, f.to_namespace, now);
    // A reply (`to_id`) goes only to the agent it answers: never to whoever
    // holds the name now (wireReason shows agent_gone only to an ids socket).
    // Role resolution stays inside resolveTarget, before this check.
    if (f.to_id !== undefined && (!res.ok || res.agent.id !== f.to_id)) {
      refuseSend(ws, f.id, "agent_gone");
      return;
    }
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
    const viaRole = res.viaRole === true;
    insertSendKey(sql, sender.id, f.id, key.hash, msgId, now, viaRole);
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
      ...(toNameShown(ws, f.to_name, target.name, viaRole)
        ? { to_name: target.name }
        : {}),
    });
    if (!socket) return;

    const head = {
      v: 1,
      id: frameId(),
      type: "deliver",
      msg_id: msgId,
      to_ref: target.nativeRef,
      from_name: sender.name,
      ...(idsGated(socket) ? { from_id: sender.id } : {}),
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
  #resend(
    ws: WebSocket,
    id: string,
    sentTo: string,
    msgId: string,
    viaRole: boolean,
  ): void {
    const sql = this.ctx.storage.sql;
    const r = one<{
      state: string;
      reason: string | null;
      toName: string | null;
    }>(
      sql,
      "select state, reason, to_name as toName from receipts where id = ?",
      msgId,
    ) ?? {
      state: "expired",
      reason: null,
      toName: null,
    };
    sendFrame(ws, {
      v: 1,
      id,
      type: "receipt",
      msg_id: msgId,
      state: "pending",
      // R393b, #1296: a resend repeats a former-name or role hit's to_name
      // (the name the send resolved to, from the receipt row).
      ...(r.toName !== null && toNameShown(ws, sentTo, r.toName, viaRole)
        ? { to_name: r.toName }
        : {}),
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
    // OpenBus #451: their names are held where they were left, for the grace.
    const heldTo = leaveNames(sql, agentIds, closedAt);
    if (heldTo !== null) this.#arm(heldTo);
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
        ...(idsGated(ws) ? { from_id: r.fromAgent } : {}),
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
   * drain, TTL, expired mail bodies, replay continuation, status, then
   * housekeeping; then re-arm for
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

    // 2a. open-bus #422: machines offline past OFFLINE_REAP_MS have their
    // agents closed (before the close drain, which takes their leftover mail).
    // One with no clock yet started counting at the wake (#armOnWake).
    if (this.#reapOffline(now)) more = true;

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

    // 6. Housekeeping: B14 send keys
    // past SEND_KEY_RETAIN_MS, and final receipts told over 24 h ago (or never told, final over 24 h ago: keyed
    // on final_at, so a receipt finalized in this run is never deleted in it).
    for (const [q, t] of [
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
    // R393b: former names past their grace, rename windows that have ended.
    if (purge(sql, FORMER_PURGE_SQL, now)) more = true;
    if (purge(sql, RENAME_RL_PURGE_SQL, now - HOUR_MS)) more = true;
    // M1: closed agents idle past CLOSED_AGENT_RETAIN_MS (after the sweeps
    // above, so work they just cleared counts).
    if (this.#purgeClosedAgents(now)) more = true;

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
      min("select min(expires_at) as t from former_names"),
      min("select min(at) as t from rename_rl", HOUR_MS),
      this.#offlineReapDeadline(),
    ].filter((t): t is number => t !== null);
    return ts.length === 0 ? null : Math.min(...ts);
  }
}

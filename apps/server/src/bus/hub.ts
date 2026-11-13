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
  droppedRefusedChars,
  encodeFrame,
  FALLBACK_BUS_NAME,
  type FormerName,
  frameId,
  HUB_MAILBOX_BYTES_CAP,
  hasCap,
  impersonates,
  isFallbackName,
  isId,
  LIMITS,
  LinkProofHashSchema,
  MAILBOX_BYTES_CAP,
  MAILBOX_PENDING_CAP,
  MAILBOX_RETAIN_MS,
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
  BUS_LINK_MAX,
  BUS_REACH_MAX,
  BUS_ROLE_MAX,
  type BusAgent,
  type BusLink,
  type BusNotice,
  type BusRole,
  type BusRoleProposal,
  NOTICE_SENDER,
} from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError, logInfo } from "../log.js";
import { runtimeStub } from "../runtime/do.js";
import { INDEX_REPORT_MS, socketIndexStub } from "../runtime/presence.js";
import { type AgentIdentity, NAMES_OF_MAX } from "../services/agent-usage.js";
import {
  type BusCloseKind,
  busCloseKind,
  MAX_ACTIVE_MACHINES,
} from "../services/bus.js";
import type { DeliveryOutcome } from "../services/bus-delivery.js";
import { agentKey } from "../services/comment-agents.js";
import {
  follow,
  following,
  knownKey,
  moveFollows,
  pruneDeadFollows,
  unfollow,
} from "../services/follows.js";
import { VERSION } from "../version.gen.js";
import { isDefaultAgentName } from "./default-names.js";
import { type AgentWithMachine, agentDto, validAgents } from "./dto.js";
import {
  decideLinkProposal,
  expireLinkProposalsOfMachine,
  type LinkDecideResult,
  type LinkProposalAction,
  type LinkProposeResult,
  type LinkViewResult,
  proposeLink,
  viewLinkProposal,
} from "./link-proposals.js";
import {
  addLink,
  isLinked,
  linkedNamespaces,
  listLinks,
  type PutLinkResult,
  removeLink,
} from "./links.js";
import {
  addReach,
  holderReaches,
  holdersReaching,
  listReach,
  type PutReachResult,
  type ReachGrant,
  reachNamespaces,
  removeReach,
} from "./reach.js";
import {
  decideReachProposal,
  expireReachProposalsOfMachine,
  proposeReach,
  type ReachAudit,
  type ReachDecideResult,
  type ReachProposeResult,
  type ReachViewResult,
  viewReachProposal,
} from "./reach-proposals.js";
import {
  type DecideResult,
  decideProposal,
  expireByCredential,
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
/**
 * #1749: how long a close this hub started waits for the install index's
 * `gone`. Well under revokeBusMachine's 10 s `within`, so a slow index never
 * turns a finished revoke into a 503.
 */
const INDEX_GONE_TIMEOUT_MS = 3000;

/** Structured hub events: ids, codes, kinds and counts only (log.ts). */
function logEvent(
  evt: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  logInfo(`bus_${evt}`, fields);
}

const HOUR_MS = 3_600_000;

/** SET clause of every close: the status goes, and so does the session's link proof (#1822). */
const CLOSE_CLEAR = `${STATUS_CLEAR}, proof_hash = null`;
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
   * The socket tripped its frame budget and was closed (#1749). Kept here so
   * a wake (which clears #rateClosed) still processes none of its frames.
   */
  rateLimited?: true;
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
const HUB_CAPS = [
  BUS_CAPS.rename,
  BUS_CAPS.roles,
  BUS_CAPS.ids,
  BUS_CAPS.mailbox,
  BUS_CAPS.links,
  BUS_CAPS.reach,
  BUS_CAPS.follow,
  BUS_CAPS.link,
  BUS_CAPS.linkArg,
  BUS_CAPS.waiting,
  BUS_CAPS.waitingQuery,
  BUS_CAPS.noticeAck,
  BUS_CAPS.nameChosen,
  BUS_CAPS.ackConfirm,
];

/**
 * Follows (#1317, BUS_CAPS.follow): the follow, unfollow and following frames
 * and the `follow_limit` error go only to a socket whose hello listed it.
 * Fails closed, like renameGated.
 */
const followGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.follow);
};

/** #2079: waiting_query goes only to a socket whose hello listed BUS_CAPS.waitingQuery. */
const waitingQueryGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.waitingQuery);
};

/** #2198: `acked` goes only to a socket whose hello listed BUS_CAPS.ackConfirm. */
const ackConfirmGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.ackConfirm);
};

/** #1822: link_bind goes only to a socket whose hello listed BUS_CAPS.link. */
const linkGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.link);
};

/**
 * Notices (#1746): the `notice` frame arrived with daemon v0.138.0, but only
 * v0.139.0 began listing a cap (BUS_CAPS.follow), so that cap is the gate. A
 * daemon without it has a strict decoder that refuses the frame (`bad_frame`)
 * while the hub would report `delivered`. Such a socket is treated as an
 * offline machine: the notice parks and goes out on an agent_up from a
 * socket with the cap. 0.138.x daemons count as old, which is acceptable.
 */
const noticeGated = (ws: WebSocket): boolean => followGated(ws);

/**
 * #1752 (BUS_CAPS.noticeAck): a socket that acks a notice only once its
 * harness took it. A notice sent to one is held until that ack. It also
 * needs the notice gate, so it never narrows who can read a notice.
 */
const noticeAckGated = (ws: WebSocket): boolean => {
  const caps = attachmentOf(ws)?.caps;
  return (
    noticeGated(ws) &&
    Array.isArray(caps) &&
    hasCap({ caps }, BUS_CAPS.noticeAck)
  );
};

/** #1752/#2082: how long a sent notice waits for its ack; past it its targets settle as gone (not confirmed delivered). */
export const NOTICE_ACK_TTL_MS = 6 * HOUR_MS;
/** #1752: notices waiting for an ack at once; the oldest go first. */
export const NOTICE_ACKS_MAX = 2000;

/** #1317: follow requests one hub runs at once (each is a D1 round trip); past it, `rate_limited`. */
const FOLLOWS_IN_FLIGHT_MAX = 8;
/** #1317: how long a follow request waits on D1 before the agent is told `internal`. */
const FOLLOW_TIMEOUT_MS = 5_000;

/**
 * Lasting mailboxes (#1295, BUS_CAPS.mailbox): a receipt's `queued`/`since`,
 * the `mailbox_full` and `reserved_name` refusals, roster away rows and the
 * `agent_up` handover go only to a socket whose hello listed it. Fails
 * closed, like renameGated.
 */
const waitingGated = (ws: WebSocket | null): boolean => {
  const caps = ws ? attachmentOf(ws)?.caps : undefined;
  return (
    Array.isArray(caps) &&
    hasCap({ caps }, BUS_CAPS.mailbox) &&
    hasCap({ caps }, BUS_CAPS.waiting)
  );
};

const mailboxGated = (ws: WebSocket | null): boolean => {
  const caps = ws ? attachmentOf(ws)?.caps : undefined;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.mailbox);
};

/**
 * Project links (#1567, BUS_CAPS.links): a socket's roster and sends reach the
 * namespaces linked to its own only when its hello listed it. Fails closed,
 * like renameGated: any other socket sees today's isolation.
 */
const linksGated = (ws: WebSocket | null): boolean => {
  const caps = ws ? attachmentOf(ws)?.caps : undefined;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.links);
};

/**
 * Scoped role reach (#1346, BUS_CAPS.reach): a role holder's roster and sends
 * reach the namespaces its role was given, and the agents there reply to it,
 * only when the socket's hello listed it. Fails closed, like linksGated: any
 * other socket sees today's behaviour.
 */
const reachGated = (ws: WebSocket | null): boolean => {
  const caps = ws ? attachmentOf(ws)?.caps : undefined;
  return Array.isArray(caps) && hasCap({ caps }, BUS_CAPS.reach);
};

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
const wireReason = (ws: WebSocket, reason: RefusalReason): RefusalReason => {
  if (reason === "mailbox_full")
    return mailboxGated(ws) ? reason : "inbox_full";
  return (reason === "role_vacant" && !rolesGated(ws)) ||
    (reason === "agent_gone" && !idsGated(ws)) ||
    (reason === "reserved_name" && !mailboxGated(ws))
    ? "unknown_agent"
    : reason;
};

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

/** #1752: like sendFrame, but false when the socket refused the frame (closing or closed), so a notice is not counted delivered. */
function trySendFrame(ws: WebSocket, frame: ServerFrame): boolean {
  try {
    ws.send(encodeFrame(frame));
    return true;
  } catch {
    return false;
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
  linkMachines: ReadonlySet<string>,
  reachMachines: ReadonlySet<string>,
): Map<string, string[]> {
  const out = directAudience(sql, changed, machines);
  // #1567: a namespace linked to a changed one sees its agents too, so the
  // machines hosting agents there hear `roster_changed{theirs}` as well.
  const wanted = new Set(changed);
  const heard = new Set<string>();
  for (const x of changed)
    for (const r of linkedNamespaces(sql, OWNER_ORG_ID, x))
      if (!wanted.has(r)) heard.add(r);
  for (const r of heard)
    for (const row of all<{ machineId: string }>(
      sql,
      "select distinct machine_id as machineId from agents where org_id = ? and namespace = ? and live = 1",
      OWNER_ORG_ID,
      r,
    )) {
      // Only a links-capable machine can use the extra frame.
      if (!linkMachines.has(row.machineId)) continue;
      const cur = out.get(row.machineId);
      // `changed` itself is shared by every global machine: copy, never push.
      if (cur === changed) out.set(row.machineId, [...changed, r]);
      else if (cur) {
        if (!cur.includes(r)) cur.push(r);
      } else out.set(row.machineId, [r]);
    }
  // #1346: the machine hosting a live holder of a role that reaches a changed
  // namespace hears `roster_changed{holder's namespace}`: its roster shows the
  // changed namespace's agents. Only a reach-capable machine can use it.
  if (reachMachines.size > 0)
    for (const x of changed)
      for (const id of holdersReaching(sql, OWNER_ORG_ID, x))
        for (const row of all<{ machineId: string; namespace: string }>(
          sql,
          "select machine_id as machineId, namespace from agents where id = ? and org_id = ? and live = 1",
          id,
          OWNER_ORG_ID,
        )) {
          if (!reachMachines.has(row.machineId) || wanted.has(row.namespace))
            continue;
          const cur = out.get(row.machineId);
          // `changed` itself is shared by every global machine: copy, never push.
          if (cur === changed)
            out.set(row.machineId, [...changed, row.namespace]);
          else if (cur) {
            if (!cur.includes(row.namespace)) cur.push(row.namespace);
          } else out.set(row.machineId, [row.namespace]);
        }
  return out;
}

function directAudience(
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
type RosterChange = {
  namespaces: string[];
  global: boolean;
  /** #1567: a link change; only links-capable sockets hear it. */
  linksOnly?: boolean;
  /** #1346: a reach change; only reach-capable sockets hear it. */
  reachOnly?: boolean;
};

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
    .filter(
      (w) =>
        w !== except &&
        w.readyState === OPEN &&
        !isReplaced(w) &&
        (change.linksOnly !== true || linksGated(w)) &&
        (change.reachOnly !== true || reachGated(w)),
    );
  if (sockets.length === 0) return;
  const linkMachines = new Set(
    sockets
      .filter((w) => linksGated(w))
      .map(machineOf)
      .filter((m): m is string => m !== null),
  );
  const reachMachines = new Set(
    sockets
      .filter((w) => reachGated(w))
      .map(machineOf)
      .filter((m): m is string => m !== null),
  );
  const machines = [
    ...new Set(sockets.map(machineOf).filter((m): m is string => m !== null)),
  ];
  const audience = change.global
    ? everyDaemonAudience(ctx.storage.sql)
    : rosterAudience(
        ctx.storage.sql,
        changed,
        machines,
        linkMachines,
        reachMachines,
      );
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

/** #1984: most proofs a live session holds; a newer bind evicts the oldest. */
export const PROOFS_PER_SESSION = 4;

/**
 * #2110: how long a session closed into away (sessions{closed}: the daemon's
 * liveness close, a daemon restart) keeps its proofs. Within it agentByProof
 * still resolves them, to that row only, so a reconnect or a restart that
 * re-registers the session never reads unlinked. A close for good drops them
 * at once (dropProofs); the alarm sweeps the rest after it.
 */
export const PROOF_AWAY_GRACE_MS = 120_000;

/** #2110: drops every proof of the agents in `ids` (a JSON array of ids). */
function dropProofs(sql: SqlStorage, ids: string): void {
  sql.exec(
    "delete from agent_proofs where agent_id in (select value from json_each(?))",
    ids,
  );
}

/**
 * #1822: adds the hash of `agentId`'s proof to the session's proofs (at most
 * PROOFS_PER_SESSION: the oldest goes) and mints the agent's identity_id at
 * its first bind. Another row holding the same hash loses it, so a hash names
 * one session. `agents.proof_hash` mirrors the newest proof.
 */
function bindProof(sql: SqlStorage, agentId: string, hash: string): void {
  const lost = all<{ agent_id: string }>(
    sql,
    "delete from agent_proofs where hash = ? and agent_id != ? returning agent_id",
    hash,
    agentId,
  );
  sql.exec(
    `insert into agent_proofs (hash, agent_id, seq)
     values (?, ?, (select coalesce(max(seq), 0) + 1 from agent_proofs))
     on conflict (hash) do update set agent_id = excluded.agent_id, seq = excluded.seq`,
    hash,
    agentId,
  );
  sql.exec(
    `delete from agent_proofs where agent_id = ? and hash not in
       (select hash from agent_proofs where agent_id = ? order by seq desc limit ?)`,
    agentId,
    agentId,
    PROOFS_PER_SESSION,
  );
  sql.exec(
    "update agents set identity_id = coalesce(identity_id, ?) where id = ?",
    randomHex(32),
    agentId,
  );
  for (const id of [agentId, ...lost.map((r) => r.agent_id)])
    sql.exec(
      "update agents set proof_hash = (select hash from agent_proofs where agent_id = agents.id order by seq desc limit 1) where id = ?",
      id,
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
  // #1295: a close reserves the name for MAILBOX_RETAIN_MS (`away`), not the
  // 1 h `held` a move or flip leaves. A revoke holds nothing
  // (releaseMachineNames).
  return awayNames(sql, ids, now);
}

/**
 * #1295: a closed agent's CURRENT name (its agents row, closed just now)
 * becomes an `away` former_names row in its scope, ending MAILBOX_RETAIN_MS
 * after agents.away_since (the close, or for a reaped agent when its machine
 * went offline). Like `held` it reserves the name (nameTaken, putRole) and
 * never resolves as a former name; unlike it, a send to the name reaches
 * the agent's mailbox (awayAgent) and the agent's reopen takes it back
 * (commitName drops the row). It replaces the agent's row for that name and
 * scope. `ids` is a JSON array. Returns the latest end, for the alarm.
 */
function awayNames(sql: SqlStorage, ids: string, now: number): number | null {
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
     select id, org_id, name, lower(name), 'away', coalesce(away_since, ?) + ?, namespace, global from agents
      where id in (select value from json_each(?))`,
    now,
    MAILBOX_RETAIN_MS,
    ids,
  );
  return (
    one<{ t: number | null }>(
      sql,
      "select max(expires_at) as t from former_names where kind = 'away' and agent_id in (select value from json_each(?))",
      ids,
    )?.t ?? null
  );
}

/**
 * #1448: a revoked machine's agents never come back (a re-approved
 * workstation is a new machine with new agent ids), so the revoke frees
 * every name they hold or reserve at once: the held names of agents closed
 * before or by the revoke, and their chosen, default and (#1295) `away`
 * former names, in every scope. A re-approved machine, or anyone, then gets
 * the plain names; agents of other machines keep theirs. Minted names stay
 * minted (OpenBus #446: never handed to another agent). The rename log of
 * the agents the revoke closed (`closedIds`) goes too.
 *
 * #1295: returns the ids of the machine's agents that were away (closed
 * with a reservation still running): they can still hold pending mail, so
 * revokeMachine adds them to its drain, which expires that mail `revoked`.
 *
 * Bounded (M2): never walks more than the machine's closed agents
 * (agents_machine_closed, at most CLOSED_AGENTS_PER_MACHINE). The agents the
 * revoke closed lose every row by former_names_agent (at most
 * maxAgentsPerMachine agents). Other agents closed before it can block a
 * name only through a held or chosen row still in its grace, found from
 * former_names_due (rows unexpired now: bounded by the last hour's renames
 * and closes, not by history), each checked against its agent by primary
 * key. Expired rows reserve nothing; the alarm purges them.
 */
function releaseMachineNames(
  sql: SqlStorage,
  machineId: string,
  closedIds: string[],
  now: number,
): string[] {
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
  const away = all<{ id: string }>(
    sql,
    `select distinct f.agent_id as id
       from (select id from agents indexed by agents_machine_closed
              where machine_id = ? and live = 0 limit ?) a
       join former_names f indexed by former_names_agent on f.agent_id = a.id
      where f.kind = 'away' and f.expires_at > ?`,
    machineId,
    CLOSED_AGENTS_PER_MACHINE,
    now,
  ).map((r) => r.id);
  if (away.length > 0)
    sql.exec(
      "delete from former_names where kind = 'away' and agent_id in (select value from json_each(?))",
      JSON.stringify(away),
    );
  sql.exec(
    `delete from former_names where rowid in
       (select f.rowid from former_names f indexed by former_names_due
          join agents a on a.id = f.agent_id
         where f.expires_at > ? and f.kind in ('chosen', 'held')
           and a.machine_id = ?)`,
    now,
    machineId,
  );
  return away;
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
  /** #1742: the away agent whose reservation of `name` the newcomer takes over (takeAwayName). */
  reclaim?: string;
};

/**
 * #1916: the name a harness proposal asks for. A harness-made title that reads
 * as prose (candidateName's `harness` option) or that starts with another live
 * agent's full name plus more than one word becomes the fallback. Scope is
 * nameTaken's: the namespace plus globals (a global: every namespace). Only
 * LIVE agents count: an away or held name is on no roster, so a newcomer
 * cannot pose as it, and counting them would block honest names for the
 * whole retention. `<other>-N`, `<other> fork` and `<other> X` (one extra
 * word, e.g. `OA Platform B` next to `OA Platform`) stay legit.
 * A user's rename never comes through here (harness false).
 */
function harnessAsked(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
  harness: boolean,
): string {
  const asked = candidateName(proposed, { harness });
  if (!harness || asked === FALLBACK_BUS_NAME) return asked;
  const scope = global ? "" : "and (namespace = ? or global = 1)";
  const live = all<{ name: string }>(
    sql,
    `select name from agents where org_id = ? and live = 1 and id != ? ${scope}`,
    OWNER_ORG_ID,
    selfId,
    ...(global ? [] : [namespace]),
  );
  return live.some((a) => impersonates(asked, a.name))
    ? FALLBACK_BUS_NAME
    : asked;
}

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
  reclaim?: { kind: string },
  harness = false,
): Assigned {
  if (kind === "default")
    return mintName(sql, namespace, proposed, global, selfId, now);
  const free = (n: string) =>
    !nameTaken(sql, namespace, n, global, selfId, now);
  const asked = harnessAsked(sql, namespace, proposed, global, selfId, harness);
  for (const base of new Set([asked, FALLBACK_BUS_NAME])) {
    if (free(base)) return { name: base, mint: null };
    // #1742: only the exact chosen name is ever taken back, never a suffix.
    // #1480: and never one reached by dropping refused characters: `OA Manager!`
    // is not `OA Manager`.
    if (
      reclaim &&
      base === asked &&
      !droppedRefusedChars(proposed, { harness })
    ) {
      const from = awayHolder(
        sql,
        namespace,
        base,
        global,
        selfId,
        reclaim.kind,
        now,
      );
      if (from !== null) return { name: base, mint: null, reclaim: from };
    }
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

/**
 * #1742: the agent whose `away` reservation is the ONLY thing keeping the
 * chosen `name` from `selfId`, when that agent is closed, on a machine
 * that is not revoked, of `kind`, and reserved the name in exactly this scope; else null. Anything
 * else blocks as in nameTaken: a live holder, any other former row (held,
 * chosen, another agent's, another scope's), a role, a name minted for
 * anyone else (a minted name is never reclaimed), and a harness fallback
 * name (below). Writes nothing; runs only
 * when the name is taken. Two bounded probes on former_names_lname.
 */
function awayHolder(
  sql: SqlStorage,
  namespace: string,
  name: string,
  global: boolean,
  selfId: string,
  kind: string,
  now: number,
): string | null {
  const lname = name.toLowerCase();
  // Only a name someone gave the session. A harness fallback is never
  // reclaimed (the daemon sends no name_kind, so it reads as chosen): the
  // kind itself (codex, opencode, pi, omp, hermes, openclaw...), `<kind>-...`
  // (Hermes proposes `hermes-<cwd>`), the hub's `agent`, Claude's
  // `claude-<digits>`. An unrelated new thread of that kind must not take
  // over its mail.
  if (isFallbackName(name, kind)) return null;
  const rows = all<{
    agentId: string;
    kind: string;
    global: number;
    namespace: string;
    live: number | null;
    agentKind: string | null;
    revoked: number | null;
  }>(
    sql,
    `select f.agent_id as agentId, f.kind as kind, f.global as global, f.namespace as namespace,
            a.live as live, a.kind as agentKind,
            (m.revoked_at is not null) as revoked
       from former_names f indexed by former_names_lname
       left join agents a on a.id = f.agent_id
       left join machines m on m.id = a.machine_id
      where f.org_id = ? and f.lname = ? and f.expires_at > ?
        and f.kind in ('chosen', 'held', 'away') and f.agent_id is not ?${global ? "" : " and (f.namespace = ? or f.global = 1)"}
      limit 2`,
    OWNER_ORG_ID,
    lname,
    now,
    selfId,
    ...(global ? [] : [namespace]),
  );
  const r = rows[0];
  if (
    rows.length !== 1 ||
    !r ||
    r.kind !== "away" ||
    r.global !== (global ? 1 : 0) ||
    (!global && r.namespace !== namespace) ||
    r.live !== 0 ||
    r.agentKind !== kind ||
    r.revoked === 1
  )
    return null;
  // Nothing else holds it: no live agent, no role, and no minted name (the
  // old agent's own included, which nameTaken skips for it).
  if (nameTaken(sql, namespace, name, global, r.agentId, now)) return null;
  // #1346: mail that crossed a namespace boundary (admitted by a reach grant,
  // which may be gone by now) waits for its holder: the newcomer may hold no
  // such grant. Pending in-session mail from another namespace blocks the
  // takeover unless its sender is global or its namespace is linked to the
  // holder's. A sender row that no longer exists counts as not global.
  const holder = one<{ ns: string; global: number; start: number }>(
    sql,
    "select namespace as ns, global, session_start_rowid as start from agents where id = ?",
    r.agentId,
  );
  if (holder === null) return null;
  if (holder.global !== 1) {
    const foreign = all<{ ns: string }>(
      sql,
      `select distinct rc.namespace as ns
         from receipts rc indexed by receipts_to
         left join agents s on s.id = rc.from_agent
        where rc.to_agent = ? and rc.state = 'pending' and rc.rowid > ?
          and rc.namespace <> ? and coalesce(s.global, 0) <> 1`,
      r.agentId,
      holder.start,
      holder.ns,
    );
    for (const f of foreign)
      if (!isLinked(sql, OWNER_ORG_ID, holder.ns, f.ns)) return null;
  }
  const minted = one(
    sql,
    "select 1 as x from minted_names where org_id = ? and lname = ?",
    OWNER_ORG_ID,
    lname,
  );
  return minted === null ? r.agentId : null;
}

/**
 * #1742: the newcomer `toId` takes `name` over from the away agent `fromId`
 * (awayHolder said it may). The away reservation is released, so the name
 * resolves only to the newcomer, and the mail still queued for the old row
 * (pending, inside its session) moves to the newcomer, oldest first, as much
 * as the newcomer's own mailbox caps allow (the rest stays with the old row
 * and expires on its TTL). Moved receipts are renumbered past every rowid,
 * keeping their order, because the newcomer's session boundary
 * (session_start_rowid) is above them: it must receive them, and it must not
 * be able to see anything the old session had acked. Acked bodies never
 * move: they are deleted, the old row keeps none. Returns the moved msg_ids.
 * Bounded by MAILBOX_PENDING_CAP.
 *
 * #1816: the roles the old row held move to the newcomer too, so a restarted
 * lead keeps its role. A role with a reach_grants row stays with the old row
 * (vacant): holding it grants cross-namespace reach, which needs the member's
 * confirmation (#1346), so it is re-pointed, never passed silently. Only
 * roles in the reclaim's scope move (a global's any, else `namespace`'s).
 */
function takeAwayName(
  sql: SqlStorage,
  fromId: string,
  toId: string,
  name: string,
  namespace: string,
  global: boolean,
  now: number,
): string[] {
  sql.exec(
    "delete from former_names where agent_id = ? and kind = 'away' and lname = ? and global = ? and (global = 1 or namespace = ?)",
    fromId,
    name.toLowerCase(),
    global ? 1 : 0,
    namespace,
  );
  sql.exec(
    `update roles set agent_id = ? where org_id = ? and agent_id = ?
       and (? = 1 or roles.namespace = ?)
       and not exists (select 1 from reach_grants g
                        where g.org_id = roles.org_id and g.role_ns = roles.namespace and g.lname = roles.lname)`,
    toId,
    OWNER_ORG_ID,
    fromId,
    global ? 1 : 0,
    namespace,
  );
  while (deleteDeliveredBodies(sql, fromId, 500) >= 500) {
    // Next page.
  }
  // #1822: the session link follows the name, but only between two sessions
  // of one machine.
  const idFrom = one<{ identityId: string | null }>(
    sql,
    `select f.identity_id as identityId from agents f join agents t on t.machine_id = f.machine_id
      where f.id = ? and t.id = ?`,
    fromId,
    toId,
  );
  if (idFrom?.identityId) {
    sql.exec(
      "update agents set identity_id = ? where id = ?",
      idFrom.identityId,
      toId,
    );
    sql.exec(
      "update agents set identity_id = null, proof_hash = null where id = ?",
      fromId,
    );
    sql.exec("delete from agent_proofs where agent_id = ?", fromId);
  }
  const have = one<{ n: number; b: number }>(
    sql,
    "select count(*) as n, coalesce(sum(size), 0) as b from (select size from receipts indexed by receipts_to where to_agent = ? and state = 'pending' limit ?)",
    toId,
    MAILBOX_PENDING_CAP,
  );
  const moved = all<{ id: string; rid: number }>(
    sql,
    `select id, rid from (
       select r.id as id, r.rowid as rid, count(*) over w as n, sum(r.size) over w as b
         from receipts r indexed by receipts_to
         join agents a on a.id = r.to_agent
        where r.to_agent = ? and r.state = 'pending' and r.rowid > a.session_start_rowid
       window w as (order by r.rowid)
     ) where n <= ? and b <= ? order by rid`,
    fromId,
    MAILBOX_PENDING_CAP - (have?.n ?? 0),
    MAILBOX_BYTES_CAP - (have?.b ?? 0),
  );
  const first = moved[0];
  if (!first) return [];
  const top =
    one<{ n: number }>(sql, "select max(rowid) as n from receipts")?.n ?? 0;
  const ids = JSON.stringify(moved.map((m) => m.id));
  sql.exec(
    "update receipts set to_agent = ?, to_name = ?, rowid = rowid + ? where id in (select value from json_each(?))",
    toId,
    name,
    top + 1 - first.rid,
    ids,
  );
  sql.exec(
    "update mail set to_agent = ? where id in (select value from json_each(?))",
    toId,
    ids,
  );
  return moved.map((m) => m.id);
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
  // A default name is the harness's own, never a user's (#1916).
  const proposedBase = harnessAsked(
    sql,
    namespace,
    proposed,
    global,
    selfId,
    true,
  );
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
      "select count(*) as n from former_names where agent_id = ? and kind not in ('held', 'away')",
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
  /** #1742: msg_ids that moved to this agent from an away row it took the name from. */
  moved: string[];
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
  // #1295: a reopen of a closed agent with an unexpired `away` row keeps its
  // session boundary, so the mail pending to it flushes on this agent_up.
  const awayKept =
    existing !== null &&
    existing.live !== 1 &&
    one(
      sql,
      "select 1 as x from former_names indexed by former_names_agent where agent_id = ? and expires_at > ? and kind = 'away' limit 1",
      existing.id,
      now,
    ) !== null;
  // The old session's acked notices must not be fetchable by the new one:
  // the kept boundary no longer hides them, so their bodies go now (the
  // agent is not live yet, nothing can fetch in between).
  if (awayKept && existing)
    while (deleteDeliveredBodies(sql, existing.id, 500) >= 500) {
      // Next page.
    }
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
    { kind: f.kind },
    // #1916: agent_up carries the harness's title (the daemon sends renames,
    // user-made, as `rename` frames). An agent keeping its own current name
    // is not a new title, so neither rule touches it. Claude Code only writes a
    // session name from /rename or /fork, never an auto prose title, so its
    // agent_up is the user's choice (a fork title is still cut to "<parent>
    // fork" by candidateName itself).
    f.kind !== "claude-code" &&
      !(
        existing &&
        candidateName(f.proposed_name).toLowerCase() ===
          existing.name.toLowerCase()
      ),
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
  // #2110: a reopen keeps the proofs only of a row that went away less than
  // PROOF_AWAY_GRACE_MS ago; any other closed row's are dropped first; the
  // kept ones show again as agents.proof_hash.
  if (existing && existing.live !== 1)
    sql.exec(
      `delete from agent_proofs where agent_id = ? and exists (select 1 from agents
        where id = ? and live = 0 and (away_since is null or away_since <= ?))`,
      id,
      id,
      now - PROOF_AWAY_GRACE_MS,
    );
  // A new session starts when the agent was not live (B11): its boundary is
  // the newest receipt's rowid (receipts rowids only grow: the retention
  // purge never deletes the newest), so the old session's mail is never
  // served to it (fetch, flush, ack and the inbox cap take rowid > it).
  if (existing)
    sql.exec(
      "update agents set namespace = ?, name = ?, kind = ?, global = ?, live = 1, updated_at = ?, away_since = null, session_start_rowid = case when live = 1 or ? = 1 then session_start_rowid else (select coalesce(max(rowid), 0) from receipts) end where id = ?",
      f.namespace,
      name,
      f.kind,
      f.global ? 1 : 0,
      now,
      awayKept ? 1 : 0,
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
  // #2311: the harness says a user or a peer named this session. Never undone here.
  if (f.name_chosen === true)
    sql.exec("update agents set name_chosen = 1 where id = ?", id);
  if (existing && existing.live !== 1)
    sql.exec(
      "update agents set proof_hash = (select hash from agent_proofs where agent_id = agents.id order by seq desc limit 1) where id = ?",
      id,
    );
  // OpenBus #451: a namespace move or a global flip keeps the chosen former
  // names reserved in the old scope, where they resolve to no one.
  if (existing && !sameScope) keepScopedNames(sql, id, now);
  commitName(sql, id, assigned, to, now);
  // #1742: a name only an away row of a closed session held.
  const moved =
    assigned.reclaim === undefined
      ? []
      : takeAwayName(
          sql,
          assigned.reclaim,
          id,
          name,
          f.namespace,
          f.global,
          now,
        );
  // #1295: an `away` row the reopen did not take back (another name or
  // scope) falls back to the 1 h hold a close used to leave.
  if (existing && !wasLive) {
    const grace = now + LIMITS.formerNameGraceMs;
    const fell = all(
      sql,
      "update former_names set kind = 'held', expires_at = min(expires_at, ?) where agent_id = ? and kind = 'away' returning rowid",
      grace,
      id,
    );
    if (fell.length > 0) arms.push(grace);
  }
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
    moved,
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

/**
 * #1295: the daemon says `agent_ref` is the old `replaces` session of the same
 * live process (a /clear). The old ref's agent row is re-keyed to the new ref,
 * so the agent_up that follows reopens it: same name and former names, and its
 * pending mail (kept or flushed) instead of `<name>-2`. Only an agent of this
 * same machine, only when the new ref is not already known; otherwise nothing
 * changes and the new ref registers as any other. An old session still open
 * is closed first into `away` (its address kept), so the agent_up always
 * takes the reopen path: the old session's delivered bodies go, its pending
 * mail stays.
 */
function takeOver(
  sql: SqlStorage,
  machineId: string,
  oldRef: string,
  newRef: string,
  now: number,
): void {
  if (oldRef === newRef) return;
  if (
    one(
      sql,
      "select 1 as x from agents where machine_id = ? and native_ref = ?",
      machineId,
      newRef,
    ) !== null
  )
    return;
  const taken = one<{ id: string; live: number }>(
    sql,
    "update agents set native_ref = ? where machine_id = ? and native_ref = ? and org_id = ? returning id, live",
    newRef,
    machineId,
    oldRef,
    OWNER_ORG_ID,
  );
  if (!taken) return;
  // The old session's proofs end here: the new session binds its own.
  dropProofs(sql, JSON.stringify([taken.id]));
  if (taken.live !== 1) return;
  sql.exec(
    `update agents set live = 0, last_name = name, updated_at = ?, away_since = ?, ${CLOSE_CLEAR} where id = ?`,
    now,
    now,
    taken.id,
  );
  awayNames(sql, JSON.stringify([taken.id]), now);
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
    `update agents set live = 0, last_name = name, updated_at = ?, away_since = ?, ${CLOSE_CLEAR} where machine_id = ? and native_ref = ? and live = 1 and org_id = ? returning id, namespace, global`,
    now,
    now,
    machineId,
    ref,
    OWNER_ORG_ID,
  );
  // #2110: agent_down is the session ending for good: no away grace.
  if (a) dropProofs(sql, JSON.stringify([a.id]));
  return a;
}

/**
 * The namespaces besides its own that a non-global agent sees and reaches:
 * those linked to its own (#1567, `withLinks`) and those its roles reach
 * (#1346, `withReach`), sorted, never its own. Empty for a global agent or a
 * socket without either cap, so every path using it is today's.
 */
function scopeNamespaces(
  sql: SqlStorage,
  agent: AgentRow,
  withLinks: boolean,
  withReach: boolean,
): string[] {
  if (agent.global === 1) return [];
  const out = new Set<string>();
  if (withLinks)
    for (const n of linkedNamespaces(sql, OWNER_ORG_ID, agent.namespace))
      out.add(n);
  if (withReach)
    for (const n of reachNamespaces(sql, OWNER_ORG_ID, agent.id)) out.add(n);
  out.delete(agent.namespace);
  return [...out].sort();
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
  withAway = false,
  withLinks = false,
  withReach = false,
  withWaiting = false,
): ServerFrame {
  const sql = ctx.storage.sql;
  const cap = LIMITS.maxRosterAgents;
  // #1567: a links-capable non-global socket also sees the namespaces linked
  // to its own (direct links only). Own namespace first, then linked ones.
  // #1346: a reach-capable one also sees what its roles reach.
  const linked = scopeNamespaces(sql, agent, withLinks, withReach);
  const nsRank = (ns: string) =>
    linked.length === 0
      ? 0
      : ns === agent.namespace
        ? 0
        : linked.includes(ns)
          ? 1
          : 2;
  const byScope = (a: AgentRow, b: AgentRow) =>
    nsRank(a.namespace) !== nsRank(b.namespace)
      ? nsRank(a.namespace) - nsRank(b.namespace)
      : a.namespace === b.namespace
        ? a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0
        : a.namespace < b.namespace
          ? -1
          : 1;
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
    const lived =
      linked.length === 0
        ? []
        : all<AgentRow>(
            sql,
            `select ${AGENT_COLS} from agents where org_id = ? and live = 1 and namespace in (select value from json_each(?)) order by namespace, name limit ?`,
            OWNER_ORG_ID,
            JSON.stringify(linked),
            cap,
          );
    const seen = new Set(local.map((r) => r.id));
    for (const r of lived) seen.add(r.id);
    rows = [...local, ...lived, ...globals.filter((r) => !seen.has(r.id))]
      .sort(byScope)
      .slice(0, cap);
  }
  // #1295: a mailbox-capable socket also sees the agents away in its scope.
  if (withAway) {
    const scopeNs = [agent.namespace, ...linked];
    const scope =
      agent.global === 1
        ? ""
        : `and (f.global = 1 or f.namespace in (select value from json_each(?)))`;
    const away = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 0 and id in
         (select f.agent_id from former_names f
            join agents a on a.id = f.agent_id
            left join machines m on m.id = a.machine_id
           where f.org_id = ? and f.kind = 'away' and f.expires_at > ?
             and a.live = 0 and m.revoked_at is null ${scope})
       order by ${linked.length === 0 ? "" : "(namespace = ?) desc, "}namespace, name limit ?`,
      OWNER_ORG_ID,
      OWNER_ORG_ID,
      now,
      ...(agent.global === 1 ? [] : [JSON.stringify(scopeNs)]),
      ...(linked.length === 0 ? [] : [agent.namespace]),
      cap,
    );
    if (away.length > 0) rows = [...rows, ...away].sort(byScope).slice(0, cap);
  }
  const awaySince = new Map<string, number>();
  /** #2029: pending mail per away row, counted up to WAITING_CAP. */
  const waiting = new Map<string, number>();
  if (withAway) {
    const ids = rows.filter((r) => r.live !== 1).map((r) => r.id);
    if (ids.length > 0)
      for (const r of all<{ id: string; t: number | null }>(
        sql,
        "select id, away_since as t from agents where id in (select value from json_each(?))",
        JSON.stringify(ids),
      ))
        if (r.t !== null) awaySince.set(r.id, r.t);
    if (withWaiting && ids.length > 0)
      for (const [id, n] of waitingCounts(sql, ids)) waiting.set(id, n);
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
        state: r.live === 1 ? stateOf(r.machineId) : ("away" as const),
        ...(r.live !== 1 && awaySince.has(r.id)
          ? { since: new Date(awaySince.get(r.id) as number).toISOString() }
          : {}),
        ...(r.live !== 1 && waiting.has(r.id)
          ? { waiting: waiting.get(r.id) as number }
          : {}),
        // The key is omitted, never null, if a row's machine has no label.
        ...(label === undefined ? {} : { machine_label: label }),
        ...statusWire(r),
        ...(former === undefined ? {} : { former_names: former }),
      };
    }),
  };
}

/** #2029: the most pending mail a roster away row counts. */
const WAITING_CAP = 100;

/** Pending mail per agent id, each counted up to WAITING_CAP; ids with none are absent. */
function waitingCounts(
  sql: SqlStorage,
  ids: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  for (const r of all<{ id: string; n: number }>(
    sql,
    `select to_agent as id, count(*) as n from (
       select to_agent, row_number() over (partition by to_agent order by rowid) as rn
         from receipts indexed by receipts_to
        where to_agent in (select value from json_each(?)) and state = 'pending'
     ) where rn <= ? group by to_agent`,
    JSON.stringify(ids),
    WAITING_CAP,
  ))
    out.set(r.id, r.n);
  return out;
}

/**
 * #2079: pending mail for `refs`, only those that are away agents of
 * `machineId` (a ref of another machine, unknown or live is left out).
 */
function waitingByRef(
  sql: SqlStorage,
  machineId: string,
  refs: readonly string[],
): Record<string, number> {
  const rows = all<{ id: string; ref: string }>(
    sql,
    `select id, native_ref as ref from agents
      where org_id = ? and machine_id = ? and live = 0
        and native_ref in (select value from json_each(?))`,
    OWNER_ORG_ID,
    machineId,
    JSON.stringify(refs),
  );
  const counts = waitingCounts(
    sql,
    rows.map((r) => r.id),
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const n = counts.get(r.id);
    if (n) out[r.ref] = n;
  }
  return out;
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
      where f.agent_id in (select value from json_each(?)) and f.expires_at > ? and f.kind not in ('held', 'away')
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
  a.status_label as statusLabel, a.status_at as statusAt, a.away_since as awaySince,
  a.name_chosen as nameChosen,
  exists (select 1 from minted_names mn where mn.agent_id = a.id and mn.lname = lower(a.name)) as minted,
  exists (select 1 from roles ro where ro.org_id = a.org_id and ro.agent_id = a.id) as roleHolder`;

/**
 * The dashboard's agent list (snapshot, GET /api/v1/bus/agents). Open agents
 * of unrevoked machines, joined to machines (primary key) for the label. All
 * agents: one ordered scan of agents_live_ns_lname, stopping at the cap. One
 * namespace: that namespace on agents_live_ns_lname plus the globals on
 * agents_global_name, merged here (as roster() does).
 */
function agentList(
  ctx: DurableObjectState,
  namespace?: string,
  withAway = false,
): BusAgent[] {
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
  // #1295 part C: away agents (closed, name still reserved) are listed only on
  // request (the @ menu); Roster.tsx and ShareNotices would show them as Queued
  // or offer them as targets, so every other reader gets open agents only.
  if (withAway) {
    const away = all<AgentWithMachine>(
      sql,
      `select ${AGENT_DTO_COLS} ${from} where a.org_id = ? and a.live = 0 and m.revoked_at is null
         and a.id in (select f.agent_id from former_names f
           where f.org_id = ? and f.kind = 'away' and f.expires_at > ?)
       order by a.namespace, lower(a.name), a.name limit ?`,
      OWNER_ORG_ID,
      OWNER_ORG_ID,
      Date.now(),
      cap,
    );
    // Open agents first, then away, together at most `cap` (away rows count).
    rows = [...rows, ...away].slice(0, cap);
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

/**
 * #1295: the closed agent whose `away` reservation (unexpired) holds `lname`
 * in scope `ns` (its namespace, or a global), or any scope for null: a send
 * to its name queues in its mailbox. Not an agent of a revoked machine;
 * `ambiguous` when two non-global agents are away under the name. One
 * probe on former_names_lname.
 */
function awayAgent(
  sql: SqlStorage,
  ns: string | null,
  lname: string,
  now: number,
): Resolution | null {
  const scope = ns === null ? "" : "and (f.global = 1 or f.namespace = ?)";
  const rows = all<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where live = 0 and id in
       (select f.agent_id from former_names f indexed by former_names_lname
          join agents a on a.id = f.agent_id
          left join machines m on m.id = a.machine_id
         where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind = 'away'
           and a.live = 0 and m.revoked_at is null ${scope}
         order by f.expires_at desc limit 2)
     order by global desc`,
    OWNER_ORG_ID,
    lname,
    now,
    ...(ns === null ? [] : [ns]),
  );
  const first = rows[0];
  if (!first) return null;
  // Two agents away under one name (a global's too): ambiguous, never a guess.
  if (rows.length > 1) return refused("ambiguous");
  return { ok: true, agent: first };
}

/**
 * #1295: whether `lname` is only a `held` reservation (a name a moved or
 * flipped agent left, 1 h) in scope `ns` (its namespace, or a global), or
 * any scope for null. It has no mailbox: a send to it is `reserved_name`.
 */
function heldName(
  sql: SqlStorage,
  ns: string | null,
  lname: string,
  now: number,
): boolean {
  const scope = ns === null ? "" : "and (f.global = 1 or f.namespace = ?)";
  return (
    one(
      sql,
      `select 1 as x from former_names f indexed by former_names_lname
        where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind = 'held' ${scope} limit 1`,
      OWNER_ORG_ID,
      lname,
      now,
      ...(ns === null ? [] : [ns]),
    ) !== null
  );
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
                   where f.org_id = ? and f.lname = ? and f.expires_at > ? and f.kind not in ('held', 'away')
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
                         and (f.kind in ('chosen', 'held', 'away')
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
           and (f.kind in ('chosen', 'held', 'away')
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
  withLinks = false,
  withReach = false,
  withMailbox = false,
): Resolution {
  const lname = toName.toLowerCase();
  // #1349: an away role holder takes mail only for a mailbox-capable sender.
  const awayAt = withMailbox ? now : undefined;
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
    const role = resolveRoleIn(sql, OWNER_ORG_ID, ns, lname, awayAt);
    if (role) return role;
    const hit = liveVisibleIn(sql, ns, lname);
    return hit ? { ok: true, agent: hit } : formerIn({ ns });
  };
  // #1567: the namespaces directly linked to the sender's (never transitive),
  // for a links-capable non-global sender only. Any other sender has none, so
  // every path below is today's.
  // #1346: the namespaces its roles reach join them, for a reach-capable one.
  const linked = scopeNamespaces(sql, sender, withLinks, withReach);
  if (sender.global !== 1) {
    if (toNamespace !== undefined && linked.includes(toNamespace)) {
      // A linked namespace is reached as a global sender reaches any.
      const hit = visibleIn(toNamespace);
      if (hit) return hit;
      const away = awayAgent(sql, toNamespace, lname, now);
      if (away) return away;
      const gone = goneReason(sql, toNamespace, lname);
      if (gone) return refused(gone);
      if (heldName(sql, toNamespace, lname, now))
        return refused("reserved_name");
      return refused("unknown_agent");
    }
    if (toNamespace !== undefined && toNamespace !== sender.namespace) {
      // Only a live global homed in X is reachable. Everything else is the
      // same refusal, so it cannot probe what exists in another namespace.
      const hit = liveGlobalHomedIn(sql, toNamespace, lname);
      if (hit) return { ok: true, agent: hit };
      // #1346: the reply path. The agent in X whose role reaches the sender's
      // namespace may be answered, by that one agent only, however it is
      // named: its live or away name, a former name, or the role's own name
      // (a reach-capable sender; the holder is not in the sender's roster).
      if (withReach) {
        const back = (r: Resolution | null): Resolution | null =>
          r?.ok &&
          r.agent.global !== 1 &&
          holderReaches(sql, OWNER_ORG_ID, r.agent.id, sender.namespace)
            ? r
            : null;
        const reply =
          back(resolveRoleIn(sql, OWNER_ORG_ID, toNamespace, lname, awayAt)) ??
          back(
            (() => {
              const h = liveVisibleIn(sql, toNamespace, lname);
              return h ? { ok: true as const, agent: h } : null;
            })(),
          ) ??
          back(awayAgent(sql, toNamespace, lname, now)) ??
          back(formerIn({ ns: toNamespace }));
        if (reply) return reply;
      }
      return formerIn({ homedIn: toNamespace }) ?? refused("other_namespace");
    }
    const hit = visibleIn(sender.namespace);
    if (hit) return hit;
    // B9: the newest closed agent with the name says revoked or closed.
    const away = awayAgent(sql, sender.namespace, lname, now);
    if (away) return away;
    const gone = goneReason(sql, sender.namespace, lname);
    if (gone) return refused(gone);
    if (heldName(sql, sender.namespace, lname, now))
      return refused("reserved_name");
    // #1567: only a clean miss in the sender's own namespace (live, role,
    // former, away, gone, held) tries the linked ones, and only when the send
    // names no namespace. Live first, then away. One hit resolves; hits in
    // two of them are ambiguous (the sender names `to_namespace`).
    if (linked.length > 0 && toNamespace === undefined) {
      const keyOf = (h: Resolution) => (h.ok ? h.agent.id : h.reason);
      const lives = new Map<string, Resolution>();
      const liveNs = new Set<string>();
      for (const ns of linked) {
        const h = visibleIn(ns);
        if (h) {
          lives.set(keyOf(h), h);
          liveNs.add(ns);
        }
      }
      const first = [...lives.values()];
      if (first.length > 1) return refused("ambiguous");
      const one1 = first[0];
      // A live agent resolves alone. A vacant or away role (#1816) is one
      // candidate among the away agents of the other linked namespaces.
      if (one1 && one1.ok && one1.agent.live === 1) return one1;
      const found = new Map<string, Resolution>(lives);
      for (const ns of linked) {
        if (liveNs.has(ns)) continue;
        const h = awayAgent(sql, ns, lname, now);
        if (h) found.set(keyOf(h), h);
      }
      const only = [...found.values()];
      if (only.length > 1) return refused("ambiguous");
      if (only[0]) return only[0];
    }
    // Other namespaces are invisible and unreachable (spec goal 5, scenario
    // 6): a name live only elsewhere is unknown_agent, so no probe can tell
    // it exists. other_namespace answers an explicit to_namespace only.
    return refused("unknown_agent");
  }
  if (toNamespace !== undefined) {
    const hit = visibleIn(toNamespace);
    if (hit) return hit;
    const away = awayAgent(sql, toNamespace, lname, now);
    if (away) return away;
    const gone = goneReason(sql, toNamespace, lname);
    if (gone) return refused(gone);
    if (heldName(sql, toNamespace, lname, now)) return refused("reserved_name");
    return refused("unknown_agent");
  }
  // R393b: the sender's own namespace first, current then former names.
  const own = visibleIn(sender.namespace);
  if (own) return own;
  // #1296: a role in exactly one other namespace, unless a live agent (or a
  // live former name) outside that namespace's scope shares the name.
  const role = resolveRoleAnywhere(
    sql,
    OWNER_ORG_ID,
    lname,
    (ns) => nameOutside(sql, lname, ns, now, sender.id),
    awayAt,
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
  const away = awayAgent(sql, null, lname, now);
  if (away) return away;
  const gone = goneReason(sql, null, lname);
  if (gone) return refused(gone);
  if (heldName(sql, null, lname, now)) return refused("reserved_name");
  return refused("unknown_agent");
}

/**
 * #1295: whether one more message of `size` bytes would pass the address's
 * caps: MAILBOX_PENDING_CAP pending receipts and MAILBOX_BYTES_CAP pending
 * bytes, counted across every session of the agent (live or away). Bounded
 * by the cap: the count stops at MAILBOX_PENDING_CAP rows (receipts_to).
 */
function inboxFull(sql: SqlStorage, agent: AgentRow, size: number): boolean {
  const row = one<{ n: number; b: number }>(
    sql,
    "select count(*) as n, coalesce(sum(size), 0) as b from (select size from receipts indexed by receipts_to where to_agent = ? and state = 'pending' limit ?)",
    agent.id,
    MAILBOX_PENDING_CAP,
  );
  return (
    (row?.n ?? 0) >= MAILBOX_PENDING_CAP ||
    (row?.b ?? 0) + size > MAILBOX_BYTES_CAP
  );
}

/**
 * #1295: a send receipt's `queued` and `since`, only to a mailbox-capable
 * socket, only when the mail is stored for a recipient with no session to
 * push to: `away` (closed, since its close) or `offline` (open, but its
 * machine is offline, since the machine went offline).
 */
function queuedWire(
  ws: WebSocket,
  ctx: DurableObjectState,
  agentId: string,
  now: number,
): { queued: "away" | "offline"; since: string } | Record<string, never> {
  if (!mailboxGated(ws)) return {};
  const sql = ctx.storage.sql;
  const a = one<{
    live: number;
    awaySince: number | null;
    machineId: string;
    disconnectedAt: number | null;
  }>(
    sql,
    `select a.live as live, a.away_since as awaySince, a.machine_id as machineId, m.disconnected_at as disconnectedAt
       from agents a left join machines m on m.id = a.machine_id where a.id = ?`,
    agentId,
  );
  if (!a) return {};
  if (a.live !== 1)
    return a.awaySince === null
      ? {}
      : { queued: "away", since: new Date(a.awaySince).toISOString() };
  if (machineOnline(ctx, a.machineId)) return {};
  return {
    queued: "offline",
    since: new Date(a.disconnectedAt ?? now).toISOString(),
  };
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
  final: number;
};
type SendKeyCheck =
  | { kind: "new"; hash: string; dropped: boolean }
  | { kind: "resend"; msgId: string; viaRole: boolean }
  | { kind: "reused" };

/**
 * B14: looks up the send key (sender agent id, frame id). A key exists only
 * for a send that created a pending receipt; a refused send stores none, so
 * its resend is evaluated again. A final key older than SEND_KEY_RETAIN_MS
 * that the alarm has not swept yet counts as gone (deleted here, so the fresh key
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
    "select payload_hash as payloadHash, msg_id as msgId, created_at as createdAt, via_role as viaRole, final from send_keys where from_agent = ? and frame_id = ?",
    agentId,
    f.id,
  );
  if (!key) return { kind: "new", hash, dropped: false };
  if (key.final !== 1 || key.createdAt >= now - SEND_KEY_RETAIN_MS)
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

/** B14: the send's key (if any) is final: its receipt just left pending (at `now`). */
function finalizeKey(sql: SqlStorage, msgId: string, now: number): void {
  // #1295: the dedupe window of a final key runs from when it went final
  // (created_at is reset to now), not from the send, which may be days ago.
  sql.exec(
    "update send_keys set final = 1, created_at = ? where msg_id = ?",
    now,
    msgId,
  );
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
     where r.id = ? and r.org_id = ? and a.machine_id = ?
       and (r.state = 'pending' or (? = 'delivered' and r.state = 'expired' and r.reason = 'lost_body'))
       and r.rowid > a.session_start_rowid`,
    msgId,
    OWNER_ORG_ID,
    machineId,
    outcome,
  );
  if (!r) return null;
  // R7 (accepted): an ack after expires_at but before the sweep counts as
  // delivered; the harness really did take it.
  if (outcome === "delivered")
    sql.exec(
      "update receipts set state = 'delivered', reason = null, notified_at = null, acked_at = ?, final_at = ? where id = ? and (state = 'pending' or (state = 'expired' and reason = 'lost_body'))",
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
  finalizeKey(sql, msgId, now);
  // A notice's body stays for fetch (#fetch deletes it); B7's expiry sweep
  // deletes it otherwise.
  if (outcome === "refused" || r.size <= LIMITS.inlineBodyBytes)
    sql.exec("delete from mail where id = ?", msgId);
  return r.fromAgent;
}

/**
 * Whether an ack from `machineId` for `msgId` could still settle later: its
 * own mail, in this session, pending (or lost_body). False for a repeat, an
 * unknown id, another machine's, or an old session's: the hub then answers
 * the ack with the same frame as a settled one, revealing nothing (#2198).
 */
function canStillSettle(
  sql: SqlStorage,
  machineId: string,
  msgId: string,
): boolean {
  return (
    one<{ n: number }>(
      sql,
      `select 1 as n from receipts r join agents a on a.id = r.to_agent
       where r.id = ? and r.org_id = ? and a.machine_id = ?
         and (r.state = 'pending' or (r.state = 'expired' and r.reason = 'lost_body'))
         and r.rowid > a.session_start_rowid`,
      msgId,
      OWNER_ORG_ID,
      machineId,
    ) !== null
  );
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
/** #1295: how often the hub-wide pending byte total is read again. */
const HUB_BYTES_REFRESH_MS = 30_000;
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
 * onOpen). The close is into `away` (#1295): the agent's name and its
 * queued mail are kept until away_since (the machine's disconnected_at) +
 * MAILBOX_RETAIN_MS, so a reopen within it still gets the mail.
 */
export const OFFLINE_REAP_MS = 24 * HOUR_MS;
/** Active machines that have live agents and an offline time, due first. */
const OFFLINE_DUE_SQL = `select id, disconnected_at as disconnectedAt from machines
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
 * sending again. #1295: the age applies only to a FINAL key (its receipt left
 * pending); a key of mail still pending (up to MAILBOX_RETAIN_MS) is never
 * dropped by age, so a pending send is never sent twice. A receipt outlives
 * its key: it stays pending at most MAILBOX_RETAIN_MS, then is kept RETAIN_MS
 * (24 h) past final or told.
 */
export const SEND_KEY_RETAIN_MS = 2 * LIMITS.mailTtlSec * 1000;
/**
 * B14: send keys kept per sender agent (MAILBOX_PENDING_CAP x 4 = 800). A new key past the cap
 * evicts that agent's oldest key whose send is final (delivered, expired or
 * refused), never a pending one, so a pending send is never delivered twice.
 * With every key pending (the agent has this many undelivered sends in
 * flight) the new send is refused `rate_limited` (SEND_KEYS_MESSAGE).
 * Trade-off: an evicted final send loses its dedupe (a late resend of it
 * sends again); a legitimate flood is already limited by the B11 frame
 * budget and the recipients' inbox caps.
 */
export const SEND_KEYS_PER_AGENT = MAILBOX_PENDING_CAP * 4;
/**
 * B14: send keys kept hub-wide. Agent ids are per (machine, native_ref) and
 * never deleted, so ref churn would multiply the per-agent cap; this bounds
 * the table. Same rule: evict the hub's oldest final key (send_keys_final, no scan
 * limit: refused only when no key anywhere is final), else `rate_limited`.
 * #1295: a key of pending mail now lives up to MAILBOX_RETAIN_MS (7 d) and is
 * never evicted, so one hub-wide cap shared by every sender could lock all
 * of them out for a week. It is raised tenfold (a key row with its indexes is
 * ~400-450 bytes: ~85 MB at the cap) instead of exempting away mail, which would leave the table
 * unbounded; the per-agent cap (800) still bounds each sender.
 */
export const SEND_KEYS_TOTAL = 200_000;
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
 * #2311: an away agent (live = 0) still carrying a harness default name
 * (isDefaultAgentName) and with no work left (IDLE_INBOX_SQL, IDLE_OUTBOX_SQL)
 * is deleted by the alarm this long after it closed, with its away
 * reservation. Renamed and role-named agents keep CLOSED_AGENT_RETAIN_MS and
 * the away reservation.
 */
export const DEFAULT_NAME_AWAY_MS = HOUR_MS;
const DEFAULT_PURGE_KEY = "default_away_purge";
const DEFAULT_PURGE_NEXT_KEY = "default_away_next";
/** The gap between two default-name sweeps once one ended. */
const DEFAULT_PURGE_GAP_MS = 10 * 60_000;
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
 * True (1) when closed agent `a` has no work left. Two parameters: the send
 * key cutoff (now - SEND_KEY_RETAIN_MS) and now (#1295: an agent whose `away`
 * reservation has not expired keeps its row). Each probe is one indexed lookup.
 */
const IDLE_INBOX_SQL = `not exists (select 1 from receipts r indexed by receipts_to where r.to_agent = a.id and r.state = 'pending')
  and not exists (select 1 from mail m indexed by mail_to where m.to_agent = a.id)`;
/** The closed agent's own sends need nothing more (one parameter: the send key cutoff). */
const IDLE_OUTBOX_SQL = `not exists (select 1 from receipts r indexed by receipts_from_pending where r.from_agent = a.id and r.state = 'pending')
  and not exists (select 1 from send_keys k indexed by send_keys_agent where k.from_agent = a.id and k.created_at >= ?)
  and not exists (select 1 from receipts r indexed by receipts_unnotified where r.from_agent = a.id and r.notified_at is null and r.state != 'pending')`;
const AWAY_ROW_SQL = `exists (select 1 from former_names f indexed by former_names_agent where f.agent_id = a.id and f.kind = 'away' and f.expires_at > ?)`;
const IDLE_AGENT_SQL = `(${IDLE_INBOX_SQL} and ${IDLE_OUTBOX_SQL}
  and not ${AWAY_ROW_SQL})`;

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
    f.type === "follow" ||
    f.type === "unfollow" ||
    f.type === "following"
    ? f.from_ref
    : f.type === "link_bind"
      ? f.agent_ref
      : null;
}

/** #1317: waiting server notices a hub keeps; a notice over it is dropped (a replace of a waiting one is not). */
export const NOTICES_MAX = 500;
/**
 * #1828: rows held for a LIVE daemon too old to read a notice (parked = 2)
 * have their own caps, per address and hub-wide, and do not count toward
 * NOTICES_MAX; a new notice over either is dropped. Offline-machine rows
 * (parked = 1) count toward NOTICES_MAX as before, with no per-address cap.
 */
export const NOTICES_OLD_PER_ADDRESS = 20;
export const NOTICES_OLD_MAX = 500;
/** #1828: ids named in one notice_expired log line. */
const NOTICE_LOG_IDS = 20;
/** #1317: how long an offline machine's notice waits (the v1 rule). */
export const NOTICE_HOLD_MS = HOUR_MS;
/** #1317: notices one agent_up (or one alarm step) sends, so a reconnect never injects a pile of turns at once (#1752). */
const NOTICE_FLUSH_BATCH = 10;
/** #1752: the wait between two steps of a backlog of notices to one live agent. */
const NOTICE_PACE_MS = 2000;

type NoticeRow = {
  toNs: string;
  toLname: string;
  ckey: string;
  text: string;
  ack: string | null;
  foldN: number;
  foldRef: string | null;
  foldAcks: string | null;
  /** #2238: the identity the notice is addressed to; null: by name only. */
  toIdentity: string | null;
};
const NOTICE_COLS =
  "to_ns as toNs, to_lname as toLname, ckey, text, ack, fold_n as foldN, fold_ref as foldRef, fold_acks as foldAcks, to_identity as toIdentity";

/** #1752: folded targets a waiting notice keeps; older ones settle as gone at once. */
const NOTICE_FOLD_MAX = 50;

/** #2211: how long withdrawHeld remembers what it withdrew, for a retried call. */
const WITHDRAW_RECORD_MS = 3_600_000;

/** #2211: former names withdrawHeld reads for an agent found by identity. */
const WITHDRAW_FORMER_MAX = 8;

/**
 * #2175: the text of a held notice whose own comment was withdrawn and a fold
 * promoted. The promoted comment's header and ids are not stored, so a neutral
 * line stands in; the URL (line 2) and the tier tail (last line) of the
 * commentNoticeText format are kept when the old text has that shape.
 */
function promotedText(old: string, artifactId: string): string {
  const line = `New comment on artifact ${artifactId}. Read it with list_comments.`;
  const lines = old.split("\n");
  if (lines.length < 3 || !/^https?:\/\//.test(lines[1] ?? "")) return line;
  return [line, lines[1], lines[lines.length - 1]].join("\n");
}

type AckTarget = {
  a: string;
  c: string;
  k: "mention" | "asker" | "reply";
  key: string;
};

function parseAcks(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The text a waiting notice is sent with: its own, plus the fold line when earlier ones were replaced by it. */
function noticeTextOf(r: NoticeRow): string {
  if (r.foldN <= 0 || !r.foldRef) return r.text;
  try {
    return `${r.text}\n${r.foldN} more comment${r.foldN === 1 ? "" : "s"} on artifact ${r.foldRef}. Read them with list_comments.`;
  } catch {
    return r.text;
  }
}

/** The ack recorded for a send: the notice's own target, then the folded ones as `more`. */
function noticeSendAck(r: NoticeRow): string | null {
  const all = [r.ack, ...parseAcks(r.foldAcks)].filter(
    (x): x is string => typeof x === "string",
  );
  if (all.length <= 1) return all[0] ?? null;
  try {
    const [first, ...rest] = all;
    return JSON.stringify({
      ...JSON.parse(first as string),
      more: rest.map((x) => JSON.parse(x)),
    });
  } catch {
    return all[0] ?? null;
  }
}

/**
 * #1752: the comment target a notice reports back to, as the JSON stored with
 * it, or null when the notice carries none (or a malformed one).
 */
function noticeAckOf(n: BusNotice): string | null {
  const t = n.target;
  if (
    !t ||
    (t.kind !== "mention" && t.kind !== "asker" && t.kind !== "reply") ||
    typeof t.key !== "string" ||
    t.key.length === 0 ||
    t.key.length > 256 ||
    typeof n.artifactId !== "string" ||
    n.artifactId.length === 0 ||
    typeof n.commentId !== "string" ||
    n.commentId.length === 0
  )
    return null;
  return JSON.stringify({
    a: n.artifactId,
    c: n.commentId,
    k: t.kind,
    key: t.key,
  });
}

/** #1317: the shape deliverNotice trusts: the Worker is the only caller, but the hub still checks. */
function wellFormedNotice(n: BusNotice): boolean {
  return (
    typeof n === "object" &&
    n !== null &&
    n.from === NOTICE_SENDER &&
    typeof n.id === "string" &&
    typeof n.text === "string" &&
    n.text.length > 0 &&
    utf8Bytes(n.text) <= LIMITS.inlineBodyBytes &&
    typeof n.coalesceKey === "string" &&
    n.coalesceKey.length > 0 &&
    n.coalesceKey.length <= 128 &&
    typeof n.to === "object" &&
    n.to !== null &&
    typeof n.to.namespace === "string" &&
    n.to.namespace.length > 0 &&
    typeof n.to.name === "string" &&
    n.to.name.length > 0 &&
    (n.notBefore === undefined || Number.isFinite(n.notBefore)) &&
    (n.toIdentity === undefined ||
      (typeof n.toIdentity === "string" &&
        n.toIdentity.length > 0 &&
        n.toIdentity.length <= 128))
  );
}

/** #2238: the identity the agent row holds now, or null. */
function identityOfAgent(sql: SqlStorage, agentId: string): string | null {
  return (
    one<{ i: string | null }>(
      sql,
      "select identity_id as i from agents where org_id = ? and id = ?",
      OWNER_ORG_ID,
      agentId,
    )?.i ?? null
  );
}

/** #1317: one notice as a deliver frame from the reserved sender; no receipt, no mail row, no from_id. */
function noticeFrame(agent: AgentRow, text: string): ServerFrame {
  return {
    v: 1,
    id: frameId(),
    type: "deliver",
    msg_id: newId(),
    to_ref: agent.nativeRef,
    from_name: NOTICE_SENDER,
    namespace: agent.namespace,
    body: text,
  };
}

/** #1752: tries (and the base wait, ms) to settle a comment target after an ack. */
const NOTICE_SETTLE_TRIES = 3;
const NOTICE_SETTLE_RETRY_MS = 200;

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
            or exists (select 1 from notices)
            or exists (select 1 from notice_acks)
            or exists (select 1 from notice_withdrawals)
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
  #sendKeysPerAgent = SEND_KEYS_PER_AGENT;
  /**
   * Rows in send_keys, counted once on first need and then kept by every
   * insert and delete here (null: count again; the alarm sweep resets it).
   */
  #sendKeys: number | null = null;
  /**
   * #1295: pending bytes hub-wide (HUB_MAILBOX_BYTES_CAP), read from the
   * receipts every HUB_BYTES_REFRESH_MS and kept current by sends between
   * reads. Finalizations are not tracked, so it only errs toward full until
   * the next read.
   */
  #hubBytes: { n: number; at: number } | null = null;

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

  /** Tests only (static, not RPC): the per-agent send-key cap (null: SEND_KEYS_PER_AGENT). */
  static setSendKeysPerAgentForTests(hub: BusHub, cap: number | null): void {
    hub.#sendKeysPerAgent = cap ?? SEND_KEYS_PER_AGENT;
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
  async snapshot(opts?: {
    away?: boolean;
  }): Promise<{ connected: string[]; agents: BusAgent[] }> {
    const connected = all<StoredMachine>(
      this.ctx.storage.sql,
      `select ${MACHINE_COLS} from machines where org_id = ? and revoked_at is null`,
      OWNER_ORG_ID,
    )
      .filter((m) => machineOnline(this.ctx, m.id))
      .map((m) => m.id);
    return {
      connected,
      agents: agentList(this.ctx, undefined, opts?.away === true),
    };
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
    const r = this.#withReachNotice(() =>
      putRole(
        this.ctx.storage.sql,
        OWNER_ORG_ID,
        namespace,
        name,
        agentId,
        this.#now(),
        newId,
        this.#maxRoles,
      ),
    );
    logEvent("role_set", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /**
   * #1346: runs `fn` (a role change) and tells the reach-capable machines of
   * every namespace where a granted role's holder or grants changed (a role
   * moved, vacated or removed), so a roster follows at once. Nothing is sent
   * when no granted role was touched.
   */
  #withReachNotice<R>(fn: () => R): R {
    const sql = this.ctx.storage.sql;
    // Each granted role with its effective holder (live, non-global, in the
    // role's namespace; '' when vacant): what reach is read from.
    const snap = () =>
      new Set(
        all<{ k: string }>(
          sql,
          `select g.role_ns || char(0) || g.lname || char(0) || coalesce(a.id, '') as k
             from (select distinct role_ns, lname from reach_grants where org_id = ?) g
             left join roles r on r.org_id = ? and r.namespace = g.role_ns and r.lname = g.lname
             left join agents a on a.id = r.agent_id and a.live = 1 and a.global = 0 and a.namespace = r.namespace`,
          OWNER_ORG_ID,
          OWNER_ORG_ID,
        ).map((r) => r.k),
      );
    const before = snap();
    const out = fn();
    const after = snap();
    const changed = new Set<string>();
    const holders = new Set<string>();
    for (const k of [
      ...[...before].filter((k) => !after.has(k)),
      ...[...after].filter((k) => !before.has(k)),
    ]) {
      const [ns, , id] = k.split("\0");
      if (ns) changed.add(ns);
      if (id) holders.add(id);
    }
    // The holder's own machine hears it where the holder is now, which may
    // not be the role's namespace (it moved).
    if (holders.size > 0)
      for (const r of all<{ namespace: string }>(
        sql,
        "select distinct namespace from agents where id in (select value from json_each(?)) and live = 1",
        JSON.stringify([...holders]),
      ))
        changed.add(r.namespace);
    if (changed.size > 0)
      notifyRoster(this.ctx, {
        namespaces: [...changed],
        global: false,
        reachOnly: true,
      });
    return out;
  }

  /** #1296: removes role `id` (its name is free at once); false when unknown. Worker only. */
  async deleteRole(id: string): Promise<boolean> {
    return this.#withReachNotice(() =>
      deleteRole(this.ctx.storage.sql, OWNER_ORG_ID, id),
    );
  }

  // ------------------------------------------------------------------ links

  #maxLinks = BUS_LINK_MAX;

  /** Tests only (static, not RPC): the link cap (null: BUS_LINK_MAX). */
  static setMaxLinksForTests(hub: BusHub, max: number | null): void {
    hub.#maxLinks = max ?? BUS_LINK_MAX;
  }

  // ------------------------------------------------------------------ reach

  /** #1346: the member's reach grants. Worker only. */
  async listReach(): Promise<ReachGrant[]> {
    return listReach(this.ctx.storage.sql, OWNER_ORG_ID, BUS_REACH_MAX);
  }

  /**
   * #1346: lets role (`roleNamespace`, `roleName`) reach `target` (idempotent).
   * Reach-capable sockets hear `roster_changed` and see it live. Worker only
   * (a later PR's REST and confirm page); no frame grants reach.
   */
  async putReach(
    roleNamespace: string,
    roleName: string,
    target: string,
  ): Promise<PutReachResult> {
    const r = addReach(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      roleNamespace,
      roleName,
      target,
      this.#now(),
      newId,
      BUS_REACH_MAX,
    );
    if (r.ok && r.created)
      notifyRoster(this.ctx, {
        namespaces: [roleNamespace],
        global: false,
        reachOnly: true,
      });
    logEvent("reach_set", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1346: removes grant `id`; false when unknown. Live at once. Worker only. */
  async deleteReach(id: string): Promise<boolean> {
    const gone = removeReach(this.ctx.storage.sql, OWNER_ORG_ID, id);
    if (gone)
      notifyRoster(this.ctx, {
        namespaces: [gone.roleNamespace],
        global: false,
        reachOnly: true,
      });
    return gone !== null;
  }

  /**
   * #1317: one server notice for one address in this member's bus, sent as
   * the reserved sender through a `deliver` frame (no receipt, no mail row).
   * Contract: services/bus-delivery.ts. Never throws for an outcome.
   */
  async deliverNotice(n: BusNotice): Promise<DeliveryOutcome> {
    let outcome: DeliveryOutcome = "dropped";
    try {
      if (wellFormedNotice(n)) outcome = this.#acceptNotice(n);
    } catch (e) {
      logError("bus_notice_failed", e);
    }
    await this.#commitArm();
    return outcome;
  }

  /**
   * #2175: the notices still HELD for an agent removed from comment thread
   * `threadId` on `artifactId` are withdrawn: every target of `commentIds`, and
   * the thread's own coalesced rows (`asker` and `thread_reply`, whose targets
   * are returned; a `thread_reply` from before #2059 has none and is just
   * deleted) whatever `commentIds` lists. #2205: so is the held "ask
   * answered" row (ckey `${artifactId}:${id}:answered`) of each id in
   * `commentIds`, its target returned when it has one. A row left with no
   * target is deleted, unless it still counts untargeted (legacy) folds: it
   * then stays with a neutral line standing in (#2211). Only targets keyed to
   * the removed agent (the roster key notifyAgent builds) go. Notices already
   * sent (notice_acks) count as delivered and stay. Withdrawn targets are
   * returned, never settled: the caller marks them. Rows are read at the
   * passed address and at the agent's own: found by identity, else by
   * namespace + name (live or away); in both, a live former name in grace
   * counts. #2211: idempotent for about an hour: a repeat call for the same
   * agent and thread also returns what an earlier one withdrew (for those
   * `commentIds`, and the thread-wide rows), each target once. Worker only.
   */
  async withdrawHeld(a: {
    namespace: string;
    name: string;
    identityId?: string;
    artifactId: string;
    threadId: string;
    commentIds: string[];
  }): Promise<{
    withdrawn: Array<{ commentId: string; kind: string; key: string }>;
  }> {
    type Withdrawn = { commentId: string; kind: string; key: string };
    let withdrawn: Withdrawn[] = [];
    let rowsTouched = 0;
    let fresh = 0;
    try {
      if (
        typeof a?.namespace !== "string" ||
        typeof a.name !== "string" ||
        typeof a.artifactId !== "string" ||
        typeof a.threadId !== "string" ||
        a.threadId.length === 0 ||
        !Array.isArray(a.commentIds)
      )
        return { withdrawn };
      const ids = new Set(
        a.commentIds.filter((c): c is string => typeof c === "string"),
      );
      const sql = this.ctx.storage.sql;
      const now = this.#now();
      const identityId =
        typeof a.identityId === "string" && a.identityId.length > 0
          ? a.identityId
          : null;
      const byIdentity = identityId !== null;
      // Rows are keyed by lowercased name; the roster key hashes the name as
      // shown, so both spellings are kept for the key check.
      const addrs = new Map<string, [string, string]>();
      const names: Array<{ namespace: string; name: string }> = [];
      const add = (ns: string, name: string) => {
        addrs.set(`${ns}\u0000${name.toLowerCase()}`, [ns, name.toLowerCase()]);
        names.push({ namespace: ns, name });
      };
      add(a.namespace, a.name);
      if (byIdentity) {
        for (const r of all<{ namespace: string; name: string }>(
          sql,
          "select namespace, name from agents where org_id = ? and identity_id = ?",
          OWNER_ORG_ID,
          identityId,
        ))
          add(r.namespace, r.name);
        // #2211: a notice held under a name this agent has left, in its grace
        // (as liveFormer resolves one: live agent, still in that scope).
        for (const r of all<{ namespace: string; name: string }>(
          sql,
          `select a.namespace as namespace, f.name as name from former_names f
             join agents a on a.id = f.agent_id
            where a.org_id = ? and a.identity_id = ? and a.live = 1
              and f.org_id = a.org_id and f.expires_at > ? and f.kind not in ('held', 'away')
              and f.global = a.global and (f.global = 1 or f.namespace = a.namespace)
            limit ?`,
          OWNER_ORG_ID,
          identityId,
          now,
          WITHDRAW_FORMER_MAX,
        ))
          add(r.namespace, r.name);
      } else {
        const lname = a.name.toLowerCase();
        for (const r of all<{ namespace: string; name: string }>(
          sql,
          "select namespace, name from agents where org_id = ? and namespace = ? and lower(name) = ? and live in (0, 1)",
          OWNER_ORG_ID,
          a.namespace,
          lname,
        ))
          add(r.namespace, r.name);
        for (const r of liveFormer(sql, lname, now, { ns: a.namespace }, 2))
          add(r.namespace, r.name);
      }
      // The removed agent's roster keys (agentKey, as notifyAgent builds
      // `to.key`): a target keyed to another agent is not this agent's. A hub
      // not named for a member cannot derive them, and skips the check.
      const userId = this.ctx.id.name?.startsWith("bus:")
        ? this.ctx.id.name.slice(4)
        : null;
      const keys =
        userId === null
          ? null
          : new Set(
              await Promise.all(
                names.map((n) => agentKey(a.artifactId, userId, n)),
              ),
            );
      const keyOk = (k: string) => keys === null || keys.has(k);
      const askerPrefix = `${a.artifactId}:${a.threadId}:asker:`;
      const replyPrefix = `${a.artifactId}:${a.threadId}:thread_reply:`;
      // A thread_reply ckey is `${replyPrefix}${to.key}:${tier}`.
      const ownReply = (ckey: string) => {
        if (!ckey.startsWith(replyPrefix)) return false;
        const rest = ckey.slice(replyPrefix.length);
        const cut = rest.lastIndexOf(":");
        return cut > 0 && keyOk(rest.slice(0, cut));
      };
      // #2205: the "ask answered" row of a listed ask, and that ask's id.
      const answeredPrefix = `${a.artifactId}:`;
      const answeredOf = (ckey: string): string | null => {
        if (!ckey.startsWith(answeredPrefix) || !ckey.endsWith(":answered"))
          return null;
        const c = ckey.slice(answeredPrefix.length, -":answered".length);
        return ids.has(c) ? c : null;
      };
      type Held = {
        toNs: string;
        toLname: string;
        ckey: string;
        text: string;
        ack: string | null;
        foldN: number;
        foldRef: string | null;
        foldAcks: string | null;
      };
      const parse = (s: string | null): AckTarget | null => {
        if (!s) return null;
        try {
          const t = JSON.parse(s) as AckTarget;
          return typeof t?.a === "string" && typeof t.c === "string" ? t : null;
        } catch {
          return null;
        }
      };
      const agent = byIdentity
        ? `i:${identityId}`
        : `n:${a.namespace}\u0000${a.name.toLowerCase()}`;
      const found: Array<Withdrawn & { whole: number }> = [];
      this.ctx.storage.transactionSync(() => {
        for (const [ns, lname] of addrs.values()) {
          const held = all<Held>(
            sql,
            `select ${NOTICE_COLS} from notices where to_ns = ? and to_lname = ?`,
            ns,
            lname,
          );
          for (const r of held) {
            const del = () =>
              sql.exec(
                "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
                r.toNs,
                r.toLname,
                r.ckey,
              );
            const reply = ownReply(r.ckey);
            const answered = answeredOf(r.ckey);
            if (
              (reply || answered !== null) &&
              r.ack === null &&
              r.foldAcks === null
            ) {
              // A thread reply queued before #2059, or an answered notice
              // (none carries a target today): nothing to return or refund.
              rowsTouched++;
              del();
              continue;
            }
            // The thread's asker and (since #2059, targeted) thread_reply rows
            // go whole: every target of this agent's is returned. An answered
            // row goes whole too, for its own ask only.
            const wholeThread = reply || r.ckey.startsWith(askerPrefix);
            const hit = (s: string | null) => {
              const t = parse(s);
              return t !== null &&
                t.a === a.artifactId &&
                keyOk(t.key) &&
                (wholeThread ||
                  (answered === null ? ids.has(t.c) : t.c === answered))
                ? t
                : null;
            };
            const whole = wholeThread ? 1 : 0;
            const folds = parseAcks(r.foldAcks);
            const keptFolds: string[] = [];
            let removedFolds = 0;
            for (const f of folds) {
              const t = hit(f);
              if (t) {
                found.push({ commentId: t.c, kind: t.k, key: t.key, whole });
                removedFolds++;
              } else keptFolds.push(f);
            }
            const own = hit(r.ack);
            if (own)
              found.push({
                commentId: own.c,
                kind: own.k,
                key: own.key,
                whole,
              });
            if (!own && removedFolds === 0) continue;
            rowsTouched++;
            let foldN = Math.max(0, r.foldN - removedFolds);
            let ack = r.ack;
            let text: string | null = null;
            if (own) {
              const next = keptFolds.pop();
              // A thread's own row (asker, thread_reply) or an answered row
              // counts only folds of that thread or ask: with no targeted fold
              // left it goes whatever fold_n says.
              if (
                next === undefined &&
                (foldN === 0 || wholeThread || answered !== null)
              ) {
                del();
                continue;
              }
              // #2211: a per-artifact row with no targeted fold left but
              // untargeted ones still counted (they may be other threads')
              // stays untargeted: a neutral line stands in for one of them
              // and fold_n keeps the rest.
              ack = next ?? null;
              foldN = Math.max(0, foldN - 1);
              text = promotedText(
                r.text,
                (next === undefined ? r.foldRef : parse(next)?.a) ??
                  a.artifactId,
              );
            }
            sql.exec(
              `update notices set ack = ?, fold_n = ?, fold_ref = ?, fold_acks = ?${text === null ? "" : ", text = ?"}
               where to_ns = ? and to_lname = ? and ckey = ?`,
              ack,
              foldN,
              foldN > 0 ? r.foldRef : null,
              keptFolds.length > 0 ? JSON.stringify(keptFolds) : null,
              ...(text === null ? [] : [text]),
              r.toNs,
              r.toLname,
              r.ckey,
            );
          }
        }
        // #2211: recorded in the same transaction, so a lost reply is
        // answered by the retry; this call returns what it withdrew now, then
        // what an earlier call recorded for these ids and the thread's rows.
        for (const w of found)
          sql.exec(
            `insert into notice_withdrawals (agent, artifact_id, thread_id, comment_id, kind, key, whole, at)
             values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
            agent,
            a.artifactId,
            a.threadId,
            w.commentId,
            w.kind,
            w.key,
            w.whole,
            now,
          );
        const seen = new Set<string>();
        const out: Withdrawn[] = [];
        const push = (w: Withdrawn) => {
          const k = `${w.commentId}\u0000${w.kind}\u0000${w.key}`;
          if (seen.has(k)) return;
          seen.add(k);
          out.push({ commentId: w.commentId, kind: w.kind, key: w.key });
        };
        for (const w of found) push(w);
        fresh = out.length;
        for (const r of all<{
          commentId: string;
          kind: string;
          key: string;
          whole: number;
        }>(
          sql,
          `select comment_id as commentId, kind, key, whole from notice_withdrawals
            where agent = ? and artifact_id = ? and thread_id = ? and at > ?
            order by rowid`,
          agent,
          a.artifactId,
          a.threadId,
          now - WITHDRAW_RECORD_MS,
        ))
          if (r.whole === 1 || ids.has(r.commentId)) push(r);
        withdrawn = out;
      });
      if (found.length > 0) this.#arm(now + WITHDRAW_RECORD_MS);
    } catch (e) {
      logError("bus_withdraw_held_failed", e);
      return { withdrawn: [] };
    }
    // #2211: outside the try: the transaction has committed, so a failing log
    // must not hide what was withdrawn.
    try {
      logEvent("notice_withdrawn", {
        rows: rowsTouched,
        targets: fresh,
        replayed: withdrawn.length - fresh,
      });
    } catch {
      // Logging is best effort.
    }
    try {
      await this.#commitArm();
    } catch (e) {
      logError("bus_withdraw_arm_failed", e);
    }
    return { withdrawn };
  }

  /**
   * #1822: the session whose proof hashes to `hash`, or null. Reads this
   * member's own agents only (one hub per member), so a proof of another
   * member never resolves here, and only the row the proof was bound to
   * (agent_proofs.agent_id). #2110: that row is live, or closed into away
   * (away_since set) less than PROOF_AWAY_GRACE_MS ago, linked (identity_id)
   * and not of a revoked machine. Worker only.
   */
  async agentByProof(hash: string): Promise<AgentIdentity | null> {
    if (!LinkProofHashSchema.safeParse(hash).success) return null;
    return one<AgentIdentity>(
      this.ctx.storage.sql,
      `select a.identity_id as identityId, a.namespace, a.name, a.kind
        from agent_proofs p join agents a on a.id = p.agent_id
       where p.hash = ? and a.org_id = ? and a.identity_id is not null
         and (a.live = 1 or (a.away_since is not null and a.away_since > ?))
         and not exists (select 1 from machines m where m.id = a.machine_id and m.revoked_at is not null)`,
      hash,
      OWNER_ORG_ID,
      this.#now() - PROOF_AWAY_GRACE_MS,
    );
  }

  /**
   * #1890: the identity of the agent at (namespace, name) in this member's own
   * hub, live or away, or null. Returns ONLY the opaque identity id and the
   * kind, nothing else from the hub. A live row wins, then the latest one.
   * Worker only.
   */
  async identityOf(
    namespace: string,
    name: string,
  ): Promise<{ identityId: string; kind: string } | null> {
    if (typeof namespace !== "string" || typeof name !== "string") return null;
    return one<{ identityId: string; kind: string }>(
      this.ctx.storage.sql,
      "select identity_id as identityId, kind from agents where org_id = ? and namespace = ? and name = ? and identity_id is not null order by live desc, updated_at desc, rowid desc limit 1",
      OWNER_ORG_ID,
      namespace,
      name,
    );
  }

  /**
   * #1889: the current bus name of each agent identity in `identityIds`, from
   * this member's own hub only (an id of another member's agent is not here,
   * so it returns nothing). Returns ONLY `{identityId, name}`: no namespace,
   * kind, machine or state (one row per identity). At most
   * NAMES_OF_MAX ids are read. Worker only.
   */
  async namesOf(
    identityIds: string[],
  ): Promise<{ identityId: string; name: string }[]> {
    if (!Array.isArray(identityIds)) return [];
    const ids = [
      ...new Set(identityIds.filter((x) => typeof x === "string" && x !== "")),
    ].slice(0, NAMES_OF_MAX);
    if (ids.length === 0) return [];
    const rows = this.ctx.storage.sql
      .exec<{ identityId: string; name: string }>(
        `select identity_id as identityId, name from agents
         where org_id = ? and identity_id in (${ids.map(() => "?").join(",")})
         order by live desc, updated_at desc, rowid desc`,
        OWNER_ORG_ID,
        ...ids,
      )
      .toArray();
    const seen = new Set<string>();
    const out: { identityId: string; name: string }[] = [];
    for (const r of rows) {
      if (seen.has(r.identityId)) continue;
      seen.add(r.identityId);
      out.push({ identityId: r.identityId, name: r.name });
    }
    return out;
  }

  /** #1299: answers true. Reads no member data and arms no alarm (the constructor still creates the schema); the hosted canary's liveness probe. */
  ping(): true {
    return true;
  }

  /** #1567: the member's links between namespaces, for the dashboard. Worker only. */
  async listLinks(): Promise<BusLink[]> {
    return listLinks(this.ctx.storage.sql, OWNER_ORG_ID, this.#maxLinks);
  }

  /**
   * #1567: links namespaces `a` and `b` (idempotent). Both sides' sockets
   * hear `roster_changed`. Worker only (the member's REST); no frame links.
   */
  async putLink(a: string, b: string): Promise<PutLinkResult> {
    const sql = this.ctx.storage.sql;
    const existed = isLinked(sql, OWNER_ORG_ID, a, b);
    const r = addLink(
      sql,
      OWNER_ORG_ID,
      a,
      b,
      this.#now(),
      newId,
      this.#maxLinks,
    );
    if (r.ok && !existed)
      notifyRoster(this.ctx, {
        namespaces: [a, b],
        global: false,
        linksOnly: true,
      });
    logEvent("link_set", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1567: removes link `id`; false when unknown. Both sides hear `roster_changed`. Worker only. */
  async deleteLink(id: string): Promise<boolean> {
    const gone = removeLink(this.ctx.storage.sql, OWNER_ORG_ID, id);
    if (gone)
      notifyRoster(this.ctx, {
        namespaces: [gone.a, gone.b],
        global: false,
        linksOnly: true,
      });
    return gone !== null;
  }

  /**
   * #1567: records a link or unlink `machineId`'s CLI proposed, under
   * `tokenHash` (the sha256 of its confirm link's secret). Links nothing.
   * Worker only (services/bus.ts proposeBusLink, from the machine-token route).
   */
  async proposeLink(
    input: { action: LinkProposalAction; a: string; b: string },
    machineId: string,
    tokenHash: string,
  ): Promise<LinkProposeResult> {
    const r = proposeLink(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      input,
      machineId,
      tokenHash,
      this.#now(),
      newId,
    );
    logEvent("link_proposed", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1567: the link proposal behind `tokenHash`, for the confirm page. Worker only. */
  async viewLinkProposal(tokenHash: string): Promise<LinkViewResult> {
    return viewLinkProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      this.#now(),
    );
  }

  /**
   * #1567: confirms (applies, through addLink or removeLink) or rejects the
   * proposal behind `tokenHash`, once. Worker only, and only from the
   * confirm page's POST (bus/link-confirm.ts: a browser session and its form
   * token). Both sides' sockets hear `roster_changed` when a link changed.
   */
  async decideLinkProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<LinkDecideResult> {
    const { changed, ...r } = decideLinkProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      decision,
      this.#now(),
      newId,
      this.#maxLinks,
    );
    if (changed)
      notifyRoster(this.ctx, {
        namespaces: [changed.a, changed.b],
        global: false,
        linksOnly: true,
      });
    logEvent("link_decided", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /**
   * #1346: records a reach proposal from agent `nativeRef` of `machineId`
   * under `tokenHash` (the sha256 of its confirm link's secret). Grants
   * nothing; the role is the one the agent holds, found here. Worker only
   * (services/bus.ts proposeBusReach, from the machine-token route).
   */
  async proposeReach(
    input: { nativeRef: string; namespaces: string[] },
    machineId: string,
    tokenHash: string,
  ): Promise<ReachProposeResult> {
    const r = proposeReach(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      input,
      machineId,
      tokenHash,
      this.#now(),
      newId,
    );
    logEvent("reach_proposed", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /** #1346: the reach proposal behind `tokenHash`, for the confirm page. Worker only. */
  async viewReachProposal(tokenHash: string): Promise<ReachViewResult> {
    return viewReachProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      this.#now(),
    );
  }

  /**
   * #1346: confirms (applies, through addReach) or rejects the reach
   * proposal behind `tokenHash`, once. Worker only, and only from the
   * confirm page's POST (bus/reach-confirm.ts: a browser session and its
   * form token). Reach-capable sockets hear `roster_changed` when grants
   * were added.
   */
  async decideReachProposal(
    tokenHash: string,
    decision: "confirm" | "reject",
  ): Promise<ReachDecideResult> {
    const r = decideReachProposal(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      tokenHash,
      decision,
      this.#now(),
      newId,
      (fn) => this.ctx.storage.transactionSync(fn),
    );
    if (r.ok && r.changed !== null)
      notifyRoster(this.ctx, {
        namespaces: [r.changed],
        global: false,
        reachOnly: true,
      });
    logEvent("reach_decided", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
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
    const r = this.#withReachNotice(() =>
      decideProposal(
        this.ctx.storage.sql,
        OWNER_ORG_ID,
        tokenHash,
        decision,
        this.#now(),
        newId,
        this.#maxRoles,
      ),
    );
    logEvent("role_decided", r.ok ? { ok: 1 } : { reason: r.reason });
    return r;
  }

  /**
   * #1403: expires the pending role proposals `credential` (`t:<id>` or
   * `g:<id>`) made, for the revoke of that PAT or OAuth grant. Worker only.
   */
  async expireRoleProposalsOf(credential: string): Promise<ProposalAudit[]> {
    return expireByCredential(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      credential,
      this.#now(),
    );
  }

  /**
   * #1403: who made the pending proposals: the credentials (`t:<id>` /
   * `g:<id>`) of role proposals and the machine ids of link proposals, so the
   * Worker can check them against D1 and the OAuth store (a bulk revoke never
   * calls the hooks). Worker only.
   */
  async pendingProposalSources(): Promise<{
    credentials: string[];
    machines: string[];
  }> {
    const sql = this.ctx.storage.sql;
    const col = (q: string, ...org: string[]) =>
      sql
        .exec(q, ...(org.length > 0 ? org : [OWNER_ORG_ID]))
        .toArray()
        .map((r) => String(Object.values(r)[0]));
    return {
      credentials: col(
        "select distinct credential from role_proposals where org_id = ? and status = 'pending' and credential is not null",
      ),
      machines: col(
        "select machine_id from link_proposals where org_id = ? and status = 'pending' union select machine_id from reach_proposals where org_id = ? and status = 'pending'",
        OWNER_ORG_ID,
        OWNER_ORG_ID,
      ),
    };
  }

  /**
   * #1403: expires the machine's pending link and reach proposals (a machine
   * revoked in bulk). Returns the reach ones, for their audit rows. Worker only.
   */
  async expireLinkProposalsOf(machineId: string): Promise<ReachAudit[]> {
    const now = this.#now();
    expireLinkProposalsOfMachine(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      machineId,
      now,
    );
    return expireReachProposalsOfMachine(
      this.ctx.storage.sql,
      OWNER_ORG_ID,
      machineId,
      now,
    );
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
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (!notDaemon(this.ctx, ws)) closed++;
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
    if (closed > 0) await this.#goneFromIndex();
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
    // #2110: an access change ends the away grace: a closed session's proofs
    // go now (a live one's stay, as before; it rebinds when it reconnects).
    this.ctx.storage.sql.exec(
      "delete from agent_proofs where agent_id in (select p.agent_id from agent_proofs p cross join agents a on a.id = p.agent_id where a.live = 0)",
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
    if (n > 0) await this.#goneFromIndex();
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
    // #1403: its pending link proposals die with it, even on a repeat call.
    expireLinkProposalsOfMachine(sql, OWNER_ORG_ID, id, now);
    const res = sql.exec(
      "update machines set revoked_at = ? where id = ? and org_id = ? and revoked_at is null",
      now,
      id,
      OWNER_ORG_ID,
    );
    if (res.rowsWritten === 0) return false;

    // Marked first (as a replaced socket is), so a frame still in flight is
    // never processed and the close that lands later runs no bookkeeping.
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(id)) {
      closed++;
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
    // most maxAgentsPerMachine) and, #1295, the machine's away agents
    // (releaseMachineNames: closed with their pending mail kept, at most
    // CLOSED_AGENTS_PER_MACHINE), never the rest of its closed history.
    const ids = sql
      .exec(
        `update agents set live = 0, last_name = name, updated_at = ?, ${CLOSE_CLEAR} where machine_id = ? and live = 1 returning id`,
        now,
        id,
      )
      .toArray()
      .map((r) => String(r.id));
    // #1448: nothing is held; every name its agents held or reserved is free.
    // #1295: agents already away hold mail too; the drain below expires it
    // `revoked`, and their reservations go with the names.
    ids.push(...releaseMachineNames(sql, id, ids, now));
    // #2110: every proof of the machine's agents, away ones included.
    sql.exec(
      "delete from agent_proofs where agent_id in (select p.agent_id from agent_proofs p cross join agents a on a.id = p.agent_id where a.machine_id = ?)",
      id,
    );
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
    if (closed > 0) await this.#goneFromIndex();
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
    this.indexInFlight++;
    try {
      await idx.seen(name);
      this.#indexedAt = now;
    } catch (e) {
      logError("socket_index_failed", e);
    } finally {
      this.indexInFlight--;
    }
  }

  /**
   * Index calls (seen, gone) and close/error handlers this instance has started and not finished. A
   * plain instance field, not a prototype member, so Workers RPC does not
   * expose it. Tests read it inside the DO (runInDurableObject); a file's
   * afterAll waits for 0 so the worker is not torn down with an RPC pending.
   */
  indexInFlight = 0;

  #indexGoneTimeoutMs = INDEX_GONE_TIMEOUT_MS;

  /** Tests only (static, not RPC): the bound on a `gone` call (null: INDEX_GONE_TIMEOUT_MS). */
  static setIndexGoneTimeoutForTests(hub: BusHub, ms: number | null): void {
    hub.#indexGoneTimeoutMs = ms ?? INDEX_GONE_TIMEOUT_MS;
  }

  /**
   * #1299: when `closing` was the hub's last open daemon socket, removes the
   * hub's row from the install index (it outlives the index window while
   * sockets exist). Fails open: a missed `gone` is bounded by closeInstall
   * (a harmless closeAll on no sockets) and the index's cap.
   *
   * A peer that never echoes our close never triggers webSocketClose, so a
   * close this hub started (revoke, closeAll, wipe, the frame that trips the
   * rate limit or lands on a revoked or replaced socket) calls this itself,
   * with no `closing` socket: the sockets it closed are already CLOSING, not
   * OPEN. When the peer does echo, webSocketClose reports again; `gone` is
   * idempotent.
   */
  async #goneFromIndex(closing?: WebSocket): Promise<void> {
    const open = () =>
      this.ctx
        .getWebSockets(DAEMON_TAG)
        .some((w) => w !== closing && w.readyState === OPEN);
    if (open()) return;
    const name = this.ctx.id.name;
    const idx = socketIndexStub(this.env);
    if (!idx || !name) return;
    this.#indexedAt = Number.NEGATIVE_INFINITY;
    // #1749: bounded, so a hung index stalls no close, erase or revoke. The
    // call, and the repair after it, count in indexInFlight until they
    // really settle, not until the timeout, so a test teardown still waits.
    this.indexInFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = Promise.resolve().then(() => idx.gone(name));
    // The repair runs when `gone` really lands, even after the bound gave up
    // on it: always reset, because a `seen` that returned while `gone` was in
    // flight set the throttle after the row was deleted, and an accept
    // within INDEX_REPORT_MS would skip its report and leave a live socket
    // with no row. A socket accepted while `gone` was in flight reported
    // before it landed, so its report may have been deleted: report again.
    const settled = call
      .then(
        async () => {
          this.#indexedAt = Number.NEGATIVE_INFINITY;
          if (open()) await this.#reportToIndex();
        },
        () => {}, // logged by the race below, or after the bound: ignored
      )
      .finally(() => {
        this.indexInFlight--;
      });
    this.ctx.waitUntil(settled);
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("socket index gone timed out")),
          this.#indexGoneTimeoutMs,
        );
      });
      await Promise.race([call, timedOut]);
    } catch (e) {
      logError("socket_index_failed", e);
      return;
    } finally {
      clearTimeout(timer);
    }
    await settled;
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (notDaemon(this.ctx, ws)) return;
    // Only the frame that closes the socket reports; late frames on a socket
    // already closing (a rate-limited one keeps sending) must not each cost
    // the shared index an RPC.
    const wasOpen = ws.readyState === OPEN;
    if (this.#overBudget(ws)) {
      if (wasOpen && ws.readyState !== OPEN) await this.#goneFromIndex();
      return;
    }
    const pending = this.#onMessage(ws, message);
    await this.#commitArm();
    if (wasOpen && ws.readyState !== OPEN) await this.#goneFromIndex();
    // #1317: a follow frame's D1 work. Awaited after the arm commit, so
    // nothing else waits on it; other sockets' messages run meanwhile.
    await pending;
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
    const tripped =
      this.#rateClosed.has(ws) || attachmentOf(ws)?.rateLimited === true;
    const ok = !tripped && takeToken(b, now, FRAME_BUDGET);
    if (ok) return false;
    // The cooldown starts when this socket trips, not on its late frames.
    if (!tripped) {
      b.cooldownUntil = now + LIMITS.rateLimitCooldownMs;
      this.#rateClosed.add(ws);
      try {
        const a = attachmentOf(ws);
        if (a) ws.serializeAttachment({ ...a, rateLimited: true });
      } catch {
        // Already closed.
      }
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
    if (!res.ok) {
      reject(ws, machineId, res.id, res.error, "Unreadable frame");
      return;
    }
    const f = res.frame;
    const sql = this.ctx.storage.sql;

    // #1317: without the cap the frame is as unknown as it is to an older hub.
    if (
      (f.type === "follow" ||
        f.type === "unfollow" ||
        f.type === "following") &&
      !followGated(ws)
    ) {
      reject(ws, machineId, f.id, "bad_frame", "Unreadable frame");
      return;
    }

    // #1822: without the cap the frame is as unknown as it is to an older hub.
    if (f.type === "link_bind" && !linkGated(ws)) {
      reject(ws, machineId, f.id, "bad_frame", "Unreadable frame");
      return;
    }

    // #2079: as unknown as it is to an older hub without the cap.
    if (f.type === "waiting_query" && !waitingQueryGated(ws)) {
      reject(ws, machineId, f.id, "bad_frame", "Unreadable frame");
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
          ...(hasCap(f, BUS_CAPS.ids) ||
          hasCap(f, BUS_CAPS.mailbox) ||
          hasCap(f, BUS_CAPS.links) ||
          hasCap(f, BUS_CAPS.reach) ||
          hasCap(f, BUS_CAPS.follow) ||
          hasCap(f, BUS_CAPS.noticeAck) ||
          hasCap(f, BUS_CAPS.link) ||
          hasCap(f, BUS_CAPS.waiting) ||
          hasCap(f, BUS_CAPS.waitingQuery) ||
          hasCap(f, BUS_CAPS.ackConfirm)
            ? { caps: [...HUB_CAPS] }
            : {}),
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
          `update agents set live = 0, last_name = name, updated_at = ?, away_since = ?, ${CLOSE_CLEAR}
            where machine_id = ? and live = 1 and org_id = ?
              and native_ref in (select value from json_each(?))
           returning id, namespace, global`,
          this.#now(),
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
        // #1295: a /clear. The same process reports a new session; the new
        // ref takes over the old one's agent row (address, former names, mail).
        if (f.replaces !== undefined && mailboxGated(ws))
          takeOver(sql, machineId, f.replaces, f.agent_ref, this.#now());
        // #1766: where this session's follows are, read before agentUp (a
        // reclaim deletes the away row). Only an address still this session's:
        // its row is live, or it holds an unexpired away reservation of its own
        // there. A closed session whose name someone else took owns nothing.
        const before = one<{ namespace: string; name: string }>(
          sql,
          `select a.namespace, a.name from agents a
            where a.machine_id = ? and a.native_ref = ? and a.org_id = ?
              and (a.live = 1 or exists (
                select 1 from former_names f
                 where f.agent_id = a.id and f.kind = 'away' and f.expires_at > ?
                   and f.lname = lower(a.name) and f.namespace = a.namespace))`,
          machineId,
          f.agent_ref,
          OWNER_ORG_ID,
          this.#now(),
        );
        const { reply, change, arms, moved } = this.#withReachNotice(() =>
          agentUp(sql, machineId, f, this.#now()),
        );
        for (const t of arms) this.#arm(t);
        this.#adoptHeld(moved, registeredAgent(sql, machineId, f.agent_ref));
        sendFrame(ws, reply);
        notifyRoster(this.ctx, change, ws);
        const a = registeredAgent(sql, machineId, f.agent_ref);
        const rekeyed = a ? this.#rekeyFollows(before, a) : undefined;
        if (a) {
          // Its queued mail, then what it missed as a sender.
          this.#flush(ws, a);
          this.#flushNoticesFor(ws, a);
          if (this.#replay(a.id)) {
            this.#replayQueue.add(a.id);
            this.#arm(this.#now() + 1);
          }
        }
        return rekeyed;
      }
      case "agent_down": {
        const a = this.#withReachNotice(() =>
          agentDown(sql, machineId, f.agent_ref, this.#now()),
        );
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
            roster(
              this.ctx,
              sender,
              f.id,
              renameGated(ws),
              this.#now(),
              mailboxGated(ws),
              linksGated(ws),
              reachGated(ws),
              waitingGated(ws),
            ),
          );
        return;
      case "send":
        if (sender) this.#send(ws, f, sender);
        return;
      case "ack":
      case "refuse":
        // A notice sent to this machine's notice_ack socket (#1752) settles
        // its comment target; everything else is mail.
        if (
          this.#settleNoticeAck(
            machineId,
            f.msg_id,
            f.type === "ack" ? "delivered" : "refused",
          )
        )
          return;
        // Anything but the recipient's own pending mail is ignored; only a
        // socket with ackConfirm hears back (#2198), after the settle.
        {
          const settled = this.#settle(
            machineId,
            f.msg_id,
            f.type === "ack" ? "delivered" : "refused",
          );
          if (
            f.type === "ack" &&
            ackConfirmGated(ws) &&
            (settled || !canStillSettle(sql, machineId, f.msg_id))
          )
            sendFrame(ws, { v: 1, id: f.id, type: "acked", msg_id: f.msg_id });
        }
        return;
      case "fetch":
        if (sender) this.#fetch(ws, f, sender, machineId);
        return;
      case "status":
        if (sender) this.#status(ws, f, sender);
        return;
      case "follow":
      case "unfollow":
      case "following":
        return sender ? this.#follows(ws, f, sender) : undefined;
      case "waiting_query":
        // Machine-authenticated: only this machine's own away agents answer.
        sendFrame(ws, {
          v: 1,
          id: f.id,
          type: "waiting_counts",
          counts: waitingByRef(sql, machineId, f.agent_refs),
        });
        return;
      case "link_bind":
        // Only an agent this socket registered (the check above): a machine
        // can bind a proof only for a session it hosts.
        if (sender) {
          bindProof(sql, sender.id, f.hash);
          sendFrame(ws, { v: 1, id: f.id, type: "link_bound" });
        }
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
        return this.#rename(ws, f, a);
      }
    }
  }

  /**
   * #1766: follows are keyed by address, so a session whose address changed
   * (a rename, or an agent_up that moved it) takes its rows along. The D1 work
   * is returned for webSocketMessage to await after the arm commit, bounded by
   * FOLLOW_TIMEOUT_MS and best effort: a failure logs and never fails the
   * rename. A follow request waits for it (#rekeyed), so `following` right
   * after `renamed` sees the moved rows. A reclaim keeps the address: no call.
   */
  #rekeyed: Promise<void> = Promise.resolve();
  #rekeyFollows(
    before: { namespace: string; name: string } | null,
    after: { namespace: string; name: string },
  ): Promise<void> | undefined {
    if (
      before === null ||
      (before.namespace === after.namespace && before.name === after.name)
    )
      return undefined;
    const userId = this.ctx.id.name?.startsWith("bus:")
      ? this.ctx.id.name.slice(4)
      : null;
    if (userId === null) return undefined;
    const from = { namespace: before.namespace, name: before.name };
    const to = { namespace: after.namespace, name: after.name };
    const run = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Counted like the index calls, so a test's afterAll waits for the D1 work.
      this.indexInFlight++;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("follow re-key timed out")),
            FOLLOW_TIMEOUT_MS,
          );
        });
        await Promise.race([moveFollows(this.env, userId, from, to), timeout]);
      } catch (e) {
        logError("bus_follow_rekey_failed", e);
      } finally {
        this.indexInFlight--;
        clearTimeout(timer);
      }
    };
    const p = this.#rekeyed.then(run);
    this.#rekeyed = p;
    return p;
  }

  /**
   * #1766: every address this hub still holds for its member: a live agent, or
   * a name under an unexpired reservation (away, held, chosen), as knownKey.
   * A follow row at any other address is not reached by name any more. (A
   * session closed past its reservation can still reopen, under a new name;
   * its rows are then gone and it follows again.)
   */
  #knownAddresses(): Set<string> {
    const sql = this.ctx.storage.sql;
    const known = new Set<string>();
    for (const r of sql.exec<{ namespace: string; name: string }>(
      "select namespace, name from agents where live = 1",
    ))
      known.add(knownKey(r));
    for (const r of sql.exec<{ namespace: string; name: string }>(
      "select namespace, name from former_names where expires_at > ?",
      this.#now(),
    ))
      known.add(knownKey(r));
    return known;
  }

  #followsInFlight = 0;

  /**
   * `follow`, `unfollow` and `following` (#1317) for the agent `from_ref`
   * names, which this socket registered. The member is this hub's (its DO name
   * is `bus:<userId>`) and the address is the agent's own row: nothing in the
   * frame names either. The D1 work is the follows service's, so it runs
   * after the synchronous part: bounded by FOLLOWS_IN_FLIGHT_MAX requests in
   * flight and FOLLOW_TIMEOUT_MS each. Errors answer in the frame's own id
   * with the service's stable codes; anything else is `internal`.
   */
  async #follows(
    ws: WebSocket,
    f: Extract<ClientFrame, { type: "follow" | "unfollow" | "following" }>,
    agent: AgentRow,
  ): Promise<void> {
    const userId = this.ctx.id.name?.startsWith("bus:")
      ? this.ctx.id.name.slice(4)
      : null;
    if (userId === null) {
      logEvent("follow_no_member", { machineId: agent.machineId });
      sendError(ws, f.id, "internal", "Could not follow right now");
      return;
    }
    if (this.#followsInFlight >= FOLLOWS_IN_FLIGHT_MAX) {
      logEvent("rate_limited", { kind: "follows", machineId: agent.machineId });
      sendError(ws, f.id, "rate_limited", "Too many follow requests at once");
      return;
    }
    const to = { namespace: agent.namespace, name: agent.name };
    const wire = (e: {
      artifactId: string;
      url: string;
      followedAt: string;
    }) => ({
      artifact_id: e.artifactId,
      url: e.url,
      followed_at: e.followedAt,
    });
    // A rename's re-key lands first (bounded itself), so this sees the moved rows.
    // It counts against the limit while it waits.
    this.#followsInFlight++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.#rekeyed;
      const work =
        f.type === "follow"
          ? this.#followOrPrune(userId, to, f.artifact).then(
              (e) =>
                ({ v: 1, id: f.id, type: "followed", ...wire(e) }) as const,
            )
          : f.type === "unfollow"
            ? unfollow(this.env, userId, to, f.artifact).then(
                (r) =>
                  ({
                    v: 1,
                    id: f.id,
                    type: "unfollowed",
                    removed: r.removed,
                  }) as const,
              )
            : following(this.env, userId, to).then(
                (l) =>
                  ({
                    v: 1,
                    id: f.id,
                    type: "follows",
                    follows: l.map(wire),
                  }) as const,
              );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("follow timed out")),
          FOLLOW_TIMEOUT_MS,
        );
      });
      sendFrame(ws, await Promise.race([work, timeout]));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      if (code === "not_found" || code === "follow_limit")
        sendError(ws, f.id, code, e instanceof Error ? e.message : code);
      else {
        logError("bus_follow_failed", e);
        sendError(ws, f.id, "internal", "Could not follow right now");
      }
    } finally {
      clearTimeout(timer);
      this.#followsInFlight--;
    }
  }

  /**
   * follow, and at follow_limit (#1766) delete the member's follows at
   * addresses no live, away or reserved agent holds, then try once more. A
   * live or away agent's rows are never touched; still full: follow_limit.
   */
  async #followOrPrune(
    userId: string,
    to: { namespace: string; name: string },
    ref: string,
  ) {
    try {
      return await follow(this.env, userId, to, ref);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "follow_limit")) throw e;
      const n = await pruneDeadFollows(
        this.env,
        userId,
        this.#knownAddresses(),
      );
      if (n === 0) throw e;
      logEvent("follows_pruned", { n });
      return follow(this.env, userId, to, ref);
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
  ): Promise<void> | undefined {
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
      { kind: agent.kind },
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
      return undefined;
    }
    const at: Scope = { namespace: agent.namespace, global };
    if (!renameAllowed(sql, agent.id, now)) {
      logEvent("rate_limited", { kind: "rename", machineId: agent.machineId });
      sendError(ws, f.id, "rate_limited", RENAME_MESSAGES.rate);
      return undefined;
    }
    if (!formerRoom(sql, agent.id, agent.name, at, name, at, now)) {
      logEvent("rate_limited", {
        kind: "rename_room",
        machineId: agent.machineId,
      });
      sendError(ws, f.id, "rate_limited", RENAME_MESSAGES.room);
      return undefined;
    }
    const former = agent.name;
    for (const t of recordRename(sql, agent.id, former, at, name, at, now))
      this.#arm(t);
    sql.exec(
      "update agents set name = ?, updated_at = ?, name_chosen = case ? when 2 then name_chosen else ? end where id = ?",
      name,
      now,
      // A re-derived title (name_chosen false) leaves the flag; a default resets it.
      f.name_kind !== "default" && f.name_chosen === false ? 2 : 0,
      f.name_kind === "default" ? 0 : 1,
      agent.id,
    );
    commitName(sql, agent.id, assigned, at, now);
    // #1742: the name was an away row's; its queued mail is this agent's now.
    const moved =
      assigned.reclaim === undefined
        ? []
        : takeAwayName(
            sql,
            assigned.reclaim,
            agent.id,
            name,
            agent.namespace,
            global,
            now,
          );
    sendFrame(ws, { ...reply, former });
    notifyRoster(this.ctx, { namespaces: [agent.namespace], global }, ws);
    if (moved.length > 0) {
      this.#adoptHeld(moved, agent);
      this.#flush(ws, agent);
    }
    return this.#rekeyFollows(agent, { namespace: agent.namespace, name });
  }

  /** #1742: a held (pushed, unacked) body of a moved receipt now belongs to its new recipient. */
  #adoptHeld(moved: string[], to: AgentRow | null): void {
    if (to === null) return;
    for (const id of moved) {
      const h = this.#held.get(id);
      if (h) h.toAgent = to.id;
    }
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
    // Counted from entry: a hub-started close leaves the socket CLOSING and
    // the index idle until the client's echo lands here, so a test teardown
    // must wait for the whole handler, not only its index call.
    this.indexInFlight++;
    try {
      // 1005/1006 are never sent on the wire.
      closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
      // A socket this DO never accepted has no bookkeeping.
      if (notDaemon(this.ctx, ws)) return;
      this.#socketGone(ws);
      await this.#commitArm();
      await this.#goneFromIndex(ws);
    } finally {
      this.indexInFlight--;
    }
  }

  override async webSocketError(
    ws: WebSocket,
    _error?: unknown,
  ): Promise<void> {
    this.indexInFlight++;
    try {
      // Closed first, as in webSocketClose: a socket left OPEN would still
      // count as connected (machineOnline) in the push #socketGone triggers.
      closeSocket(ws, 1011, "error");
      if (notDaemon(this.ctx, ws)) return;
      this.#socketGone(ws);
      await this.#commitArm();
      await this.#goneFromIndex(ws);
    } finally {
      this.indexInFlight--;
    }
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
    const due = all<{ id: string; disconnectedAt: number }>(
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
        `update agents set live = 0, last_name = name, updated_at = ?, away_since = ?, ${CLOSE_CLEAR}
          where rowid in (select rowid from agents where machine_id = ? and live = 1 and org_id = ? limit ?)
         returning id, namespace, global`,
        now,
        m.disconnectedAt,
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
    // #2110: offline for a day is long past the away grace.
    dropProofs(sql, JSON.stringify(closed));
    // Their mail sent while offline ends with the reservation, not after it.
    this.#closeSessions(closed, true);
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
    const res = resolveTarget(
      sql,
      sender,
      f.to_name,
      f.to_namespace,
      now,
      linksGated(ws),
      reachGated(ws),
      mailboxGated(ws),
    );
    // A reply (`to_id`) goes only to the agent it answers: never to whoever
    // holds the name now (wireReason shows agent_gone only to an ids socket).
    // One exception, after the send: a reply already queued to an away agent
    // follows its name to a restarted session that reclaims it (#1742,
    // takeAwayName moves the queued mail), as the sender was told "queued".
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
    const size = utf8Bytes(f.body);
    if (inboxFull(sql, target, size) || this.#hubFull(size, now)) {
      refuseSend(ws, f.id, "mailbox_full");
      return;
    }
    if (!this.#roomForKey(sender.id)) {
      sendError(ws, f.id, "rate_limited", SEND_KEYS_MESSAGE);
      return;
    }

    const msgId = newId();
    if (this.#hubBytes) this.#hubBytes.n += size;
    // #1295: mail lives MAILBOX_RETAIN_MS, but never past an away agent's
    // reservation (away_since + MAILBOX_RETAIN_MS).
    let expiresAt = now + MAILBOX_RETAIN_MS;
    if (target.live !== 1) {
      const since = one<{ t: number | null }>(
        sql,
        "select away_since as t from agents where id = ?",
        target.id,
      )?.t;
      if (since !== null && since !== undefined)
        expiresAt = Math.min(expiresAt, since + MAILBOX_RETAIN_MS);
    }
    // An away agent has no session to push to: the mail waits for its reopen.
    const socket =
      target.live === 1 ? liveSocket(this.ctx, target.machineId) : null;
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
      ...queuedWire(ws, this.ctx, target.id, now),
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

  /** #1295: whether `size` more bytes would pass HUB_MAILBOX_BYTES_CAP. */
  #hubFull(size: number, now: number): boolean {
    if (
      this.#hubBytes === null ||
      now < this.#hubBytes.at ||
      now - this.#hubBytes.at >= HUB_BYTES_REFRESH_MS
    )
      this.#hubBytes = {
        n:
          one<{ n: number }>(
            this.ctx.storage.sql,
            "select coalesce(sum(size), 0) as n from receipts where state = 'pending'",
          )?.n ?? 0,
        at: now,
      };
    return this.#hubBytes.n + size > HUB_MAILBOX_BYTES_CAP;
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
        this.#sendKeysPerAgent,
      )?.n ?? 0;
    if (n >= this.#sendKeysPerAgent) {
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
   * on the wire; its `queued`/`since` are recomputed from the recipient's
   * state now, for a mailbox socket, while the mail is pending) and, once final, a `receipt_update` with the current state
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
      toAgent: string | null;
    }>(
      sql,
      "select state, reason, to_name as toName, to_agent as toAgent from receipts where id = ?",
      msgId,
    ) ?? {
      state: "expired",
      reason: null,
      toName: null,
      toAgent: null,
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
      // Only while the mail still waits: a final state has no queue to show.
      ...(r.state === "pending" && r.toAgent !== null
        ? queuedWire(ws, this.ctx, r.toAgent, this.#now())
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
  ): boolean {
    const from = settle(
      this.ctx.storage.sql,
      machineId,
      msgId,
      outcome,
      this.#now(),
    );
    if (from === null) return false;
    this.#release(msgId);
    this.#tell(msgId, from, outcome, outcome === "refused" ? "closed" : null);
    return true;
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
   * never becomes delivered (settle also requires pending), except that a
   * `lost_body` expiry (the hub lost a body it had already pushed) is settled
   * delivered by the recipient's own late ack (#1760). `lost_body` is stored
   * only: the wire carries a reasonless expiry, as before.
   */
  #expire(
    msgId: string,
    fromAgent: string,
    reason?: "recipient_closed" | "revoked" | "lost_body",
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
    finalizeKey(sql, msgId, this.#now());
    sql.exec("delete from mail where id = ?", msgId);
    this.#release(msgId);
    this.#tell(msgId, fromAgent, "expired", reason ?? null);
  }

  /**
   * The agents' sessions ended (B11). #1295: their pending mail is KEPT for
   * the agents' `away` reservation (MAILBOX_RETAIN_MS) instead of expiring as
   * recipient_closed; a reopen with the same agent_ref receives it, and the
   * TTL sweep expires it (sender told) otherwise. Their acked notices lose
   * their bodies: inline and by the drain here, and a reopen that keeps its
   * boundary (an unexpired away row) deletes any left before it is live, so
   * the new session never reads them (a reopen past the boundary is also
   * filtered by fetch). The receipts stay (delivered is true).
   *
   * `capMail` (the offline reap): the agents closed at their machine's
   * disconnected_at, so mail sent since then ends with the reservation
   * (expires_at = min(expires_at, away_since + MAILBOX_RETAIN_MS)).
   *
   * Bounded: CLOSE_INLINE_BATCH body deletes inline, for the whole call;
   * every agent whose work may not be done is queued in ONE meta row
   * (CLOSE_PREFIX + close time + id, value {"through": max receipts rowid at
   * the close, "ids": [...]}) for the alarm's close drain. The boundary is a
   * rowid, not a timestamp (B11 L1): a session reopened in the same
   * millisecond starts past it.
   */
  #closeSessions(agentIds: string[], capMail = false): void {
    if (agentIds.length === 0) return;
    const sql = this.ctx.storage.sql;
    const closedAt = this.#now();
    // OpenBus #451, #1295: their names are reserved where they were left
    // (`away`), for MAILBOX_RETAIN_MS after the agent went away.
    const heldTo = leaveNames(sql, agentIds, closedAt);
    if (heldTo !== null) this.#arm(heldTo);
    if (capMail) {
      const ids = JSON.stringify(agentIds);
      sql.exec(
        `update receipts set expires_at = (select a.away_since + ? from agents a where a.id = receipts.to_agent)
          where state = 'pending' and to_agent in (select value from json_each(?))
            and expires_at > (select a.away_since + ? from agents a where a.id = receipts.to_agent)`,
        MAILBOX_RETAIN_MS,
        ids,
        MAILBOX_RETAIN_MS,
      );
      sql.exec(
        `update mail set expires_at = (select a.away_since + ? from agents a where a.id = mail.to_agent)
          where to_agent in (select value from json_each(?))
            and expires_at > (select a.away_since + ? from agents a where a.id = mail.to_agent)`,
        MAILBOX_RETAIN_MS,
        ids,
        MAILBOX_RETAIN_MS,
      );
      this.#arm(closedAt + 1);
    }
    // M1: the closed rows' purge deadline.
    this.#arm(closedAt + CLOSED_AGENT_RETAIN_MS);
    // Rowid boundary (F3, accepted): relies on receipts rowids never being
    // renumbered; DO SQLite exposes no VACUUM, and the purge keeps the newest.
    const through =
      one<{ n: number | null }>(sql, "select max(rowid) as n from receipts")
        ?.n ?? 0;
    let bodies = CLOSE_INLINE_BATCH;
    const left: string[] = [];
    for (const agentId of agentIds) {
      if (bodies === 0) {
        left.push(agentId);
        continue;
      }
      const n = deleteDeliveredBodies(sql, agentId, bodies, through);
      if (n >= bodies) left.push(agentId);
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
      this.#now(),
    );
    if (victim) {
      sql.exec("delete from agents where rowid = ? and live = 0", victim.rid);
      return true;
    }
    // #1295: every close leaves an `away` reservation, so a machine closing
    // 1000 sessions in 7 days has no idle row. Evict the oldest away agent
    // of this machine: first one with no inbox and nothing owed as a sender,
    // then one with an inbox (its pending mail expires as recipient_closed,
    // senders told), then whatever its outbox holds. An evicted sender's
    // pending sends stay pending; a later outcome finds no sender row
    // (#tell) and is simply not delivered. The reservation goes with it.
    const oldest = (inbox: boolean, outbox: boolean) =>
      one<{ rid: number; id: string }>(
        sql,
        `select a.rid, a.id from (select rowid as rid, id from agents indexed by agents_machine_closed
            where machine_id = ? and live = 0 order by updated_at, rowid limit ?) a
          where ${inbox ? `${IDLE_INBOX_SQL} and ` : ""}${outbox ? `${IDLE_OUTBOX_SQL} and ` : ""}${AWAY_ROW_SQL} limit 1`,
        machineId,
        CLOSED_AGENTS_PER_MACHINE,
        ...(outbox ? [this.#now() - SEND_KEY_RETAIN_MS] : []),
        this.#now(),
      );
    const away =
      oldest(true, true) ?? oldest(false, true) ?? oldest(false, false);
    if (!away) return false;
    for (;;) {
      const rows = all<{ id: string; fromAgent: string }>(
        sql,
        "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' limit ?",
        away.id,
        BATCH,
      );
      for (const r of rows) this.#expire(r.id, r.fromAgent, "recipient_closed");
      if (rows.length < BATCH) break;
    }
    sql.exec("delete from mail where to_agent = ?", away.id);
    sql.exec("delete from former_names where agent_id = ?", away.id);
    sql.exec("delete from agents where rowid = ? and live = 0", away.rid);
    logEvent("away_evicted", { machineId });
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
    const rows = all<{ rid: number; id: string; u: number; idle: number }>(
      sql,
      `select a.rowid as rid, a.id as id, a.updated_at as u, ${IDLE_AGENT_SQL} as idle
         from agents a indexed by agents_closed
        where a.live = 0 and a.updated_at < ?
          and (a.updated_at > ? or (a.updated_at = ? and a.rowid > ?))
        order by a.updated_at, a.rowid limit ?`,
      now - SEND_KEY_RETAIN_MS,
      now,
      now - CLOSED_AGENT_RETAIN_MS,
      u,
      u,
      r,
      BATCH,
    );
    const goneRows = rows.filter((x) => x.idle === 1);
    const gone = goneRows.map((x) => x.rid);
    if (gone.length > 0) {
      // #2318: the agent's minted-name and rename-limit rows go with it.
      const ids = JSON.stringify(goneRows.map((x) => x.id));
      sql.exec(
        "delete from minted_names where agent_id in (select value from json_each(?))",
        ids,
      );
      sql.exec(
        "delete from rename_rl where agent_id in (select value from json_each(?))",
        ids,
      );
      sql.exec(
        "delete from agents where live = 0 and rowid in (select value from json_each(?))",
        JSON.stringify(gone),
      );
    }
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
   * #2311: one bounded step of the sweep of away agents with a default name:
   * up to BATCH closed agents older than DEFAULT_NAME_AWAY_MS, oldest first,
   * from the persisted cursor; those with a default name and no work left
   * are deleted with their away reservation (proofs go by trigger). A pass
   * ends when a step finds fewer than BATCH; the next starts
   * DEFAULT_PURGE_GAP_MS later. True while the pass has more.
   */
  #purgeDefaultNamed(now: number): boolean {
    const sql = this.ctx.storage.sql;
    const meta = (k: string) =>
      one<{ value: string }>(
        sql,
        "select value from meta where org_id = ? and key = ?",
        OWNER_ORG_ID,
        k,
      )?.value;
    const raw = meta(DEFAULT_PURGE_KEY);
    const cur = raw === undefined ? null : parsePurgeCursor(raw);
    if (cur === null) {
      const next = parseDecimal(meta(DEFAULT_PURGE_NEXT_KEY) ?? "");
      if (next !== null && next > now) return false;
    }
    const u = cur?.u ?? -1;
    const r = cur?.r ?? 0;
    const rows = all<{
      rid: number;
      id: string;
      u: number;
      name: string;
      kind: string;
      minted: number;
      chosen: number;
      holdsBusRole: number;
      idle: number;
    }>(
      sql,
      `select a.rowid as rid, a.id as id, a.updated_at as u, a.name as name, a.kind as kind, a.name_chosen as chosen,
          exists (select 1 from roles r where r.org_id = a.org_id and r.agent_id = a.id) as holdsBusRole,
          exists (select 1 from minted_names m where m.agent_id = a.id and m.lname = lower(a.name)) as minted,
          (${IDLE_INBOX_SQL} and ${IDLE_OUTBOX_SQL}) as idle
         from agents a indexed by agents_closed
        where a.live = 0 and a.updated_at < ?
          and (a.updated_at > ? or (a.updated_at = ? and a.rowid > ?))
        order by a.updated_at, a.rowid limit ?`,
      now - SEND_KEY_RETAIN_MS,
      now - DEFAULT_NAME_AWAY_MS,
      u,
      u,
      r,
      BATCH,
    );
    const gone = rows.filter(
      (x) =>
        x.idle === 1 &&
        x.chosen === 0 &&
        x.holdsBusRole === 0 &&
        isDefaultAgentName(x.name, x.kind, x.minted === 1),
    );
    if (gone.length > 0) {
      const ids = JSON.stringify(gone.map((x) => x.id));
      sql.exec(
        "delete from former_names where kind = 'away' and agent_id in (select value from json_each(?))",
        ids,
      );
      sql.exec(
        "delete from minted_names where agent_id in (select value from json_each(?))",
        ids,
      );
      sql.exec(
        "delete from rename_rl where agent_id in (select value from json_each(?))",
        ids,
      );
      sql.exec(
        "delete from agents where live = 0 and id in (select value from json_each(?))",
        ids,
      );
      logEvent("default_named_purged", { n: gone.length });
    }
    const last = rows.at(-1);
    if (rows.length >= BATCH && last) {
      sql.exec(
        "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
        OWNER_ORG_ID,
        DEFAULT_PURGE_KEY,
        JSON.stringify({ u: last.u, r: last.rid, kept: 0 }),
      );
      return true;
    }
    sql.exec(
      "delete from meta where org_id = ? and key = ?",
      OWNER_ORG_ID,
      DEFAULT_PURGE_KEY,
    );
    // A pass that saw no closed agent old enough needs no gap: its deadline is
    // the oldest one's hour.
    if (cur !== null || rows.length > 0)
      sql.exec(
        "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
        OWNER_ORG_ID,
        DEFAULT_PURGE_NEXT_KEY,
        String(now + DEFAULT_PURGE_GAP_MS),
      );
    return false;
  }

  /**
   * #2311: when the default-name sweep next has work: a pass under way, else
   * the later of the oldest closed agent's DEFAULT_NAME_AWAY_MS and the gap
   * since the last pass (one index lookup). Null with no closed agent.
   */
  #defaultPurgeDeadline(): number | null {
    const sql = this.ctx.storage.sql;
    // One index lookup, like #purgeDeadline: never a scan of the closed
    // history. The sweep itself decides which rows it can take (its pass gap
    // keeps a closed agent that stays from waking the alarm in a loop).
    const oldest = one<{ t: number | null }>(
      sql,
      "select min(updated_at) as t from agents indexed by agents_closed where live = 0",
    )?.t;
    if (oldest === null || oldest === undefined) return null;
    const meta = (k: string) =>
      one<{ value: string }>(
        sql,
        "select value from meta where org_id = ? and key = ?",
        OWNER_ORG_ID,
        k,
      )?.value;
    if (meta(DEFAULT_PURGE_KEY) !== undefined) return this.#now() + 1;
    const due = oldest + DEFAULT_NAME_AWAY_MS + 1;
    const next = parseDecimal(meta(DEFAULT_PURGE_NEXT_KEY) ?? "");
    return next === null ? due : Math.max(due, next);
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
   * queued agent, its acked notices lose their bodies (#1295: pending mail
   * is kept for the away reservation, not expired here). At most BATCH agents
   * and BATCH bodies per step; a row is rewritten with the agents still to do, and deleted
   * once empty (or unreadable). True while any row remains.
   */
  #drainClosed(): boolean {
    const sql = this.ctx.storage.sql;
    let visits = 0;
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
    if (bodies < BATCH)
      logEvent("drain_step", {
        kind: "closed",
        expired: 0,
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
   * Oversized bodies go as a notice. Bounded by MAILBOX_PENDING_CAP (200):
   * an agent never has more pending than that, read SWEEP_BATCH at a time. Arms for each
   * row's expiry (a B6-era row may never have armed one). A receipt past its TTL, or with no body anywhere (lost to an
   * eviction), expires instead: never delivered. The daemon dedupes by
   * msg_id, so redelivering an unacked held body is safe.
   */
  #flush(ws: WebSocket, agent: AgentRow): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    // Paged by rowid: a mailbox holds up to MAILBOX_PENDING_CAP (#1295), more
    // than one BATCH. Reads go before sends of the same page, never after.
    let after = agent.sessionStartRowid;
    for (let page = 0; page <= MAILBOX_PENDING_CAP / BATCH; page++) {
      const rows = all<ReceiptRow & { rid: number }>(
        sql,
        `select ${RECEIPT_COLS}, rowid as rid from receipts where to_agent = ? and state = 'pending' and rowid > ? order by rowid limit ?`,
        agent.id,
        after,
        BATCH,
      );
      for (const r of rows) this.#flushOne(ws, agent, r, now);
      const last = rows.at(-1);
      if (rows.length < BATCH || last === undefined) return;
      after = last.rid;
    }
  }

  /** One pending receipt of #flush: delivered, or expired when it has no body or is past its TTL. */
  #flushOne(ws: WebSocket, agent: AgentRow, r: ReceiptRow, now: number): void {
    const sql = this.ctx.storage.sql;
    {
      if (r.expiresAt <= now) {
        this.#expire(r.id, r.fromAgent);
        return;
      }
      const h = this.#held.get(r.id);
      const body =
        h?.body ??
        one<{ body: string }>(sql, "select body from mail where id = ?", r.id)
          ?.body ??
        null;
      if (body === null) {
        this.#expire(r.id, r.fromAgent, "lost_body");
        return;
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
        return;
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

  // ----------------------------------------------------------------- notices

  /** #1828: why one more old-daemon-held row (not counting its own key) does not fit, or null. */
  #oldHeldOver(ns: string, lname: string, ckey: string): string | null {
    const sql = this.ctx.storage.sql;
    const notSelf = "not (to_ns = ? and to_lname = ? and ckey = ?)";
    const atAddress =
      one<{ n: number }>(
        sql,
        `select count(*) as n from notices where parked = 2 and to_ns = ? and to_lname = ? and ${notSelf}`,
        ns,
        lname,
        ns,
        lname,
        ckey,
      )?.n ?? 0;
    if (atAddress >= NOTICES_OLD_PER_ADDRESS) return "old_daemon_address_cap";
    const all2 =
      one<{ n: number }>(
        sql,
        `select count(*) as n from notices where parked = 2 and ${notSelf}`,
        ns,
        lname,
        ckey,
      )?.n ?? 0;
    return all2 >= NOTICES_OLD_MAX ? "old_daemon_cap" : null;
  }

  /**
   * Sends one notice frame. On a notice_ack socket, a notice with a comment
   * target is recorded (bounded, expiring) so the daemon's ack or refuse can
   * settle it (#1752). False when the socket refused the frame.
   */
  #sendNotice(
    ws: WebSocket,
    agent: AgentRow,
    text: string,
    ack: string | null,
  ): boolean {
    const frame = noticeFrame(agent, text);
    if (!trySendFrame(ws, frame)) return false;
    if (ack !== null && !noticeAckGated(ws)) {
      // #2062: no notice_ack on this socket, so a send is the delivery: the
      // row's target and every folded one settle now (#2065). This includes
      // the live path's own target: the Worker settles it too, and doing both
      // is idempotent, while a Worker-budget "gone" is lifted to delivered.
      // With no own ack, the first folded target takes the first slot and is
      // settled like the rest.
      try {
        const t = JSON.parse(ack) as AckTarget & { more?: AckTarget[] };
        const all = [t, ...(t.more ?? [])];
        for (const x of all) this.#settleTarget(x, "delivered");
      } catch {
        // a malformed target has nothing to settle
      }
    }
    if (ack !== null && noticeAckGated(ws) && frame.type === "deliver") {
      const sql = this.ctx.storage.sql;
      const expiresAt = this.#now() + NOTICE_ACK_TTL_MS;
      sql.exec(
        "insert or replace into notice_acks (msg_id, machine_id, ack, expires_at) values (?, ?, ?, ?)",
        frame.msg_id,
        agent.machineId,
        ack,
        expiresAt,
      );
      const over =
        (one<{ n: number }>(sql, "select count(*) as n from notice_acks")?.n ??
          0) - NOTICE_ACKS_MAX;
      if (over > 0) {
        // #2082: an evicted row never gets its ack: its targets settle gone.
        const old = all<{ rid: number; ack: string }>(
          sql,
          "select rowid as rid, ack from notice_acks order by rowid limit ?",
          over,
        );
        for (const r of old) {
          this.#settleAckRow(r.ack);
          sql.exec("delete from notice_acks where rowid = ?", r.rid);
        }
      }
      this.#arm(expiresAt);
    }
    return true;
  }

  /**
   * #1752: an ack or refuse for a notice sent to `machineId`'s notice_ack
   * socket. Settles the comment target once (the row goes first, so a
   * duplicate or another machine's frame finds nothing). True when the id was
   * a recorded notice of this machine.
   */
  #settleNoticeAck(
    machineId: string,
    msgId: string,
    outcome: "delivered" | "refused",
  ): boolean {
    const sql = this.ctx.storage.sql;
    const r = one<{ ack: string }>(
      sql,
      "select ack from notice_acks where msg_id = ? and machine_id = ?",
      msgId,
      machineId,
    );
    if (!r) return false;
    sql.exec("delete from notice_acks where msg_id = ?", msgId);
    let t: AckTarget & { more?: AckTarget[] };
    try {
      t = JSON.parse(r.ack);
    } catch {
      return true;
    }
    // #1752: targets of notices this one replaced settle with it.
    for (const x of [t, ...(Array.isArray(t.more) ? t.more : [])])
      this.#settleTarget(x, outcome === "delivered" ? "delivered" : "gone");
    return true;
  }

  #settleTarget(t: AckTarget, state: "delivered" | "gone"): void {
    // The runtime DO moves a target only out of "queued" (never past seen).
    // A failed call is retried a few times (bounded), as it is idempotent.
    const settle = async () => {
      for (let i = 0; i < NOTICE_SETTLE_TRIES; i++) {
        try {
          await runtimeStub(this.env, t.a).commentsTargetSettle({
            commentId: t.c,
            kind: t.k,
            key: t.key,
            state,
          });
          return;
        } catch {
          if (i + 1 < NOTICE_SETTLE_TRIES)
            await new Promise((r) =>
              setTimeout(r, NOTICE_SETTLE_RETRY_MS * (i + 1)),
            );
        }
      }
      logEvent("notice_ack_failed", {});
    };
    this.ctx.waitUntil(settle());
  }

  /**
   * #1752: a waiting notice that will never be sent (expired, dropped, its
   * address gone): its target and every folded target settle as gone, as a
   * refuse does, and the row goes.
   */
  #dropHeld(toNs: string, toLname: string, ckey: string): void {
    const sql = this.ctx.storage.sql;
    const r = one<{ ack: string | null; fa: string | null }>(
      sql,
      "select ack, fold_acks as fa from notices where to_ns = ? and to_lname = ? and ckey = ?",
      toNs,
      toLname,
      ckey,
    );
    if (r) this.#settleGone([r.ack, ...parseAcks(r.fa)]);
    sql.exec(
      "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
      toNs,
      toLname,
      ckey,
    );
  }

  /** #2082: a notice_acks row that will never be acked: its target and every folded one settle as gone. */
  #settleAckRow(ack: string): void {
    try {
      const t = JSON.parse(ack) as AckTarget & { more?: AckTarget[] };
      for (const x of [t, ...(Array.isArray(t.more) ? t.more : [])])
        this.#settleTarget(x, "gone");
    } catch {
      // a malformed target has nothing to settle
    }
  }

  #settleGone(acks: (string | null)[]): void {
    for (const x of acks) {
      if (!x) continue;
      try {
        this.#settleTarget(JSON.parse(x), "gone");
      } catch {
        // a malformed target has nothing to settle
      }
    }
  }

  #acceptNotice(n: BusNotice): DeliveryOutcome {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    // #1752: as a send resolves (role > live > former): a role address in
    // the notice's own namespace reaches its current live holder (same org
    // and namespace scope; a vacant role falls through). A follow row still at
    // an address the agent has since left (the re-key is best effort, and a
    // notice can be in flight) reaches it by its live former name. The notice
    // is then kept at the resolved agent's address, so the flush paths find it.
    const sent = n.to.name.toLowerCase();
    if (n.toIdentity !== undefined) {
      // #2238: addressed to an identity: only the live agent at this very name
      // that holds it. No role or former-name resolution. A mismatch (renamed,
      // name reused, another member's id) drops the notice and touches no
      // waiting row: the agent at the name is not who it was meant for.
      const at = liveVisibleIn(sql, n.to.namespace, sent);
      if (!at || identityOfAgent(sql, at.id) !== n.toIdentity) {
        logEvent("notice_dropped", { reason: "identity" });
        return "dropped";
      }
    }
    const byRole =
      n.toIdentity !== undefined
        ? null
        : resolveRoleIn(sql, OWNER_ORG_ID, n.to.namespace, sent);
    const liveNamed = liveVisibleIn(sql, n.to.namespace, sent);
    const former =
      byRole !== null || liveNamed !== null || n.toIdentity !== undefined
        ? []
        : liveFormer(sql, sent, now, { ns: n.to.namespace }, 2);
    const byAlias = byRole?.ok
      ? byRole.agent
      : former.length === 1
        ? former[0]
        : undefined;
    const lname = byAlias ? byAlias.name.toLowerCase() : sent;
    const to = byAlias
      ? { namespace: byAlias.namespace, name: byAlias.name }
      : n.to;
    const agent = byAlias ?? liveVisibleIn(sql, to.namespace, lname);
    const key = [to.namespace, lname, n.coalesceKey] as const;
    // No live session at the address: nothing is kept (and a waiting notice
    // for it is stale, so it goes too).
    if (!agent) {
      this.#dropHeld(...key);
      return "dropped";
    }
    const live = liveSocket(this.ctx, agent.machineId);
    // A socket that cannot decode a notice counts as offline (noticeGated).
    const socket = live && noticeGated(live) ? live : null;
    const notBefore = n.notBefore ?? now;
    let old = one<{
      ack: string | null;
      foldN: number;
      foldAcks: string | null;
      toIdentity: string | null;
    }>(
      sql,
      "select ack, fold_n as foldN, fold_acks as foldAcks, to_identity as toIdentity from notices where to_ns = ? and to_lname = ? and ckey = ?",
      ...key,
    );
    // #2238: a waiting notice for another identity than this address holds now
    // is not this agent's: it settles as gone and never folds into this one.
    if (old?.toIdentity && old.toIdentity !== identityOfAgent(sql, agent.id)) {
      this.#settleGone([old.ack, ...parseAcks(old.foldAcks)]);
      sql.exec(
        "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
        ...key,
      );
      old = null;
    }
    const heldIdentity = n.toIdentity ?? old?.toIdentity ?? null;
    // #1752: the replaced notice's target and fold count move to the new one.
    const folds = old
      ? [...parseAcks(old.foldAcks), ...(old.ack ? [old.ack] : [])]
      : [];
    // Oldest first beyond the bound: those targets settle as gone now.
    this.#settleGone(
      folds.splice(0, Math.max(0, folds.length - NOTICE_FOLD_MAX)),
    );
    const foldN = old && n.kind === "comment" ? old.foldN + 1 : 0;
    if (socket && notBefore <= now) {
      // A socket that refuses the frame (#1752) leaves the notice held
      // (parked) for the next agent_up, never stored as delivered. An older
      // held notice of the key is folded in and goes only once this is sent.
      const ack = noticeAckOf(n);
      const merged: NoticeRow = {
        toNs: to.namespace,
        toLname: lname,
        ckey: n.coalesceKey,
        text: n.text,
        ack,
        foldN,
        foldRef: foldN > 0 ? n.artifactId : null,
        foldAcks: folds.length > 0 ? JSON.stringify(folds) : null,
        toIdentity: heldIdentity,
      };
      if (
        this.#sendNotice(
          socket,
          agent,
          noticeTextOf(merged),
          noticeSendAck(merged),
        )
      ) {
        sql.exec(
          "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
          ...key,
        );
        // #1752: on a notice_ack socket the notice counts as delivered only
        // at the daemon's ack, so it reads held (queued) until then.
        return ack !== null && noticeAckGated(socket) ? "held" : "delivered";
      }
    }
    const exists = old !== null;
    // Due with no usable socket: parked until the machine's agent_up (1), or
    // held for a live daemon too old to read it (2, own caps).
    // A socket that can read notices but refused the frame (#1752) is
    // offline-like (1), never "too old" (2).
    const parked = notBefore > now ? 0 : live && !socket ? 2 : 1;
    if (parked === 2) {
      const reason = this.#oldHeldOver(to.namespace, lname, n.coalesceKey);
      if (reason) {
        this.#dropHeld(...key);
        logEvent("notice_dropped", { reason });
        return "dropped";
      }
    } else if (!exists) {
      const held =
        one<{ n: number }>(
          sql,
          "select count(*) as n from notices where parked < 2",
        )?.n ?? 0;
      if (held >= NOTICES_MAX) {
        logEvent("notice_dropped", { reason: "cap" });
        return "dropped";
      }
    }
    const expiresAt = Math.max(notBefore, now) + NOTICE_HOLD_MS;
    const foldRef = foldN > 0 ? n.artifactId : null;
    sql.exec(
      `insert or replace into notices (to_ns, to_lname, ckey, id, text, not_before, expires_at, parked, ack, fold_n, fold_ref, fold_acks, to_identity)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...key,
      n.id,
      n.text,
      notBefore,
      expiresAt,
      parked,
      noticeAckOf(n),
      foldN,
      foldRef,
      folds.length > 0 ? JSON.stringify(folds) : null,
      heldIdentity,
    );
    this.#arm(parked > 0 ? expiresAt : notBefore);
    this.#arm(expiresAt);
    return "held";
  }

  /**
   * #2238: a waiting notice addressed to an identity that the agent now at its
   * address does not hold: it settles as gone and its row goes. True then.
   */
  #identityMismatch(r: NoticeRow, agent: AgentRow): boolean {
    if (!r.toIdentity) return false;
    const sql = this.ctx.storage.sql;
    if (identityOfAgent(sql, agent.id) === r.toIdentity) return false;
    this.#settleGone([r.ack, ...parseAcks(r.foldAcks)]);
    sql.exec(
      "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
      r.toNs,
      r.toLname,
      r.ckey,
    );
    logEvent("notice_dropped", { reason: "identity" });
    return true;
  }

  /**
   * Sends the waiting notices addressed to `agent` that are due, when it
   * has a live socket: the reconnect (agent_up) path, which also reaches
   * parked ones. Bounded by NOTICE_FLUSH_BATCH.
   */
  #flushNoticesFor(ws: WebSocket, agent: AgentRow): void {
    // A socket without the cap cannot decode a notice: leave them parked.
    if (!noticeGated(ws)) return;
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const rows = all<NoticeRow>(
      sql,
      `select ${NOTICE_COLS} from notices where to_lname = ? and not_before <= ? and expires_at > ?
         and (to_ns = ? or ?) order by not_before limit ?`,
      agent.name.toLowerCase(),
      now,
      now,
      agent.namespace,
      agent.global === 1 ? 1 : 0,
      NOTICE_FLUSH_BATCH,
    );
    for (const r of rows) {
      // The address resolves to this agent now, or the notice is not its.
      if (liveVisibleIn(sql, r.toNs, r.toLname)?.id !== agent.id) continue;
      if (this.#identityMismatch(r, agent)) continue;
      if (!this.#sendNotice(ws, agent, noticeTextOf(r), noticeSendAck(r)))
        break;
      sql.exec(
        "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
        r.toNs,
        r.toLname,
        r.ckey,
      );
    }
    // A full batch: more may wait. Hand the rest to the alarm (it sends in
    // bounded steps to this live socket) instead of leaving them parked.
    if (rows.length >= NOTICE_FLUSH_BATCH) {
      sql.exec(
        "update notices set parked = 0 where to_lname = ? and (to_ns = ? or ?) and parked > 0",
        agent.name.toLowerCase(),
        agent.namespace,
        agent.global === 1 ? 1 : 0,
      );
      this.#arm(now + NOTICE_PACE_MS);
    }
  }

  /**
   * The alarm's step for notices: expired ones go; due ones are sent to a
   * live socket, dropped when the address has no live agent, and parked when
   * the machine is offline (its agent_up sends them). True when the batch
   * was full.
   */
  #sweepNotices(now: number): boolean {
    const sql = this.ctx.storage.sql;
    // #1828: an expired notice was never delivered: count it (ids and counts only).
    const expired = all<{
      rid: number;
      id: string;
      parked: number;
      ack: string | null;
      fa: string | null;
    }>(
      sql,
      "select rowid as rid, id, parked, ack, fold_acks as fa from notices where expires_at <= ? limit ?",
      now,
      BATCH,
    );
    for (const r of expired) {
      this.#settleGone([r.ack, ...parseAcks(r.fa)]);
      sql.exec("delete from notices where rowid = ?", r.rid);
    }
    if (expired.length > 0)
      logEvent("notice_expired", {
        count: expired.length,
        parked: expired.filter((r) => r.parked > 0).length,
        ids: expired
          .slice(0, NOTICE_LOG_IDS)
          .map((r) => r.id)
          .join(","),
      });
    // #1752/#2082: an ack that never came settles its targets gone, and the
    // row goes: an ack after that finds no row and is ignored. Bounded by
    // BATCH per pass; the alarm re-arms for the rest.
    for (const r of all<{ rid: number; ack: string }>(
      sql,
      "select rowid as rid, ack from notice_acks where expires_at <= ? order by expires_at limit ?",
      now,
      BATCH,
    )) {
      this.#settleAckRow(r.ack);
      sql.exec("delete from notice_acks where rowid = ?", r.rid);
    }
    // #2211: withdrawal records past their hour go, BATCH per pass.
    const records = all<{ rid: number }>(
      sql,
      "delete from notice_withdrawals where rowid in (select rowid from notice_withdrawals indexed by notice_withdrawals_at where at <= ? limit ?) returning rowid as rid",
      now - WITHDRAW_RECORD_MS,
      BATCH,
    ).length;
    const gone = expired.length >= BATCH || records >= BATCH;
    const due = all<NoticeRow>(
      sql,
      `select ${NOTICE_COLS} from notices where parked = 0 and not_before <= ? order by not_before limit ?`,
      now,
      BATCH,
    );
    // Parking and dropping are cheap; only sends are paced (#1752).
    let sent = 0;
    let paced = false;
    for (const r of due) {
      if (sent >= NOTICE_FLUSH_BATCH) {
        paced = true;
        break;
      }
      const agent = liveVisibleIn(sql, r.toNs, r.toLname);
      if (agent && this.#identityMismatch(r, agent)) continue;
      const live = agent && liveSocket(this.ctx, agent.machineId);
      const socket = live && noticeGated(live) ? live : null;
      if (
        agent &&
        socket &&
        this.#sendNotice(socket, agent, noticeTextOf(r), noticeSendAck(r))
      ) {
        sent++;
        sql.exec(
          "delete from notices where to_ns = ? and to_lname = ? and ckey = ?",
          r.toNs,
          r.toLname,
          r.ckey,
        );
      } else if (agent) {
        // A live socket that cannot read it: old-daemon share; none: offline.
        // A capable socket that refused the frame (#1752) is offline-like (1).
        const tooOld = live && !socket;
        const reason = tooOld
          ? this.#oldHeldOver(r.toNs, r.toLname, r.ckey)
          : null;
        if (reason) {
          this.#dropHeld(r.toNs, r.toLname, r.ckey);
          logEvent("notice_dropped", { reason });
        } else {
          sql.exec(
            "update notices set parked = ? where to_ns = ? and to_lname = ? and ckey = ?",
            tooOld ? 2 : 1,
            r.toNs,
            r.toLname,
            r.ckey,
          );
        }
      } else {
        this.#dropHeld(r.toNs, r.toLname, r.ckey);
      }
    }
    // A full step: the rest go out a pace later (#1752), not at once.
    if (paced) this.#arm(now + NOTICE_PACE_MS);
    return gone || (!paced && due.length >= BATCH);
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
    const lost = all<{ id: string; fromAgent: string; expiresAt: number }>(
      sql,
      `select id, from_agent as fromAgent, expires_at as expiresAt from receipts
       where state = 'pending' and held_at is not null and held_at <= ?
         and not exists (select 1 from mail where mail.id = receipts.id)
       order by held_at limit ?`,
      now - LIMITS.ackTimeoutMs,
      BATCH,
    );
    if (lost.length >= BATCH) more = true;
    // Past its TTL it expires as TTL (final), so a late ack cannot flip it (#1951).
    for (const r of lost)
      if (!this.#held.has(r.id))
        this.#expire(
          r.id,
          r.fromAgent,
          r.expiresAt <= now ? undefined : "lost_body",
        );

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

    // 5c. #1317: server notices due or expired.
    if (this.#sweepNotices(now)) more = true;

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
      "delete from send_keys where rowid in (select rowid from send_keys indexed by send_keys_final where final = 1 and created_at < ? limit ?) returning rowid",
      now - SEND_KEY_RETAIN_MS,
      BATCH,
    ).length;
    if (swept >= BATCH) more = true;
    if (this.#sendKeys !== null) this.#sendKeys -= swept;
    // R393b: former names past their grace, rename windows that have ended.
    if (purge(sql, FORMER_PURGE_SQL, now)) more = true;
    if (purge(sql, RENAME_RL_PURGE_SQL, now - HOUR_MS)) more = true;
    // #2110: proofs of rows closed past the away grace.
    if (
      all(
        sql,
        `delete from agent_proofs where rowid in (select p.rowid from agent_proofs p cross join agents a on a.id = p.agent_id
          where a.live = 0 and (a.away_since is null or a.away_since <= ?) limit ?) returning rowid`,
        now - PROOF_AWAY_GRACE_MS,
        BATCH,
      ).length >= BATCH
    )
      more = true;
    // M1: closed agents idle past CLOSED_AGENT_RETAIN_MS (after the sweeps
    // above, so work they just cleared counts).
    if (this.#purgeClosedAgents(now)) more = true;
    if (this.#purgeDefaultNamed(now)) more = true;

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
      min(
        "select min(created_at) as t from send_keys indexed by send_keys_final where final = 1",
        SEND_KEY_RETAIN_MS + 1,
      ),
      this.#purgeDeadline(),
      this.#defaultPurgeDeadline(),
      nextStatusDue(sql),
      min("select min(expires_at) as t from former_names"),
      min("select min(not_before) as t from notices where parked = 0"),
      min("select min(expires_at) as t from notices"),
      min("select min(expires_at) as t from notice_acks"),
      min("select min(at) as t from notice_withdrawals", WITHDRAW_RECORD_MS),
      min("select min(at) as t from rename_rl", HOUR_MS),
      this.#offlineReapDeadline(),
    ].filter((t): t is number => t !== null);
    return ts.length === 0 ? null : Math.min(...ts);
  }
}

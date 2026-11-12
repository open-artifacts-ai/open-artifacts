import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { claudeSessionsDir } from "@oa/bus-adapter-claude-code";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@oa/bus-adapter-opencode/version";
import {
  ADAPTER_CAPS,
  correctedDeliveredText,
  type DaemonFrame,
  excerptOf,
  fitName,
  type Hello,
  type HelloResult,
  isWellFormed,
  lateDeliveredText,
  receiptText,
  replyGoneText,
  serveDaemon,
  stripTerminalControls,
  unconfirmedText,
} from "@oa/bus-ipc";
import {
  AgentRefSchema,
  BUS_CAPS,
  BUS_CMD,
  BUS_ROUTES,
  type ClientFrame,
  ClientFrameSchema,
  frameId,
  MAX_WAITING_QUERY,
  type SendFrame,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { type AgentRecord, AgentTable, withLinkHash } from "./agents.ts";
import {
  type Attest,
  attest,
  claudeProcStartOf,
  commOf,
  procStartOf,
} from "./attest.ts";
import {
  CLAUDE_LINKS_MAX,
  type ClaudeLink,
  readClaudeLinks,
  writeClaudeLinks,
} from "./claude-links.ts";
import {
  type CodexAgent,
  readCodexAgents,
  writeCodexAgents,
} from "./codex-agents.ts";
import {
  CODEX_REFUSALS,
  type CodexAttestDeps,
  codexAttestor,
  codexHome,
  codexProxyNamespaces,
} from "./codex-attest.ts";
import {
  AWAY_IDLE_MS,
  type CodexAway,
  readCodexAway,
  trimAway,
  writeCodexAway,
} from "./codex-away.ts";
import { codexThreadNames } from "./codex-names.ts";
import { replayInBatches, TakenWatch } from "./codex-taken.ts";
import {
  type Config,
  claudeReturnDir,
  home,
  prepareReturnDir,
  prepareSocketDir,
  readConfig,
  revokedMarker,
  StartError,
  savedToken,
  socketPath,
} from "./config.ts";
import {
  ConfigIssues,
  configPaths,
  inspectApprovals,
  inspectGlobal,
  inspectRemotes,
} from "./config-issues.ts";
import { createDeliver, type DeliverFn, type NotifyFn } from "./deliver.ts";
import type { EventFields } from "./event-log.ts";
import { HubConnection, type HubOptions } from "./hub.ts";
import {
  cachedProcStart,
  claudeTarget,
  claudeTargetState,
  isRunning,
  liveClaudeFiles,
  liveClaudeScan,
  liveClaudeSessions,
} from "./liveness/claude.ts";
import {
  gitRecordRoot,
  type Namespace,
  resolveNamespace,
} from "./namespace.ts";
import { remotesFile } from "./namespaces.ts";
import { Outbox } from "./outbox.ts";
import {
  type AttachDeps,
  cachedAttach,
  defaultAttachDeps,
} from "./presence/attached.ts";
import {
  lstartEpoch,
  opencodePresenceDir,
  openSessions,
  openState,
} from "./presence/opencode.ts";
import { proposeReach } from "./reach.ts";
import { Resends } from "./resend.ts";
import { type AgentCap, capOf, Pending, routeLocal } from "./routes.ts";
import {
  DELIVERED_WAIT_MS,
  type Notice,
  Receipts,
  SentStore,
  type Timer,
} from "./sent.ts";
import { AgentStatusRelay, STATUS_COPY } from "./status.ts";
import { ClaudeTransport } from "./transports/claude.ts";
import {
  CODEX_WAKE_TEXT,
  CodexTransport,
  type CodexTransportOptions,
  codexBinFile,
  codexHostWakes,
  execCodex,
  resolveCodexBin,
} from "./transports/codex.ts";
import { HeldStore } from "./transports/held.ts";
import {
  execSpawn,
  OpenCodeTransport,
  type Spawn,
  spawnExec,
} from "./transports/opencode.ts";
import { PiTransport } from "./transports/pi.ts";

export * from "./agents.ts";
export * from "./attest.ts";
export * from "./codex-attest.ts";
export * from "./codex-names.ts";
export * from "./codex-taken.ts";
export * from "./config.ts";
export * from "./config-issues.ts";
export * from "./dedupe.ts";
export * from "./deliver.ts";
export * from "./event-log.ts";
export * from "./global.ts";
export * from "./hub.ts";
export * from "./leads/templates.ts";
export * from "./liveness/claude.ts";
export * from "./namespace.ts";
export * from "./namespaces.ts";
export * from "./outbox.ts";
export { readOwnFile } from "./own-file.ts";
export * from "./presence/attached.ts";
export * from "./presence/opencode.ts";
export * from "./resend.ts";
export * from "./routes.ts";
export * from "./sent.ts";
export * from "./status.ts";
export * from "./transports/claude.ts";
export * from "./transports/codex.ts";
export * from "./transports/opencode.ts";
export * from "./transports/pi.ts";

const NOTICE_RETRY_MS = 30_000;
/** #1956: a ref binding whose link has been closed this long lapses, even if its pid lives. */
export const BINDING_IDLE_MS = 24 * 60 * 60_000;
/** #1956: how often the bindings map is swept; the sync tick runs more often than needed. */
const BINDING_SWEEP_MS = 60_000;
/** The hub caps renames per hour; a refused one holds that agent's renames this long. */
const RENAME_HOLD_MS = 60 * 60_000;
/** At most this many rename frames per ref in this window. */
const RENAME_WINDOW_MS = 60_000;
const RENAME_WINDOW_MAX = 3;
/** A registration the hub rate-limited is retried this late, or on the next reconnect. */
const LIMITED_RETRY_MS = 5 * 60_000;
/** #1822: how long and how many proofs wait for a record that does not exist yet. */
const PENDING_PROOF_MS = 60_000;
const PENDING_PROOF_MAX = 64;
/** How far back `oa-bus status` lists late deliveries. */
const LATE_WINDOW_MS = 60 * 60_000;
/**
 * Pi and omp (a Pi fork) run the same extension; Hermes runs a plugin that
 * speaks the same protocol, and so does OpenClaw's. Each lives as long as its connection and receives on it.
 */
const piLike = (kind: string) =>
  kind === "pi" || kind === "omp" || kind === "hermes" || kind === "openclaw";

/** #1608: the fixed refusal for a second concurrent claim on a bound pi-like ref. */
export const REF_BOUND = "agent_ref is bound to another live connection";

export type DaemonDeps = {
  transports?: Partial<Record<AgentRecord["kind"], DeliverFn>>;
  /** Per-harness notices to a sending session; OpenCode and Pi add theirs here. */
  notifiers?: Partial<Record<AgentRecord["kind"], NotifyFn>>;
  /** Outgoing msg_ids awaiting a final receipt (0600); default ~/.oa-bus/sent.json. */
  sentFile?: string;
  version?: string;
  log?: (msg: string) => void;
  /**
   * The always-on event log (#2029): joins, refusals, liveness, hub link.
   * Fields are ids and keys, never a body or a token. Default: none.
   */
  events?: ((event: string, fields?: EventFields) => void) & {
    /** Resolves when queued lines are written; stop() awaits it. */
    flush?: () => Promise<void>;
  };
  /** Log each successful attestation; default: OA_BUS_DEBUG=1, read at startup. */
  debug?: boolean;
  /**
   * The hub refused this machine's token; `oa-bus daemon` exits on it.
   * `replaced`: machine.json holds a newer token, so a restart uses it.
   */
  onRevoked?: (replaced?: boolean) => void;
  /** The bound socket was removed or replaced; `oa-bus daemon` exits 1 so the service rebinds. */
  onSocketLost?: () => void;
  /** How often the bound socket is checked; default 60 s. */
  socketCheckMs?: number;
  /** Written on revoke for `oa-bus status` and doctor; default ~/.oa-bus/revoked. */
  revokedFile?: string;
  /** How long status waits for each namespace's roster from the hub. */
  statusRosterMs?: number;
  /** Retry delay for a rate-limited agent_up; default 5 min. */
  limitedRetryMs?: number;
  /** Test seams. */
  config?: Config;
  socketPath?: string;
  attest?: (hello: Parameters<typeof attest>[0]) => Attest | Promise<Attest>;
  resolveNamespace?: (cwd: string) => Namespace;
  pendingTimeoutMs?: number;
  /** The clock for that timeout; tests bring a fake one. */
  pendingTimer?: Timer;
  /** How long a queued send waits for delivered; default DELIVERED_WAIT_MS. */
  deliveredWaitMs?: number;
  /** The clock for that wait; tests bring a fake one. */
  deliveredTimer?: Timer;
  /** How long a send whose link dropped keeps being resent; default RESEND_WINDOW_MS. */
  resendWindowMs?: number;
  /** The clock for resends; tests bring a fake one. */
  resendTimer?: Timer;
  resendNow?: () => number;
  /** The clock for binding idle expiry and sweeps (#1956); tests bring a fake one. */
  bindingNow?: () => number;
  hub?: Partial<Pick<HubOptions, "backoffMs" | "pingMs" | "stableMs" | "pace">>;
  /** The HTTP client for the reach proposal (#1346); tests bring a fake one. */
  fetch?: typeof fetch;
  /** How long the hub gets to answer a reach proposal; default REACH_TIMEOUT_MS. */
  reachTimeoutMs?: number;
  claude?: {
    sessionsDir?: string;
    socketsDir?: string;
    statusWindowMs?: number;
    injectTimeoutMs?: number;
    heldFile?: string;
    /** Default: beside heldFile, or ~/.oa-bus/claude-return.json. */
    returnIndexFile?: string;
    syncMs?: number;
    /** #2110: how long a running session with an unreadable start time or file stays live. Default 10 min. */
    unknownGraceMs?: number;
    /** #2110: delays of the local retries of a retryable timeout. Default 2 s, 5 s, 15 s. */
    retryDelaysMs?: number[];
    procStart?: (pid: number) => string | null;
    isRunning?: (pid: number) => boolean;
    /** Proof hashes of live sessions kept across a restart (#2050); default ~/.oa-bus/claude-links.json. */
    linksFile?: string;
  };
  opencode?: {
    /** TUI presence files; default ~/.oa-bus/opencode-tui. */
    presenceDir?: string;
    /** Replaces reading presence files: the open root session ids. */
    openSessions?: () => Set<string>;
    /** OS reads tying a TUI to its service (#1950); default the real /proc, ps and lsof. */
    attach?: AttachDeps;
    /** Runs `opencode api`; default execFile with a 20 s kill timeout. */
    spawn?: Spawn;
    procStart?: (pid: number) => string | null;
    isRunning?: (pid: number) => boolean;
    ancestors?: (pid: number) => number[];
    comm?: (pid: number) => string | null;
    /** Read once at start; default `opencode --version`. */
    version?: () => Promise<string | undefined>;
    /** Prompts that timed out below the prompt-id floor; default ~/.oa-bus/opencode-uncertain.json. */
    uncertainFile?: string;
  };
  codex?: CodexAttestDeps & {
    /** Every this many syncs, each live thread's lock is proven again; default 15 (30 s). */
    relockEvery?: number;
    /** Finds the user's `codex`; default config, then PATH, then the Codex app. */
    resolveBin?: CodexTransportOptions["resolve"];
    /** Runs `codex queue`; default execFile with a 10 s timeout. */
    run?: CodexTransportOptions["run"];
    /** Whether a Codex process wakes on a queued message; default: not `codex exec`. */
    wakes?: CodexTransportOptions["wakes"];
    /** Queued ids no turn has taken yet; default ~/.oa-bus/codex-pending.json. */
    takenFile?: string;
    /** Live Codex threads kept across a restart (#1748); default ~/.oa-bus/codex-agents.json. */
    agentsFile?: string;
    /** #2029: Codex threads proved here, kept for wake; default ~/.oa-bus/codex-away.json. */
    awayFile?: string;
    /** #2029: wakes already tried, kept 7 days; default ~/.oa-bus/codex-woken.json. */
    wokenFile?: string;
    /** #2029: the shortest gap between hub roster reads for one thread; default 5 min. */
    wakeAskMs?: number;
    /** #2029: how long a sent wake waits for the thread's own call before `wake_unanswered`; default 5 min. */
    wakeAnswerMs?: number;
    /** #2029: the shortest gap between two wakes of one thread; default 1 h. */
    wakeAgainMs?: number;
    /** #2029: the shortest gap between wake checks (lsof, ps, rollout reads); default 5 min. */
    wakeCheckMs?: number;
  };
  pi?: {
    /** How long the extension has to hand a message to Pi and ack it. */
    ackTimeoutMs?: number;
  };
  /** set_status: test seams. */
  status?: {
    statusEveryMs?: number;
    timer?: Timer;
  };
};

export type Daemon = {
  stop: () => Promise<void>;
  hub: HubConnection;
  agents: AgentTable;
  /** Test seam (#1956): the ref bindings held, and one sweep run now. */
  bindings: { count: () => number; sweep: () => void };
};

/** A refusal's key: the CODEX_REFUSALS name for its text, else "other". */
export const refusalKey = (reason: string): string =>
  Object.entries(CODEX_REFUSALS).find(([, text]) => text === reason)?.[0] ??
  "other";

/** The ids an agent event carries: names, refs and namespaces, never content. */
const agentFields = (a: AgentRecord, reason?: string): EventFields => ({
  kind: a.kind,
  name: a.busName,
  ref: a.ref,
  ns: a.namespace,
  pid: a.pid,
  ...(reason !== undefined ? { reason } : {}),
});

export async function runDaemon(deps: DaemonDeps = {}): Promise<Daemon> {
  const cfg = deps.config ?? readConfig();
  const log = deps.log ?? ((msg: string) => console.error(`oa-bus: ${msg}`));
  const debug = deps.debug ?? process.env.OA_BUS_DEBUG === "1";
  /** Best effort: the event log never throws into the daemon. */
  const ev = (event: string, fields?: EventFields): void => {
    try {
      deps.events?.(event, fields);
    } catch {}
  };
  const agents = new AgentTable();
  // A timed-out request still queued is dropped: an adapter's retry must not send twice.
  const pending = new Pending(
    deps.pendingTimeoutMs,
    (id) => {
      // One that may have reached the hub keeps going, and reads as Queued: an
      // error would invite a resend under a new id. Its outcome comes later, as a
      // late delivery or a notice. The hub's msg_id is not known yet.
      // `held`: the msg_id is the frame id; adapters never show or fetch it.
      if (resends.held(id))
        return { type: "receipt", msg_id: id, state: "pending", held: true };
      if (!hub.cancel(id)) return undefined;
      receipts.forget(id);
      resends.untrack(id);
      return undefined;
    },
    deps.pendingTimer,
  );
  /** Open local connections per agent_ref; the agent is closed when the last one goes. */
  const conns = new Map<string, number>();
  /** Each Pi session's open extension connections, newest last: Pi receives on them. */
  const piLinks = new Map<string, Map<Hello, (f: DaemonFrame) => void>>();
  /** #1608: who first claimed each pi-like ref; kept after its link closes, until its pid dies. */
  const bindings = new Map<
    string,
    {
      token: string;
      pid: number;
      kind: string;
      start?: string;
      /** When the last link closed; unset while a link is open. */
      closedAt?: number;
    }
  >();
  const bindingNow = deps.bindingNow ?? Date.now;
  /** Claimant gone, pid reused, or no link for BINDING_IDLE_MS. An open link never lapses. */
  const bindingLapsed = (
    ref: string,
    claim: { pid: number; start?: string; closedAt?: number },
    startOf: (pid: number) => string | null,
  ): boolean => {
    if (conns.has(ref)) return false;
    if (
      claim.closedAt !== undefined &&
      bindingNow() - claim.closedAt >= BINDING_IDLE_MS
    )
      return true;
    if (!running(claim.pid)) return true;
    const now = claim.start === undefined ? null : startOf(claim.pid);
    return now !== null && claim.start !== undefined && now !== claim.start;
  };
  let bindingSweptAt = 0;
  /** Cheap: pid liveness is kill(pid, 0) and start times come from the cached read, never a fresh `ps` (#1928). Runs on the sync tick, rate limited. */
  const sweepBindings = () => {
    const t = bindingNow();
    if (t - bindingSweptAt < BINDING_SWEEP_MS) return;
    bindingSweptAt = t;
    for (const [ref, claim] of bindings)
      if (bindingLapsed(ref, claim, (p) => claudeSessions.procStart(p)))
        bindings.delete(ref);
  };

  /**
   * A /clear handover not yet announced: it waits for hello_ok (#1582), so the
   * hub knows nothing of the ref and nothing may name it before.
   */
  const held = (ref: string): boolean => {
    const rec = agents.byRef(ref);
    return rec?.replaces !== undefined && !hubHelloed;
  };
  /** Whom a new session replaces: B's own predecessor while B is still unannounced. */
  const handoverOf = (old: AgentRecord): string =>
    old.replaces !== undefined && !hubHelloed ? old.replaces : old.ref;
  const sessions = () => ({
    open: agents.openRefs().filter((r) => !held(r)),
    closed: agents.closedRefs(),
  });
  const announceSessions = () => {
    // Every close goes through here: a closed agent's rate limit mark goes with it.
    for (const ref of limited.keys())
      if (!agents.byRef(ref)?.live) clearLimited(ref);
    for (const m of [renameFrames, renameHeldUntil])
      for (const ref of m.keys()) if (!agents.byRef(ref)?.live) m.delete(ref);
    return hub.send({ v: 1, id: frameId(), type: "sessions", ...sessions() });
  };
  /** agent_up ids awaiting the hub's answer, to their agent_ref and the kind sent; cleared with the link. */
  const upIds = new Map<string, { ref: string; kind: string }>();
  /** Agents the hub refused to register (rate_limited), each with its retry timer. */
  const limited = new Map<string, NodeJS.Timeout>();
  /** The cap each refused agent hit. */
  const caps = new Map<string, AgentCap>();
  const announceUp = (rec: AgentRecord) => {
    // A /clear handover waits for hello_ok: only then is it known whether the
    // hub takes `replaces`, and an agent_up sent without it is the
    // handover lost for good (#1582). hello_ok announces it.
    if (rec.replaces !== undefined && !hubHelloed) return false;
    const id = frameId();
    const kind = rec.kind;
    upIds.set(id, { ref: rec.ref, kind });
    const sent = hub.send({
      v: 1,
      id,
      type: "agent_up",
      agent_ref: rec.ref,
      kind,
      proposed_name: fitName(rec.proposedName, 64),
      namespace: rec.namespace,
      global: rec.global,
      // A /clear: the new ref takes over the old address and its mail (#1295).
      ...(rec.replaces !== undefined && hubMailbox
        ? { replaces: rec.replaces }
        : {}),
    });
    if (sent) rec.sentName = rec.proposedName;
    return sent;
  };
  /**
   * #1822: binds the record's proof hash on the hub, for a hub that said it
   * takes `link_bind`. Sent when the hash arrives and after each (re)register;
   * a failure (`not_registered`, a dropped link) is left to the next of those.
   */
  const sendLink = (rec: AgentRecord, only?: string) => {
    if (!hubLink || !rec.live) return;
    // A new proof sends itself; a (re)register replays all, oldest first, so
    // the newest ends as the hub's newest (#1984).
    for (const hash of only === undefined ? (rec.linkHashes ?? []) : [only])
      hub.send({
        v: 1,
        id: frameId(),
        type: "link_bind",
        agent_ref: rec.ref,
        hash,
      });
  };
  /** Never a loop: one retry after a long wait; a reconnect replays it sooner. */
  const markLimited = (ref: string, message: string) => {
    if (!limited.has(ref))
      log(`the hub refused to register ${ref}: too many agents (rate limited)`);
    caps.set(ref, capOf(message));
    clearTimeout(limited.get(ref));
    const timer = setTimeout(() => {
      const rec = agents.byRef(ref);
      if (rec?.live && hub.open) announceUp(rec);
    }, deps.limitedRetryMs ?? LIMITED_RETRY_MS);
    timer.unref();
    limited.set(ref, timer);
  };
  const clearLimited = (ref: string) => {
    clearTimeout(limited.get(ref));
    limited.delete(ref);
    caps.delete(ref);
  };

  const configIssues = new ConfigIssues();
  /** Config files refused or noted (#1527): `.oa-bus.json` files seen, and the allowlist. */
  const configFiles = (cwd?: string, pending = false) => {
    const g = inspectGlobal();
    const a = inspectApprovals();
    const rm = inspectRemotes(remotesFile());
    let within: Set<string> | undefined;
    // An agent sees only its own folder chain: other projects' paths stay private.
    if (cwd !== undefined) {
      try {
        within = new Set(configPaths(realpathSync(cwd)));
      } catch {
        within = new Set(configPaths(cwd));
      }
      // #1570: the held remote change sits at the repo's .git; the agent being held sees it.
      const rr = gitRecordRoot(cwd);
      if (rr) within.add(join(rr, ".git"));
    }
    return [
      ...configIssues.list(within, { pending }),
      ...(a ? [a] : []),
      ...(rm ? [rm] : []),
      ...(g ? [g] : []),
    ];
  };
  const resolveNs = (cwd: string, allowMissing: boolean) =>
    (
      deps.resolveNamespace ??
      ((dir) =>
        resolveNamespace(dir, {
          log,
          allowMissing,
          issues: configIssues,
          remotesFile: remotesFile(),
        }))
    )(cwd);

  const cl = deps.claude ?? {};
  const listenPath = deps.socketPath ?? socketPath();
  const returnDir = cl.socketsDir ?? claudeReturnDir();
  // Before anything listens: a socket path that cannot work is a lasting failure.
  prepareSocketDir(listenPath, returnDir);
  const startOfPid = cl.procStart ?? claudeProcStartOf;
  const running = cl.isRunning ?? isRunning;
  const claudeSessions = {
    dir: cl.sessionsDir ?? claudeSessionsDir(),
    procStart: cachedProcStart(cl.procStart ?? claudeProcStartOf, running),
    isRunning: running,
  };
  /**
   * #2050: proof hashes of live Claude sessions, kept across a restart. `saved`
   * holds entries no record has claimed yet; a pid + procStart that no longer
   * runs is dropped.
   */
  const linksFile = cl.linksFile ?? join(home(), "claude-links.json");
  const sameProc = (pid: number, procStart: string) =>
    running(pid) && claudeSessions.procStart(pid, procStart) === procStart;
  let saved: ClaudeLink[] = readClaudeLinks(linksFile, undefined, log).filter(
    (e) => sameProc(e.pid, e.procStart),
  );
  let linksWritten: string | undefined = JSON.stringify(saved);
  const seedLinks = (rec: AgentRecord) => {
    if (rec.linkHashes !== undefined || rec.pid === undefined) return;
    const hit = saved.find(
      (e) => e.pid === rec.pid && e.procStart === rec.procStart,
    );
    if (!hit) return;
    rec.linkHashes = [...hit.hashes];
    saved = saved.filter((e) => e !== hit);
  };
  const persistLinks = () => {
    const rows: ClaudeLink[] = [];
    for (const a of agents.all()) {
      if (
        a.kind !== "claude-code" ||
        !a.live ||
        a.pid === undefined ||
        a.procStart === undefined ||
        !a.linkHashes?.length
      )
        continue;
      rows.push({ pid: a.pid, procStart: a.procStart, hashes: a.linkHashes });
    }
    saved = saved.filter((e) => sameProc(e.pid, e.procStart));
    const all = [...rows, ...saved].slice(0, CLAUDE_LINKS_MAX);
    const text = JSON.stringify(all);
    if (text === linksWritten) return;
    try {
      writeClaudeLinks(linksFile, all);
      linksWritten = text;
    } catch (e) {
      log(`could not save ${linksFile}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const oc = deps.opencode ?? {};
  const ocRunning = oc.isRunning ?? isRunning;
  // OpenCode's file does not change when its pid is reused: keep the short TTL (few sessions).
  const ocStart = cachedProcStart(oc.procStart ?? procStartOf, ocRunning, {
    ttlMs: cl.syncMs ?? 2000,
    jitter: 0,
  });
  const cx = deps.codex ?? {};
  /** One per daemon: it pins each Codex process's start and the call ids used. */
  /** Hellos admitted from a proxied call (#1856): link_proof only. */
  const linkOnly = new WeakSet<object>();
  const codexCheck = codexAttestor({
    // #1856: the proxied instance entry's calls are attested as the adapter's are.
    namespaces: () => codexProxyNamespaces(home()),
    ...cx,
  });
  /** Lock proofs run lsof (about 50-100 ms each), so not on every sync. */
  const relockEvery = cx.relockEvery ?? 15;
  let codexTicks = 0;
  /** Each OpenCode record's service start time, taken at hello: a reused pid is not that service. */
  const ocServiceStart = new Map<string, string | null>();
  const ocComm = oc.comm ?? commOf;
  const ocServiceGone = (ref: string, pid: number) => {
    if (!ocRunning(pid)) return true;
    const comm = ocComm(pid);
    if (comm !== null && basename(comm) !== "opencode") return true;
    // Gone needs positive evidence: a start time that cannot be read is unknown.
    const start = ocServiceStart.get(ref);
    if (start == null) return false;
    const now = ocStart(pid);
    return now !== null && now !== start;
  };
  const presenceDir = oc.presenceDir ?? opencodePresenceDir();
  /** Read on every delivery, hello and tick: the TUI decides, not the adapter's connection. */
  const openCodeSessions =
    oc.openSessions ??
    (() =>
      openSessions(presenceDir, {
        isRunning: ocRunning,
        procStartEpoch: (pid, stamp) => lstartEpoch(ocStart(pid, stamp)),
      }));
  const ocAttached = cachedAttach(
    oc.attach ?? defaultAttachDeps,
    deps.bindingNow,
  );
  /** A hello counts only sessions in TUIs attached to its own service (#1950). */
  const openCodeStateFor = (service: number, ref: string): boolean | null =>
    oc.openSessions
      ? oc.openSessions().has(ref)
      : openState(
          presenceDir,
          {
            isRunning: ocRunning,
            procStartEpoch: (pid, stamp) => lstartEpoch(ocStart(pid, stamp)),
            accept: ocAttached(service),
          },
          ref,
        );
  /** Only a definite yes counts: unknown (a failed OS read) is refused. */
  const openCodeSessionsFor = (service: number, ref: string): Set<string> =>
    openCodeStateFor(service, ref) === true ? new Set([ref]) : new Set();
  const ocSpawn = oc.spawn ?? execSpawn(20_000);
  /** Unknown until read, just before the hub link starts: no delivery comes sooner. */
  let promptIdSupported = false;
  const opencode = new OpenCodeTransport({
    openSessions: openCodeSessions,
    spawn: ocSpawn,
    log,
    promptIdSupported: () => promptIdSupported,
    uncertain: new HeldStore(
      oc.uncertainFile ?? join(home(), "opencode-uncertain.json"),
    ),
  });
  /** Where Codex keeps its thread names (#1748). */
  const codexIndexHome = cx.home ?? codexHome();
  /** Queued Codex mail a turn has not taken yet (#2029): acked late, once it has. */
  const codexTaken = new TakenWatch({
    home: codexIndexHome,
    file: cx.takenFile ?? join(home(), "codex-pending.json"),
    onTaken: (id, unsent) => delivery.delivered(id, unsent),
    log,
  });
  const codex = new CodexTransport({
    resolve:
      cx.resolveBin ??
      (() =>
        resolveCodexBin({
          configFile: codexBinFile(home()),
          path: process.env.PATH,
        })),
    run: cx.run ?? execCodex(),
    home: codexIndexHome,
    wakes: cx.wakes ?? codexHostWakes,
    taken: codexTaken,
    log,
    event: ev,
  });
  const pi = new PiTransport({
    push: (ref, frame) => {
      const push = [...(piLinks.get(ref)?.values() ?? [])].at(-1);
      if (!push) return false;
      push(frame);
      return true;
    },
    ackTimeoutMs: deps.pi?.ackTimeoutMs,
  });
  const sent = new SentStore(deps.sentFile ?? join(home(), "sent.json"), {
    log,
  });
  const receipts = new Receipts(sent, { after: deps.deliveredTimer });
  /** Sends the hub has not answered; one whose link drops goes again, same id. */
  /** A send given up on after its link dropped: the hub may have taken it, so never "not sent". */
  const lose = (f: SendFrame) => {
    hub.cancel(f.id);
    const text = stripTerminalControls(
      unconfirmedText(f.to_name, excerptOf(f.body)),
    );
    // A call still open shows the copy as-is: not an error, no prefix.
    const answered = pending.reply(f.id, {
      type: "receipt",
      msg_id: f.id,
      state: "pending",
      held: true,
      text,
    });
    if (answered) receipts.forget(f.id);
    else tell(receipts.lost(f.id));
  };
  const resends = new Resends({
    send: (f, unsent) => hub.send(f, unsent),
    expire: lose,
    windowMs: deps.resendWindowMs,
    // An overdue resend gets as long as a tool call would wait for it.
    graceMs: deps.pendingTimeoutMs,
    after: deps.resendTimer,
    now: deps.resendNow,
    log,
  });
  /** Every send is remembered, so its sender hears if it later expires or is refused. */
  const sendToHub = (
    f: ClientFrame,
    native = false,
    onUnsent?: () => void,
  ): boolean => {
    if (f.type !== "send") return hub.send(f, onUnsent);
    // Its sender is not announced yet (#1582): kept, in order, until hello_ok.
    if (held(f.from_ref)) {
      outbox.push({ frame: f, native });
      return true;
    }
    const from = agents.byRef(f.from_ref);
    // Named, not implied: a resend is judged in the namespace the send was
    // made in, even if the sender has moved since. An explicit own namespace
    // counts as absent at the hub (B14), so dedupe is unaffected.
    if (f.to_namespace === undefined && from && !from.global)
      f = { ...f, to_namespace: from.namespace };
    receipts.sending(
      f,
      f.to_namespace ?? from?.namespace,
      native,
      from?.busName,
    );
    resends.track(f, native);
    // Never written: its keeper (the Outbox) sends it again, so no resend.
    const ok = hub.send(
      f,
      onUnsent &&
        (() => {
          resends.untrack(f.id);
          onUnsent();
        }),
    );
    if (!ok) resends.untrack(f.id);
    return ok;
  };
  const notifiers: Partial<Record<AgentRecord["kind"], NotifyFn>> = {
    "claude-code": (agent, text) => claude.notify(agent, text),
    opencode: (agent, text, msgId) => opencode.notify(agent, text, msgId),
    pi: (agent, text, msgId) => pi.notify(agent, text, msgId),
    omp: (agent, text, msgId) => pi.notify(agent, text, msgId),
    hermes: (agent, text, msgId) => pi.notify(agent, text, msgId),
    openclaw: (agent, text, msgId) => pi.notify(agent, text, msgId),
    codex: (agent, text, msgId) => codex.notify(agent, text, msgId),
    ...deps.notifiers,
  };
  /** msg_ids whose notice is being injected right now: never told twice at once. */
  const telling = new Set<string>();
  /** A notice for a sender that is not live stays stored until it is (or the TTL ends). */
  const tell = (n: Notice | undefined) => {
    if (!n || telling.has(n.msgId)) return;
    const agent = agents.byRef(n.meta.from_ref);
    const fn = agent?.live ? notifiers[agent.kind] : undefined;
    if (!agent || !fn) return;
    telling.add(n.msgId);
    void fn(
      agent,
      stripTerminalControls(
        n.state === "lost"
          ? unconfirmedText(n.meta.to_name, n.meta.excerpt)
          : n.state === "corrected"
            ? correctedDeliveredText(n.meta.to_name, n.meta.excerpt)
            : receiptText(n, n.meta.to_name, undefined, n.meta.excerpt),
      ),
      n.msgId,
    )
      .then(
        (ok) => {
          if (ok) receipts.told(n.msgId, n.state === "corrected");
          else {
            if (n.state !== "corrected") receipts.notTold(n.msgId);
            log(`could not tell ${agent.busName} about ${n.meta.to_name}`);
          }
        },
        (e: unknown) => {
          if (n.state !== "corrected") receipts.notTold(n.msgId);
          log(`notice failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      )
      .finally(() => {
        telling.delete(n.msgId);
        // A correction that came while this notice was in flight goes after it.
        if (n.state !== "corrected") {
          const next = receipts.notice(n.msgId);
          if (next?.state === "corrected") tell(next);
        }
      });
  };
  const tellOwed = (ref: string) => {
    for (const n of receipts.owed(ref)) tell(n);
  };

  /**
   * A Claude reply, queued with the agent it answers: `to_id` is added when it
   * is sent, from what the hub then says it supports (hubIds), never frozen
   * at queue time.
   */
  type QueuedReply = {
    frame: SendFrame;
    peerId?: string;
    native?: boolean;
    /** From a revived socket that did not know who wrote: refused if the hub names writers. */
    unnamed?: boolean;
  };
  const withTo = (r: QueuedReply): SendFrame =>
    hubIds && r.peerId ? { ...r.frame, to_id: r.peerId } : r.frame;
  // A Claude reply must not be lost to a hub reconnect. It waits for the
  // link's hello_ok, so it knows whether the hub takes to_id.
  const outbox = new Outbox<QueuedReply>({
    send: (r, unsent) => {
      if (!hub.open || hubVersion === undefined || held(r.frame.from_ref))
        return false;
      // Revived without its writer's id, to a hub that names writers: the name
      // may now belong to another agent, so refuse and tell the session.
      if (r.unnamed && hubIds) {
        const agent = agents.byRef(r.frame.from_ref);
        if (agent) void claude.notify(agent, replyGoneText(r.frame.to_name));
        return true;
      }
      return sendToHub(withTo(r), r.native ?? true, unsent);
    },
    stale: (r) => !agents.byRef(r.frame.from_ref)?.live,
    log,
  });
  const claude = new ClaudeTransport({
    socketsDir: returnDir,
    // A deps.socketsDir is the caller's (tests); ours is re-checked before each bind.
    prepareDir: cl.socketsDir ? undefined : (d) => prepareReturnDir(d),
    heldFile: cl.heldFile ?? join(home(), "claude-held.json"),
    returnIndexFile:
      cl.returnIndexFile ??
      (cl.heldFile
        ? cl.heldFile.replace(/(\.json)?$/, ".return.json")
        : join(home(), "claude-return.json")),
    statusWindowMs: cl.statusWindowMs,
    injectTimeoutMs: cl.injectTimeoutMs,
    log,
    target: (ref) => claudeTarget(ref, claudeSessions),
    state: (a) => claudeTargetState(a.ref, a.pid, claudeSessions),
    // A native reply is a message from the session: the sink names the sender, never the frame.
    // Every reply names the peer's namespace (the deliver's), so a same-named local peer cannot get it.
    onReply: (agentRef, peerName, text, namespace, peerId, unnamed) => {
      // A lone surrogate costs one character, not the reply.
      if (!isWellFormed(text))
        log(
          `a Claude reply to ${peerName} was not well-formed unicode; sent with U+FFFD`,
        );
      const body = (text as string & { toWellFormed(): string }).toWellFormed();
      const f: SendFrame = {
        v: 1,
        id: frameId(),
        type: "send",
        from_ref: agentRef,
        to_name: peerName,
        to_namespace: namespace,
        body,
      };
      if (!ClientFrameSchema.safeParse(f).success) {
        log(`dropped a Claude reply to ${peerName}: not valid on the hub wire`);
        return;
      }
      // Only the agent that wrote, never whoever holds the name now: to_id
      // is added at send time (withTo).
      outbox.push({
        frame: f,
        ...(peerId ? { peerId } : {}),
        ...(unnamed ? { unnamed } : {}),
      });
    },
    // A reply the daemon would not send: the session is told, as information.
    onReplyRefused: (agentRef, peerName) => {
      const agent = agents.byRef(agentRef);
      if (agent) void claude.notify(agent, replyGoneText(peerName));
    },
  });

  /**
   * A /clear (#1295): the Claude agent that ran in process `pid` under
   * another ref, which that process no longer reports. It may already be
   * closed: a tick that could not read the session file mid-rewrite closes
   * it first, and the hub then holds its address as `away`. The same pid and
   * process start is the same process; any other session is another agent.
   */
  const clearedFrom = (
    ref: string,
    pid: number,
    procStart: string | undefined,
    liveRefs: Set<string>,
  ): AgentRecord | undefined =>
    agents
      .all()
      .filter(
        (a) =>
          a.kind === "claude-code" &&
          a.pid === pid &&
          procStart !== undefined &&
          a.procStart === procStart &&
          a.ref !== ref &&
          !liveRefs.has(a.ref) &&
          !takenOver.has(a.ref),
      )
      // The live one, else the one this process reported last: after A, B, C
      // the third replaces B, never A (A's address is B's by then).
      .sort(
        (a, b) =>
          Number(b.live) - Number(a.live) ||
          (seenAt.get(b.ref) ?? 0) - (seenAt.get(a.ref) ?? 0),
      )[0];
  /** Sessions whose address a later session of the same process took over. */
  const takenOver = new Set<string>();
  /** Order in which this process's sessions were last seen (higher is later). */
  const seenAt = new Map<string, number>();
  const REOPEN_SAME_PROC_MS = 30_000;
  const reopenedAt = new Map<string, number>();
  const unknownSince = new Map<string, number>();
  const UNKNOWN_GRACE_MS = cl.unknownGraceMs ?? 600_000;
  let seenSeq = 0;

  /** rename ids awaiting the hub's answer, to their agent_ref; cleared with the link. */
  const renameIds = new Map<string, { ref: string; prevSent?: string }>();
  /** When each ref's recent `rename` frames went (a sliding window). */
  const renameFrames = new Map<string, number[]>();
  /** After the hub's rate_limited on a rename: no rename for that ref until this time. */
  const renameHeldUntil = new Map<string, number>();
  /**
   * A Claude `/rename` after connect (#1635): the session file's name changed
   * since the last tick. One `rename` per change; the hub's answer (a `-2`,
   * a refusal) is never read as a change, so nothing loops. A name noted
   * while the link or the agent's registration is not ready rides the next
   * agent_up (it carries proposedName).
   */
  const renameIfChanged = (rec: AgentRecord, name: string, filePid: number) => {
    const was = rec.sessionName ?? rec.proposedName;
    // Never a name nobody chose: empty, or the file's own `claude-<pid>`
    // fallback (a file with no name, whichever process wrote it).
    if (name === "" || name === `claude-${filePid}`) return;
    rec.sessionName = name;
    if (name === was) {
      // A change held back (the hub's hour, a failed send) goes when it can.
      if (rec.sentName !== rec.proposedName) flushRename(rec);
      return;
    }
    rec.proposedName = name;
    flushRename(rec);
  };
  /**
   * A Pi or omp session renamed (#1635), told by its extension on `rename` or
   * by a reconnecting hello. The same rules as Claude: one frame per change,
   * never an empty name or the kind the extension falls back to.
   */
  const renameFromAdapter = (rec: AgentRecord, name: string) => {
    const was = rec.sessionName ?? rec.proposedName;
    rec.sessionName = name;
    if (name === was || name === "" || name === rec.kind) return;
    rec.proposedName = name;
    flushRename(rec);
  };
  /**
   * Tells the hub a name it has not heard, once the agent is registered on a
   * helloed link. Called on each change, and again after hello_ok and agent_ok
   * for a change noted while the link or a handover was not ready.
   */
  const flushRename = (rec: AgentRecord) => {
    if (
      !(
        rec.kind === "claude-code" ||
        rec.kind === "pi" ||
        rec.kind === "omp" ||
        rec.kind === "codex"
      ) ||
      !rec.live ||
      rec.sentName === undefined ||
      rec.sentName === rec.proposedName ||
      !hub.open ||
      !hubHelloed ||
      rec.replaces !== undefined ||
      limited.has(rec.ref)
    )
      return;
    // The hub's hourly cap answered: nothing more for this ref until the hour is out.
    if (Date.now() < (renameHeldUntil.get(rec.ref) ?? 0)) return;
    // At most 3 frames per ref per minute: past that the latest name waits
    // for the window to end (the next tick retries), so a flip cannot loop.
    const now = Date.now();
    const recent = (renameFrames.get(rec.ref) ?? []).filter(
      (t) => now - t < RENAME_WINDOW_MS,
    );
    renameFrames.set(rec.ref, recent);
    if (recent.length >= RENAME_WINDOW_MAX) return;
    const id = frameId();
    renameIds.set(id, { ref: rec.ref, prevSent: rec.sentName });
    if (
      hub.send({
        v: 1,
        id,
        type: "rename",
        agent_ref: rec.ref,
        proposed_name: fitName(rec.proposedName, 64),
        name_kind: "chosen",
      })
    ) {
      rec.sentName = rec.proposedName;
      recent.push(now);
    } else renameIds.delete(id);
  };
  /**
   * #1822: a proof can arrive before the daemon has a record for its pid (the
   * helper runs once, at /mcp connect, while the session file may still be
   * unwritten). The latest hash per pid and start time waits here, briefly and
   * bounded; a live record with that pid and start time takes it.
   */
  const pendingProofs = new Map<
    number,
    { procStart: string; hash: string; at: number }
  >();
  const claimProofs = () => {
    if (pendingProofs.size === 0) return;
    const now = Date.now();
    for (const [pid, p] of pendingProofs)
      if (now - p.at > PENDING_PROOF_MS) pendingProofs.delete(pid);
    for (const rec of agents.all()) {
      if (rec.kind !== "claude-code" || !rec.live || rec.pid === undefined)
        continue;
      const p = pendingProofs.get(rec.pid);
      if (!p || p.procStart !== rec.procStart) continue;
      pendingProofs.delete(rec.pid);
      rec.linkHashes = withLinkHash(rec.linkHashes, p.hash);
      persistLinks();
      sendLink(rec, p.hash);
    }
  };
  /**
   * A Codex `/rename` (#1748): the thread's name in Codex's session index
   * changed. The same rules as Pi: one frame per change, a thread with no name
   * stays as it was. Reads the index only while a Codex thread is live.
   */
  const renameCodexThreads = () => {
    const live = agents.all().filter((a) => a.kind === "codex" && a.live);
    if (!live.length) return;
    const names = codexThreadNames(codexIndexHome);
    for (const rec of live) {
      const name = names.get(rec.ref);
      if (name !== undefined) renameFromAdapter(rec, name);
    }
  };
  /** Claude sessions exist before they call a tool: the daemon announces them from their session files. */
  const syncClaude = () => {
    const scan = liveClaudeScan(
      claudeSessions,
      (ref) => agents.byRef(ref)?.pid,
    );
    const now = Date.now();
    // #2110: a running session whose start time or file cannot be read is
    // unknown and stays live, for at most UNKNOWN_GRACE_MS of consecutive
    // unknowns; then it is treated as gone.
    const unknownNow = new Set<string>();
    const live = scan.live.filter((s) => {
      if (!s.unknown) return true;
      unknownNow.add(s.ref);
      const since = unknownSince.get(s.ref) ?? now;
      unknownSince.set(s.ref, since);
      return now - since <= UNKNOWN_GRACE_MS;
    });
    const liveRefs = new Set(live.map((s) => s.ref));
    const livePid = (ref: string, pid: number) =>
      live.some((s) => s.ref === ref && s.pid === pid);
    for (const s of live) {
      const prev = agents.byRef(s.ref);
      if (prev && prev.kind !== "claude-code") continue;
      // Admitted before its session file existed: learn the process start
      // now (live or already closed by a tick that could not see the file),
      // so a later /clear in this process is recognised (#1295).
      if (prev && prev.procStart === undefined && prev.pid === s.pid)
        prev.procStart = s.procStart;
      if (prev?.live) {
        // `claude --resume` brings the same session back under a new pid; while
        // the current one still runs it stays, so two files never flap.
        if (!livePid(s.ref, prev.pid)) {
          prev.pid = s.pid;
          prev.procStart = s.procStart;
        }
        renameIfChanged(prev, s.name, s.pid);
        continue;
      }
      // #2110: a record closed while its process and session file are still
      // there (a missed read, a failed delivery) reopens when seen again: the
      // up below replays its link hashes. A different process under the ref is
      // the /resume case, handled the same way. The same process reopens at
      // most once per REOPEN_SAME_PROC_MS, so a session that really refuses
      // deliveries does not flap.
      if (prev && prev.pid === s.pid && prev.procStart === s.procStart) {
        // A delivery refusal stays closed until a hello or a new process.
        if (prev.closedBy !== "liveness") continue;
        const last = reopenedAt.get(s.ref);
        if (last !== undefined && Date.now() - last < REOPEN_SAME_PROC_MS)
          continue;
        reopenedAt.set(s.ref, Date.now());
      }
      if (!isAbsolute(s.cwd)) continue;
      let ns: Namespace;
      try {
        ns = resolveNs(s.cwd, true);
      } catch {
        continue;
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success) continue;
      // /clear: the same process, a new session id. The new ref keeps the
      // old one's address (#1295); the old one is closed below.
      seenAt.set(s.ref, ++seenSeq);
      // A ref this daemon already knows (a /resume) is no takeover.
      const old = prev
        ? undefined
        : clearedFrom(s.ref, s.pid, s.procStart, liveRefs);
      if (old) takenOver.add(old.ref);
      const rec = agents.up({
        ...(old ? { replaces: handoverOf(old) } : {}),
        ref: s.ref,
        kind: "claude-code",
        proposedName: old?.busName ?? s.name,
        busName: prev?.busName ?? old?.busName ?? s.name,
        namespace: ns.namespace,
        namespaceSource: ns.source,
        global: ns.global,
        pid: s.pid,
        procStart: s.procStart,
        // The same process keeps its proof across /clear and a reopen; agent_ok rebinds it.
        ...((prev?.linkHashes ?? old?.linkHashes) !== undefined
          ? { linkHashes: (prev?.linkHashes ?? old?.linkHashes) as string[] }
          : {}),
        sessionName: s.name,
        cwd: s.cwd,
        live: true,
      });
      // Found by the sync, not by a hello: its join is logged here, once per record.
      ev("agent_join", { ...agentFields(rec), state: "synced" });
      announceUp(rec);
      seedLinks(rec);
      // Its return sockets from before a restart answer again (open-bus #426).
      void claude.revive(s.ref);
      tellOwed(s.ref);
    }
    claimProofs();
    let closed = false;
    for (const a of agents.all()) {
      if (a.kind !== "claude-code" || !a.live || liveRefs.has(a.ref)) continue;
      // #2110: an unreadable session file of a running process is unknown, not
      // gone: keep it live, for at most UNKNOWN_GRACE_MS of consecutive
      // unknowns. Otherwise only positive evidence closes (pid not running, a
      // different start time, the file removed).
      if (scan.unreadable.has(a.pid) && claudeSessions.isRunning(a.pid)) {
        unknownNow.add(a.ref);
        const since = unknownSince.get(a.ref) ?? now;
        unknownSince.set(a.ref, since);
        if (now - since <= UNKNOWN_GRACE_MS) continue;
      }
      a.live = false;
      a.closedBy = "liveness";
      closed = true;
      ev("agent_leave", agentFields(a, "session_gone"));
      void claude.drop(a.ref);
    }
    // Consecutive unknowns only; a reopen stamp is dropped once it has expired.
    for (const r of [...unknownSince.keys()])
      if (!unknownNow.has(r)) unknownSince.delete(r);
    for (const [r, at] of reopenedAt)
      if (now - at >= REOPEN_SAME_PROC_MS) reopenedAt.delete(r);
    persistLinks();
    if (closed) announceSessions();
  };

  /** Open at the last tick: a session reopens only when a TUI newly lists it. */
  let openBefore = new Set<string>();
  /**
   * An OpenCode session becomes an agent at its first tool call, which names
   * its directory; presence then decides whether it is live.
   */
  const syncOpenCode = () => {
    const open = openCodeSessions();
    let closed = false;
    for (const a of agents.all()) {
      if (a.kind !== "opencode") continue;
      if (a.live && !open.has(a.ref)) {
        a.live = false;
        closed = true;
        ev("agent_leave", agentFields(a, "not_listed"));
      } else if (!a.live && open.has(a.ref) && !openBefore.has(a.ref)) {
        // Closed by a failed delivery while still listed stays closed until relisted.
        a.live = true;
        announceUp(a);
        tellOwed(a.ref);
      }
    }
    openBefore = open;
    if (closed) announceSessions();
  };

  const delivery = createDeliver({
    agents,
    ...(cl.retryDelaysMs ? { retryDelaysMs: cl.retryDelaysMs } : {}),
    hub: { send: (f, unsent) => hub.send(f, unsent) },
    transports: {
      "claude-code": (agent, mail) => claude.deliver(agent, mail),
      opencode: (agent, mail) => opencode.deliver(agent, mail),
      pi: (agent, mail) => pi.deliver(agent, mail),
      omp: (agent, mail) => pi.deliver(agent, mail),
      hermes: (agent, mail) => pi.deliver(agent, mail),
      openclaw: (agent, mail) => pi.deliver(agent, mail),
      codex: (agent, mail) => codex.deliver(agent, mail),
      ...deps.transports,
    },
    onClosed: (a, closedBy) => {
      // Never downgrade a liveness close (the sync's or a concurrent
      // delivery's) to a delivery refusal.
      if (a.closedBy !== "liveness") a.closedBy = closedBy ?? "delivery";
      ev("agent_leave", agentFields(a, "delivery_closed"));
      announceSessions();
      return a.closedBy;
    },
    log,
  });

  let hubEver = false;
  let hubDroppedAt: number | undefined;
  /** The hub's last hello_ok listed BUS_CAPS.ids: a reply may carry to_id. */
  let hubIds = false;
  /** The hub's last hello_ok listed BUS_CAPS.mailbox: agent_up may carry `replaces`. */
  let hubMailbox = false;
  /** The hub's last hello_ok listed BUS_CAPS.follow: follow frames may go (#1317). */
  let hubFollow = false;
  /** The hub's last hello_ok listed BUS_CAPS.link: link_bind may go (#1822). */
  let hubLink = false;
  /** The hub's last hello_ok listed BUS_CAPS.linkArg: its /mcp strips the proof argument (#1856). */
  let hubLinkArg = false;
  /** This link has had its hello_ok (reset when the link drops). */
  let hubHelloed = false;
  /** Which link's hello_ok started the current Codex ack replay (#2198). */
  let codexReplayLink = 0;
  /** The hub's version from its last hello_ok: status says when it is newer (C26h). */
  let hubVersion: string | undefined;
  /** The hub's last hello_ok listed BUS_CAPS.waiting: away roster rows carry `waiting` (#2029). */
  let hubWaiting = false;
  /** The hub's last hello_ok listed BUS_CAPS.waitingQuery: it counts waiting mail by this machine's own away refs (#2079). */
  let hubWaitingQuery = false;
  /** In-flight waiting_query frames by id. */
  const waitingAsks = new Map<
    string,
    (counts: Record<string, number> | undefined) => void
  >();
  const hub = new HubConnection({
    url: `${cfg.hub.replace(/^http/, "ws").replace(/\/+$/, "")}${BUS_ROUTES.connect}`,
    token: cfg.machine_token,
    label: cfg.label,
    version: deps.version ?? process.env.OA_BUS_VERSION ?? "0.0.0",
    sessions,
    log,
    ...deps.hub,
    onFrame: (frame) => {
      switch (frame.type) {
        case "deliver":
          void delivery.deliver(frame);
          return;
        case "agent_ok": {
          upIds.delete(frame.id);
          clearLimited(frame.agent_ref);
          const agent = agents.byRef(frame.agent_ref);
          if (agent) {
            agent.busName = frame.bus_name;
            // Answered: the hub knows the new ref, the handover is done.
            delete agent.replaces;
            flushRename(agent);
            // The hub forgot the hash with the last link: say it again.
            sendLink(agent);
          }
          // Registered on this link: its sends lost to the last one go again.
          resends.up(frame.agent_ref);
          return;
        }
        case "renamed": {
          renameIds.delete(frame.id);
          const agent = agents.byRef(frame.agent_ref);
          if (agent) agent.busName = frame.bus_name;
          return;
        }
        case "receipt": {
          resends.untrack(frame.id);
          // A tool call's queued send waits a moment for delivered (or a refusal or expiry).
          // No call waits: a held send whose call was answered Queued.
          const ended = !pending.has(frame.id);
          const answer =
            frame.state === "pending" ? pending.hold(frame.id) : undefined;
          tell(receipts.receipt(frame, answer !== undefined, ended));
          if (!answer) {
            pending.settle(frame);
            return;
          }
          void receipts
            .final(frame.msg_id, deps.deliveredWaitMs ?? DELIVERED_WAIT_MS)
            .then((f) => {
              const written = answer(
                f
                  ? {
                      v: 1,
                      id: frame.id,
                      type: "receipt",
                      msg_id: f.msg_id,
                      state: f.state,
                      ...(f.reason ? { reason: f.reason } : {}),
                    }
                  : frame,
              );
              if (f?.state !== "refused" && f?.state !== "expired") return;
              // The tool call went away (cancelled, disconnected): a notice tells it instead.
              if (written) receipts.told(f.msg_id);
              else tell(receipts.notice(f.msg_id));
            });
          return;
        }
        case "receipt_update":
          tell(receipts.update(frame, telling.has(frame.msg_id)));
          return;
        case "error": {
          if (statusRelay.answer(frame)) return;
          if (waitingAsks.has(frame.id)) {
            waitingAsks.get(frame.id)?.(undefined);
            return;
          }
          const renamed = renameIds.get(frame.id);
          if (renamed !== undefined) {
            const renamedRef = renamed.ref;
            renameIds.delete(frame.id);
            if (frame.code === "rate_limited") {
              renameHeldUntil.set(renamedRef, Date.now() + RENAME_HOLD_MS);
              // Refused, not told: the same name goes once the hold is out.
              const a = agents.byRef(renamedRef);
              if (a) a.sentName = renamed.prevSent;
            }
            log(
              `the hub did not rename ${renamedRef} to its session name: ${frame.code} ${frame.message}`,
            );
            return;
          }
          const up = upIds.get(frame.id);
          upIds.delete(frame.id);
          if (up !== undefined) {
            const upRef = up.ref;
            if (frame.code === "rate_limited")
              markLimited(upRef, frame.message);
            else log(`the hub refused to register ${upRef}: ${frame.code}`);
            return;
          }
          // A resend the hub is too busy for goes again within its window.
          if (frame.code === "rate_limited" && resends.limited(frame.id))
            return;
          // Never sent changed under its id; a hub that says so is wrong, and the send is lost.
          const resent = resends.held(frame.id) && resends.frame(frame.id);
          if (frame.code === "bad_frame" && resent) {
            log(`the hub refused a resend (${frame.id}): ${frame.message}`);
            resends.untrack(frame.id);
            lose(resent);
            return;
          }
          resends.untrack(frame.id);
          // An error answers one request by id; an unmatched one is dropped.
          receipts.forget(frame.id);
          pending.settle(frame);
          return;
        }
        case "roster":
        case "followed":
        case "unfollowed":
        case "follows":
          pending.settle(frame);
          return;
        case "link_bound":
          return;
        case "waiting_counts":
          waitingAsks.get(frame.id)?.(frame.counts);
          return;
        case "body":
          // A fetched body is a peer's text, like a delivered one.
          pending.settle({ ...frame, body: stripTerminalControls(frame.body) });
          return;
        case "hello_ok":
          // The machine id and label are already in machine.json.
          hubVersion = frame.server_version;
          // A reply names its agent (to_id) only to a hub that said it can.
          hubIds = frame.caps?.includes(BUS_CAPS.ids) ?? false;
          hubMailbox = frame.caps?.includes(BUS_CAPS.mailbox) ?? false;
          hubFollow = frame.caps?.includes(BUS_CAPS.follow) ?? false;
          hubWaiting = frame.caps?.includes(BUS_CAPS.waiting) ?? false;
          hubWaitingQuery =
            frame.caps?.includes(BUS_CAPS.waitingQuery) ?? false;
          hubLink = frame.caps?.includes(BUS_CAPS.link) ?? false;
          hubLinkArg = frame.caps?.includes(BUS_CAPS.linkArg) ?? false;
          hubHelloed = true;
          // Handovers that waited for this: announce them now (#1582).
          for (const rec of agents.all())
            if (rec.live && rec.replaces !== undefined) announceUp(rec);
          for (const rec of agents.all()) flushRename(rec);
          // Queued replies go now that the link says what it supports.
          outbox.flush();
          // Every Codex ack still owed is sent again on each new link: a saved
          // `acked` only meant queued locally (#2198). Paced, bounded, idempotent.
          {
            const link = ++codexReplayLink;
            replayInBatches(
              codexTaken.takenIds(),
              (id) => void delivery.delivered(id),
              () => hubHelloed && link === codexReplayLink,
            );
          }
          return;
        // roster_changed has no local consumer yet (C6).
      }
    },
    onBadFrame: (id, error) => {
      resends.untrack(id);
      receipts.forget(id);
      pending.fail(id, error, "the hub sent a frame this daemon cannot read");
    },
    onRevoked: () => {
      // `login` saved a newer token since this daemon started: only the old one was revoked.
      const saved = savedToken();
      if (saved !== undefined && saved !== cfg.machine_token) {
        log(
          "the hub refused the token this daemon started with; machine.json holds a newer one: restarting",
        );
        process.exitCode = 1;
        deps.onRevoked?.(true);
        return;
      }
      log(`this machine was revoked; run \`${BUS_CMD} install\``);
      process.exitCode = 1;
      try {
        writeFileSync(
          deps.revokedFile ?? join(home(), "revoked"),
          revokedMarker(cfg.machine_token),
          { mode: 0o600 },
        );
      } catch (e) {
        log(
          `could not write the revoked marker: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      deps.onRevoked?.();
    },
    // The hub forgets agents with the link; sessions went out with hello.
    onOpen: () => {
      hubEver = true;
      hubDroppedAt = undefined;
      ev("hub_connect");
      for (const rec of agents.all()) if (rec.live) announceUp(rec);
      // Queued replies wait for hello_ok (to_id depends on it).
    },
    onClose: () => {
      // Failed retries close too: keep the first drop of this outage.
      if (hubEver) hubDroppedAt ??= Date.now();
      ev("hub_disconnect");
      upIds.clear();
      renameIds.clear();
      // The next link's hello_ok says again which hub this is.
      hubVersion = undefined;
      hubIds = false;
      // A replay before the next hello_ok must not carry `replaces`.
      hubMailbox = false;
      hubFollow = false;
      hubLink = false;
      hubLinkArg = false;
      hubWaitingQuery = false;
      hubHelloed = false;
      statusRelay.dropped();
      receipts.release();
      // A send not yet answered waits for the next link; anything else fails now.
      resends.dropped();
      pending.failAll("hub_unavailable", "the hub connection dropped", (id) =>
        resends.held(id),
      );
    },
    onDropped: (f) => {
      upIds.delete(f.id);
      resends.untrack(f.id);
      receipts.forget(f.id);
      pending.fail(f.id, "hub_unavailable", "the hub link is backed up");
    },
  });

  const version = deps.version ?? process.env.OA_BUS_VERSION ?? "0.0.0";
  const statusRelay = new AgentStatusRelay({
    send: (f, onUnsent) => hub.send(f, onUnsent),
    open: () => hub.open,
    log,
    after: deps.status?.timer,
    statusEveryMs: deps.status?.statusEveryMs,
  });
  /** The namespace roster as `ref` sees it, or undefined if the hub does not answer in time. */
  const hubRoster = (ref: string) =>
    new Promise<Extract<DaemonFrame, { type: "roster" }>["agents"] | undefined>(
      (resolve) => {
        const id = pending.open("status", (f) =>
          resolve(f.type === "roster" ? f.agents : undefined),
        );
        const timer = setTimeout(() => {
          pending.cancel(id);
          hub.cancel(id);
          resolve(undefined);
        }, deps.statusRosterMs ?? 1500);
        timer.unref();
        if (!hub.send({ v: 1, id, type: "list", from_ref: ref })) {
          clearTimeout(timer);
          pending.cancel(id);
          resolve(undefined);
        }
      },
    );
  /** #2079: pending mail for this machine's own away refs, one frame; undefined if the hub did not answer. */
  const hubWaitingCounts = (refs: string[]) =>
    new Promise<Record<string, number> | undefined>((resolve) => {
      const id = frameId();
      const done = (c: Record<string, number> | undefined) => {
        clearTimeout(timer);
        waitingAsks.delete(id);
        resolve(c);
      };
      const timer = setTimeout(() => {
        hub.cancel(id);
        done(undefined);
      }, deps.statusRosterMs ?? 1500);
      timer.unref();
      waitingAsks.set(id, done);
      if (!hub.send({ v: 1, id, type: "waiting_query", agent_refs: refs }))
        done(undefined);
    });
  // Another live daemon holds the socket, or the path cannot be bound: a restart cannot fix either.
  const socketInUse = (e: unknown): never => {
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "EADDRINUSE") throw new StartError("SOCKET_IN_USE", msg);
    if (
      code === "EINVAL" ||
      code === "ENAMETOOLONG" ||
      code === "EACCES" ||
      code === "ENOTSOCK"
    )
      throw new StartError(
        "SOCKET_PATH",
        `cannot listen on ${listenPath}: ${msg}`,
      );
    throw e;
  };
  const server = await serveDaemon({
    path: listenPath,
    // A codex hello proves one call id, so it buys one request: `hello.pid`
    // is a claim (no peer credentials), and a won race must not become a session.
    oneRequest: (h) => h.kind === "codex",
    // #1822: `oa-bus mcp-proof` names the Claude process it runs under. The pid
    // in the request is the caller's claim, not attested (no peer credentials):
    // any process of this OS user can bind. The owner accepted that. What the
    // daemon checks is that a live Claude record it attested has that very pid
    // and start time; an unknown pid binds nothing.
    onLinkProof: (req) => {
      const start = (cl.procStart ?? claudeProcStartOf)(req.pid);
      if (start === null || start === undefined) return { bound: false };
      const find = () =>
        agents
          .all()
          .find((a) => a.kind === "claude-code" && a.live && a.pid === req.pid);
      let rec = find();
      // The helper can beat the session file: look now, not at the next tick.
      if (!rec || rec.procStart === undefined) {
        syncClaude();
        rec = find();
      }
      if (rec && rec.procStart !== undefined) {
        if (rec.procStart !== start) return { bound: false };
        rec.linkHashes = withLinkHash(rec.linkHashes, req.hash);
        persistLinks();
        sendLink(rec, req.hash);
        return { bound: true };
      }
      // Still no record: hold it for the one that may appear (same pid and
      // start time only). Bounded, and a proof nobody claims expires.
      pendingProofs.delete(req.pid);
      pendingProofs.set(req.pid, {
        procStart: start,
        hash: req.hash,
        at: Date.now(),
      });
      while (pendingProofs.size > PENDING_PROOF_MAX) {
        const oldest = pendingProofs.keys().next().value;
        if (oldest === undefined) break;
        pendingProofs.delete(oldest);
      }
      return { bound: true };
    },
    // `oa-bus status` and install's "Daemon running": one roster per namespace
    // this machine's open sessions are in (or only the cwd's).
    onStatus: async (req) => {
      let only: string | undefined;
      if (req.cwd && isAbsolute(req.cwd)) {
        try {
          only = resolveNs(req.cwd, true).namespace;
        } catch {}
      }
      const live = agents.all().filter((a) => a.live);
      const names = [
        ...new Set(
          req.cwd
            ? only === undefined
              ? []
              : [only]
            : live.map((a) => a.namespace),
        ),
      ];
      const namespaces = await Promise.all(
        names.map(async (namespace) => {
          const local = live.filter((a) => a.namespace === namespace);
          const mine = new Map(local.map((a) => [a.busName, a.kind]));
          const roster =
            local[0] && hub.open ? await hubRoster(local[0].ref) : undefined;
          // #1295: away agents are closed; status lists only open ones.
          const rows = roster
            ? roster
                .filter((a) => a.state !== "away")
                .map((a) => ({
                  name: a.name,
                  kind: a.kind,
                  machine:
                    a.machine_label ??
                    (mine.get(a.name) === a.kind ? cfg.label : ""),
                  state:
                    a.state === "away"
                      ? ("queued" as const)
                      : (a.state ?? ("live" as const)),
                  ...(a.status === undefined ? {} : { status: a.status }),
                  ...(a.status_label === undefined
                    ? {}
                    : { status_label: a.status_label }),
                  ...(a.status_at === undefined
                    ? {}
                    : { status_at: a.status_at }),
                }))
            : local.map((a) => ({
                name: a.busName,
                kind: a.kind,
                machine: cfg.label,
                state: "live" as const,
              }));
          const source = local[0]?.namespaceSource;
          return {
            namespace,
            ...(source ? { source } : {}),
            agents: rows,
          };
        }),
      );
      const config_files = configFiles(
        undefined,
        req.caps?.includes(ADAPTER_CAPS.pending),
      );
      return {
        pid: process.pid,
        version,
        label: cfg.label,
        ...(config_files.length > 0 ? { config_files } : {}),
        hub: hub.open ? "connected" : "connecting",
        ...(hub.open || !hub.lastError ? {} : { hub_error: hub.lastError }),
        hub_ever: hubEver,
        ...(hub.open || !hubEver || hubDroppedAt === undefined
          ? {}
          : { hub_since: hubDroppedAt }),
        link: true,
        ...(hubVersion === undefined ? {} : { hub_version: hubVersion }),
        ...(only === undefined ? {} : { namespace: only }),
        namespaces,
        // Read-only: status never marks a late delivery shown.
        late: sent
          .lateSince(Date.now() - LATE_WINDOW_MS)
          .flatMap(({ meta, at }) => {
            const from = meta.from_name ?? agents.byRef(meta.from_ref)?.busName;
            return from
              ? [
                  {
                    from,
                    to: meta.to_name,
                    ...(meta.excerpt
                      ? { excerpt: stripTerminalControls(meta.excerpt) }
                      : {}),
                    at,
                  },
                ]
              : [];
          }),
      };
    },
    onHello: (hello, closed) => {
      /** welcome.caps (#1635): only to an adapter that listed `rename`. */
      const capsFor = (h: typeof hello) => {
        const listed = [
          ...((h.kind === "pi" || h.kind === "omp") &&
          h.caps?.includes(ADAPTER_CAPS.rename)
            ? [ADAPTER_CAPS.rename]
            : []),
          // #1317: whether the hub takes follows is answered per request.
          ...(h.caps?.includes(ADAPTER_CAPS.follow)
            ? [ADAPTER_CAPS.follow]
            : []),
          // #1346: the proposal goes to the hub over HTTP; no hub cap.
          ...(h.caps?.includes(ADAPTER_CAPS.reach) ? [ADAPTER_CAPS.reach] : []),
          // #1856: a link_proof on this connection binds only its own agent.
          ...(h.caps?.includes(ADAPTER_CAPS.link) ? [ADAPTER_CAPS.link] : []),
        ];
        return listed.length > 0 ? { caps: listed } : {};
      };
      // Only codex may leave it out: its cwd comes from the rollout (C26j).
      if (hello.cwd === undefined && hello.kind !== "codex")
        return { error: "cwd is required" };
      // One log level: off unless OA_BUS_DEBUG=1, since Claude reconnects per tool call.
      // Called once the hello is accepted, never for a rejected one.
      const attested = (pid: number) => {
        if (debug)
          log(
            `attested ${hello.kind} pid ${pid} ref ${hello.agent_ref.slice(0, 8)}`,
          );
      };
      const checked = (
        deps.attest ??
        ((h) =>
          h.kind === "codex"
            ? codexCheck.attest(h)
            : attest(h, {
                // The dir liveness reads: a session is attested where it is seen.
                sessionsDir: claudeSessions.dir,
                openSessions: openCodeSessionsFor,
                ancestors: oc.ancestors,
                comm: oc.comm,
                codex: codexCheck,
              }))
      )(hello);
      // Codex may wait once for its call to reach the rollout: the rest runs after.
      const admit = (check: Attest): HelloResult | { error: string } => {
        if (!check.ok) {
          ev(hello.kind === "codex" ? "codex_refused" : "agent_refused", {
            kind: hello.kind,
            ref: hello.agent_ref,
            reason: refusalKey(check.reason),
          });
          return { error: check.reason };
        }
        // Claude's MCP server is a new process per tool call; the session is the identity.
        const pid = check.pid ?? hello.pid;
        if (check.linkOnly) linkOnly.add(hello);
        // #1608: a pi-like ref belongs to the adapter that claimed it first, link
        // after link, until the claimant's process is gone. A pid and its start
        // time are no proof of who is speaking (any same-user process can send
        // them), so the welcome issued a token that every later hello must echo.
        let bindToken: string | undefined;
        // A binding lapses when its claimant is gone, its pid has another start time, or it sat closed too long.
        const claim = bindings.get(hello.agent_ref);
        if (claim && bindingLapsed(hello.agent_ref, claim, startOfPid))
          bindings.delete(hello.agent_ref);
        const held = bindings.get(hello.agent_ref);
        // Every kind is checked: a claude-code or opencode hello cannot take a bound pi ref.
        if (
          held &&
          (held.kind !== hello.kind ||
            !piLike(hello.kind) ||
            held.token !== hello.bind_token)
        )
          return { error: REF_BOUND };
        if (piLike(hello.kind))
          bindToken = held?.token ?? randomBytes(24).toString("base64url");
        const bound = (): { bind_token?: string } => {
          if (bindToken === undefined) return {};
          bindings.set(hello.agent_ref, {
            token: bindToken,
            pid,
            kind: hello.kind,
            ...(startOfPid(pid) ? { start: startOfPid(pid) as string } : {}),
          });
          return { bind_token: bindToken };
        };
        const prev = agents.byRef(hello.agent_ref);
        // A resumed session may beat the next sync tick: the files decide whose it is.
        if (prev?.live && prev.kind === "claude-code" && prev.pid !== pid) {
          const live = liveClaudeFiles(claudeSessions).filter(
            (s) => s.ref === prev.ref,
          );
          if (
            live.some((s) => s.pid === pid) &&
            !live.some((s) => s.pid === prev.pid)
          )
            prev.pid = pid;
        }
        // The incumbent keeps a live record (#1950). It moves to another
        // service only once its own service is gone (`opencode service
        // restart`, a reused pid) or no longer has the session open in a TUI
        // attached to it (reopened under another service). Otherwise a second
        // service could take B's record and deliveries. Residual, accepted
        // under #1856 option A: a same-user process under one service that
        // claims first can block B through another service until then (DoS).
        if (
          prev?.live &&
          prev.kind === "opencode" &&
          hello.kind === "opencode" &&
          prev.pid !== pid &&
          (ocServiceGone(prev.ref, prev.pid) ||
            openCodeStateFor(prev.pid, prev.ref) === false)
        ) {
          prev.pid = pid;
          ocServiceStart.set(prev.ref, ocStart(pid));
        }
        // A thread resumed in another Codex process (attest proved it holds the
        // lock) moves only once its old process is gone or no longer holds it.
        if (
          prev?.live &&
          prev.kind === "codex" &&
          hello.kind === "codex" &&
          prev.pid !== pid &&
          !codexCheck.sweep([{ thread: prev.ref, pid: prev.pid }], true).size
        )
          prev.pid = pid;
        if (prev?.live) {
          if (prev.kind !== hello.kind || prev.pid !== pid) {
            return { error: "agent_ref is in use by another session" };
          }
          // The same session reconnecting keeps its record: never re-homed.
          attested(pid);
          conns.set(prev.ref, (conns.get(prev.ref) ?? 0) + 1);
          // Pi is told on its connection, which exists only once welcomed (onOpen).
          if (!piLike(hello.kind)) tellOwed(prev.ref);
          // A rename made while the link was down (#1635).
          if (hello.proposed_name !== undefined && prev.kind === "pi")
            renameFromAdapter(prev, hello.proposed_name);
          return {
            bus_name: prev.busName,
            namespace: prev.namespace,
            global: prev.global,
            ...capsFor(hello),
            ...bound(),
          };
        }
        // Claude's session file names its cwd; other kinds state one.
        const cwd = check.cwd ?? hello.cwd;
        if (!cwd || !isAbsolute(cwd)) return { error: "cwd must be absolute" };
        let ns: Namespace;
        try {
          // A live Claude session may have outlived its start directory.
          ns = resolveNs(cwd, check.cwd !== undefined);
        } catch {
          return { error: `cwd does not resolve: ${cwd}` };
        }
        if (!WireNamespaceSchema.safeParse(ns.namespace).success)
          return {
            error: `namespace is not valid on the wire: ${ns.namespace}`,
          };
        attested(pid);
        // A Codex thread the user named registers under that name (#1748).
        const codexName =
          hello.kind === "codex"
            ? codexThreadNames(codexIndexHome).get(hello.agent_ref)
            : undefined;
        const proposedName =
          codexName ?? hello.proposed_name ?? hello.agent_ref;
        // /clear (#1295): this new session runs in the process of a live
        // one whose session file is gone; it takes over that address.
        const files =
          hello.kind === "claude-code"
            ? liveClaudeSessions(claudeSessions, (r) =>
                r === hello.agent_ref ? pid : agents.byRef(r)?.pid,
              )
            : [];
        const mine = files.find(
          (x) => x.ref === hello.agent_ref && x.pid === pid,
        );
        const old =
          mine && !prev
            ? clearedFrom(
                hello.agent_ref,
                pid,
                mine.procStart,
                new Set(files.map((x) => x.ref)),
              )
            : undefined;
        seenAt.set(hello.agent_ref, ++seenSeq);
        if (old) takenOver.add(old.ref);
        const rec = agents.up({
          ...(old ? { replaces: handoverOf(old) } : {}),
          ref: hello.agent_ref,
          kind: hello.kind,
          proposedName: old?.busName ?? proposedName,
          busName: prev?.busName ?? old?.busName ?? proposedName,
          namespace: ns.namespace,
          namespaceSource: ns.source,
          global: ns.global,
          pid,
          ...(mine ? { procStart: mine.procStart } : {}),
          ...(mine ? { sessionName: mine.name } : {}),
          // Claude's MCP server reconnects per tool call: the proof stays.
          ...((prev?.linkHashes ?? old?.linkHashes) !== undefined
            ? { linkHashes: (prev?.linkHashes ?? old?.linkHashes) as string[] }
            : {}),
          ...(codexName !== undefined ? { sessionName: codexName } : {}),
          cwd,
          live: true,
        });
        ev(rec.kind === "codex" ? "codex_admitted" : "agent_join", {
          ...agentFields(rec),
          ...(prev ? { state: "revived" } : {}),
        });
        if (rec.kind === "opencode") ocServiceStart.set(rec.ref, ocStart(pid));
        if (rec.kind === "codex") {
          persistCodex();
          trackAway();
        }
        if (rec.kind === "claude-code") {
          // The first sync may have missed the file: seed from the saved hashes (#2050).
          seedLinks(rec);
          void claude.revive(rec.ref);
        }
        conns.set(rec.ref, (conns.get(rec.ref) ?? 0) + 1);
        claimProofs();
        announceUp(rec);
        if (!piLike(hello.kind)) tellOwed(rec.ref);
        return {
          bus_name: rec.busName,
          namespace: rec.namespace,
          global: rec.global,
          ...capsFor(hello),
          ...bound(),
        };
      };
      // A connection gone during the wait admits nothing: no agent, no conns.
      return checked instanceof Promise
        ? checked.then((c) =>
            closed() ? { error: "the connection closed" } : admit(c),
          )
        : admit(checked);
    },
    onFrame: (frame, hello, reply) => {
      if (frame.type === "hello") return undefined;
      // #1856: a proxied Open Artifacts call proves the thread's link and nothing else.
      if (linkOnly.has(hello) && frame.type !== "link_proof")
        return {
          type: "error",
          id: frame.id,
          code: "unauthorized",
          message: "this connection may only take a link_proof",
        };
      // A tool call's reply carries the agent's late deliveries not yet
      // shown; they count as shown once that reply is written.
      const answer = (f: DaemonFrame): boolean => {
        const late =
          frame.type !== "ack" && frame.type !== "link_proof" && frame.late
            ? sent.lateFor(hello.agent_ref)
            : [];
        if (!late.length) return reply(f);
        // Only success rides the next result; a failure is a notice that wakes the sender.
        const texts = late.map(({ meta }) =>
          stripTerminalControls(lateDeliveredText(meta.to_name, meta.excerpt)),
        );
        const written = reply({ ...f, late: texts } as DaemonFrame);
        if (written) sent.shown(late.map((l) => l.msgId));
        return written;
      };
      const out = routeLocal(frame, hello, answer, {
        agents,
        hub: { send: (f) => sendToHub(f) },
        pending,
        limited: (ref) =>
          limited.has(ref) ? (caps.get(ref) ?? "machine") : undefined,
        version,
        configFiles,
        proposeReach: (ref, namespaces) =>
          proposeReach({
            hub: cfg.hub,
            token: cfg.machine_token,
            nativeRef: ref,
            namespaces,
            fetch: deps.fetch,
            timeoutMs: deps.reachTimeoutMs,
            log,
          }),
        followSupport: () =>
          !hub.open || !hubHelloed ? "down" : hubFollow ? "ok" : "old_hub",
        linked: (ref, hash) => {
          // The adapter then adds the argument to its calls: only for a hub
          // whose /mcp strips it (an older one fails a strict tool schema).
          if (!hubLink || !hubLinkArg) return false;
          const rec = agents.byRef(ref);
          if (!rec?.live) return false;
          rec.linkHashes = withLinkHash(rec.linkHashes, hash);
          persistLinks();
          sendLink(rec, hash);
          return true;
        },
        renamed: (ref, name) => {
          const rec = agents.byRef(ref);
          if (rec) renameFromAdapter(rec, name);
        },
        // The self tool's status: the agent's own row on its roster.
        ownRow: (ref) => {
          const me = agents.byRef(ref);
          if (!me || !hub.open || hubVersion === undefined) return undefined;
          return hubRoster(ref).then((rows) =>
            rows?.find(
              (a) => a.name === me.busName && a.namespace === me.namespace,
            ),
          );
        },
        setStatus: (f, ref, reply) => {
          // Open but no hello_ok yet: the link is not ready.
          if (!hub.open || hubVersion === undefined)
            return {
              type: "error",
              code: "hub_unavailable",
              message: STATUS_COPY.hub_unavailable,
            };
          statusRelay.status(ref, f.state, f.label, reply);
          return undefined;
        },
        // A Pi delivery waits on this same confirmation, from its own session.
        // An ack past Pi's timeout, from the same session, still counts.
        confirm: (msgId, ref) => {
          if (delivery.confirm(msgId, ref)) {
            pi.acked(msgId, ref);
            return true;
          }
          if (!pi.lateAck(msgId, ref)) return false;
          delivery.delivered(msgId);
          return true;
        },
      });
      if (out) answer({ ...out, v: 1, id: frame.id } as DaemonFrame);
      return undefined;
    },
    onOpen: (hello, push) => {
      if (!piLike(hello.kind)) return;
      const links = piLinks.get(hello.agent_ref) ?? new Map();
      links.set(hello, push);
      piLinks.set(hello.agent_ref, links);
      tellOwed(hello.agent_ref);
    },
    onClose: (hello) => {
      if (!hello) return;
      const links = piLinks.get(hello.agent_ref);
      links?.delete(hello);
      if (links?.size === 0) {
        piLinks.delete(hello.agent_ref);
        pi.dropRef(hello.agent_ref);
      }
      const left = (conns.get(hello.agent_ref) ?? 1) - 1;
      if (left > 0) {
        conns.set(hello.agent_ref, left);
        return;
      }
      conns.delete(hello.agent_ref);
      // Only pi lives as long as its connection. Claude's MCP server connects
      // per tool call (its liveness is the session files); OpenCode's is presence.
      if (!piLike(hello.kind)) return;
      const bound = bindings.get(hello.agent_ref);
      if (bound) bound.closedAt = bindingNow();
      const rec = agents.byRef(hello.agent_ref);
      if (!rec) return;
      rec.live = false;
      ev("agent_leave", agentFields(rec, "link_closed"));
      announceSessions();
    },
  }).catch(socketInUse);
  // A cleaner or a hand may remove the socket: adapters would get ENOENT forever.
  const bound = lstatSync(listenPath);
  const socketWatch = setInterval(() => {
    let now: ReturnType<typeof lstatSync> | undefined;
    try {
      now = lstatSync(listenPath);
    } catch {}
    if (now?.ino === bound.ino && now.dev === bound.dev) return;
    clearInterval(socketWatch);
    log(`the daemon socket ${listenPath} was removed or replaced`);
    deps.onSocketLost?.();
  }, deps.socketCheckMs ?? 60_000);
  socketWatch.unref();

  /** #1748: each live attested Codex thread, kept so a restart can take it back. */
  const codexAgentsFile = cx.agentsFile ?? join(home(), "codex-agents.json");
  let codexSaved: string | undefined;
  const persistCodex = () => {
    const rows: CodexAgent[] = [];
    for (const a of agents.all()) {
      if (a.kind !== "codex" || !a.live) continue;
      const procStart = codexCheck.startOf(a.pid);
      if (procStart === undefined) continue;
      rows.push({
        ref: a.ref,
        pid: a.pid,
        procStart,
        proposedName: a.proposedName,
        ...(a.sentName !== undefined ? { sentName: a.sentName } : {}),
        busName: a.busName,
      });
    }
    const text = JSON.stringify(rows);
    // Never touches the home until a thread has been attested.
    if (codexSaved === undefined ? rows.length === 0 : text === codexSaved)
      return;
    try {
      writeCodexAgents(codexAgentsFile, rows);
      codexSaved = text;
    } catch (e) {
      log(
        `could not save the live Codex threads: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  /**
   * #1748: a restarted daemon takes back the Codex threads it had attested,
   * each only if its process is still the one pinned and still holds the
   * thread's lock. The next `agent_up` (hub open) announces them by name.
   */
  const restoreCodex = () => {
    if (deps.attest) return;
    for (const r of readCodexAgents(codexAgentsFile)) {
      if (agents.byRef(r.ref)) continue;
      let proven: { cwd: string } | undefined;
      try {
        proven = codexCheck.restore({
          thread: r.ref,
          pid: r.pid,
          start: r.procStart,
        });
      } catch {}
      if (!proven) continue;
      // Scope comes from the proven cwd and today's config, as at a hello.
      let ns: Namespace;
      try {
        ns = resolveNs(proven.cwd, true);
      } catch {
        continue;
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success) continue;
      agents.up({
        ref: r.ref,
        kind: "codex",
        proposedName: r.proposedName,
        busName: r.busName,
        namespace: ns.namespace,
        namespaceSource: ns.source,
        global: ns.global,
        pid: r.pid,
        procStart: r.procStart,
        cwd: proven.cwd,
        live: true,
        ...(r.sentName !== undefined ? { sentName: r.sentName } : {}),
      });
      seenAt.set(r.ref, ++seenSeq);
      if (debug) log(`restored codex thread ${r.ref.slice(0, 8)} pid ${r.pid}`);
    }
  };

  /** #2029: each Codex thread proved here, kept so mail held for it can wake it. */
  const awayFile = cx.awayFile ?? join(home(), "codex-away.json");
  const awayNow = deps.bindingNow ?? Date.now;
  const HOUR = 3_600_000;
  const awayRows = new Map<string, CodexAway>(
    readCodexAway(awayFile, awayNow()).map((r) => [r.ref, r]),
  );
  let awaySaved: string | undefined;
  const trackAway = () => {
    const now = awayNow();
    for (const a of agents.all()) {
      if (a.kind !== "codex") continue;
      const prev = awayRows.get(a.ref);
      const lastLive = a.live
        ? Math.floor(now / HOUR) * HOUR
        : (prev?.lastLive ?? Math.floor(now / HOUR) * HOUR);
      if (
        !WireNamespaceSchema.safeParse(a.namespace).success ||
        !AgentRefSchema.safeParse(a.ref).success
      )
        continue;
      awayRows.set(a.ref, {
        ref: a.ref,
        name: a.busName,
        namespace: a.namespace,
        lastLive,
      });
    }
    const kept = trimAway([...awayRows.values()], now);
    awayRows.clear();
    for (const r of kept) awayRows.set(r.ref, r);
    const text = JSON.stringify(kept);
    if (awaySaved === undefined ? kept.length === 0 : text === awaySaved)
      return;
    try {
      writeCodexAway(awayFile, kept);
      awaySaved = text;
    } catch (e) {
      log(
        `could not save the Codex away threads: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const woken = new HeldStore(
    cx.wokenFile ?? join(home(), "codex-woken.json"),
    { ttlMs: 7 * 24 * HOUR },
  );
  /** Decisions already logged, and the last hub roster read, per `thread:pid:start`. */
  const wakeLogged = new Set<string>();
  const wakeAsked = new Map<string, number>();
  let waking = false;
  let wakeCheckedAt: number | undefined;
  /** Wakes sent and not yet answered by the thread's own call, and the mail count at each. */
  const wakeSent = new Map<
    string,
    { ref: string; at: number; logged: boolean }
  >();
  const wakeWaiting = new Map<string, number>();
  const WAKES_MAX = 3;
  /**
   * #2029: an away Codex thread whose lock a `codex` process we have not
   * proved holds, with mail waiting at the hub, gets ONE fixed bus-written
   * text per app-server start. The thread proves itself with its own call.
   */
  const wakeAway = async () => {
    if (waking) return;
    waking = true;
    try {
      const now = awayNow();
      // A wake whose thread never called `self`: the mail stays held, never delivered.
      for (const [k, w] of wakeSent) {
        if (agents.byRef(w.ref)?.live) wakeSent.delete(k);
        else if (!w.logged && now - w.at >= (cx.wakeAnswerMs ?? 300_000)) {
          w.logged = true;
          log(`codex wake ${w.ref.slice(0, 8)} wake_unanswered`);
        }
      }
      const rows = [...awayRows.values()].filter(
        (r) => now - r.lastLive <= AWAY_IDLE_MS && !agents.byRef(r.ref)?.live,
      );
      // Pruned for threads no longer away, or live.
      const away = new Set(rows.map((r) => r.ref));
      for (const [k, w] of wakeSent) if (!away.has(w.ref)) wakeSent.delete(k);
      for (const m of [wakeAsked, wakeWaiting])
        for (const k of m.keys())
          if (!away.has(k.split(":")[1] ?? "")) m.delete(k);
      if (!rows.length) return;
      // The checks cost an lsof, a ps and rollout reads: not on every tick.
      if (
        wakeCheckedAt !== undefined &&
        now - wakeCheckedAt < (cx.wakeCheckMs ?? 300_000)
      )
        return;
      wakeCheckedAt = now;
      const held = codexCheck.holders(rows.map((r) => r.ref));
      if (!held) return;
      const once = (key: string, msg: string) => {
        if (wakeLogged.has(key + msg)) return;
        wakeLogged.add(key + msg);
        if (wakeLogged.size > 500) wakeLogged.clear();
        log(msg);
      };
      // #2079: one frame for every held row, no live agent needed.
      let counts: Record<string, number> | undefined;
      if (hubWaitingQuery && hub.open && hubVersion !== undefined) {
        const refs = rows
          .filter((r) => held.has(r.ref))
          .map((r) => r.ref)
          .slice(0, MAX_WAITING_QUERY);
        if (refs.length) {
          counts = await hubWaitingCounts(refs);
          if (!counts) log("codex wake skipped: the hub did not answer");
        }
      }
      for (const r of rows) {
        const h = held.get(r.ref);
        if (!h) continue;
        const key = `wake:${r.ref}:${h.pid}:${h.start.replace(/\s+/g, "_")}`;
        const who = `codex wake ${r.ref.slice(0, 8)} pid ${h.pid}`;
        let n = 1;
        while (n <= WAKES_MAX && woken.has(`${key}#${n}`)) n++;
        if (n > WAKES_MAX) continue;
        const againAfter =
          n > 1 ? (woken.at(`${key}#${n - 1}`) ?? now) : undefined;
        // A further wake only after an hour, and only for mail newer than the last wake's.
        if (againAfter !== undefined) {
          if (
            now - againAfter < (cx.wakeAgainMs ?? 3_600_000) ||
            !wakeWaiting.has(key)
          )
            continue;
        }
        let waitingN: number | undefined;
        if (hubWaitingQuery) {
          if (!counts) continue;
          waitingN = counts[r.ref];
        } else {
          // Prefer an asker in the thread's namespace, then a global one.
          const live = agents.all().filter((a) => a.live);
          const asker =
            live.find((a) => a.namespace === r.namespace) ??
            live.find((a) => a.global) ??
            live[0];
          if (!asker || !hub.open || hubVersion === undefined) {
            once(key, `${who} skipped: no live agent to ask the hub`);
            continue;
          }
          if (!hubWaiting) {
            once(key, `${who} skipped: the hub does not report waiting mail`);
            continue;
          }
          const last = wakeAsked.get(key);
          if (last !== undefined && now - last < (cx.wakeAskMs ?? 300_000))
            continue;
          wakeAsked.set(key, now);
          const roster = await hubRoster(asker.ref);
          if (!roster) {
            once(key + now, `${who} skipped: the hub did not answer`);
            continue;
          }
          waitingN = roster.find(
            (a) =>
              a.state === "away" &&
              a.name === r.name &&
              a.namespace === r.namespace &&
              (a.machine_label === undefined || a.machine_label === cfg.label),
          )?.waiting;
        }
        if (!waitingN) {
          once(key, `${who} skipped: no mail waiting`);
          continue;
        }
        const row = { waiting: waitingN };
        if (
          n > 1 &&
          row.waiting === wakeWaiting.get(key) &&
          row.waiting < 100
        ) {
          once(
            key + n,
            `${who} skipped: the mail count has not changed since the last wake`,
          );
          continue;
        }
        if (!(await codex.canWake(h.pid))) {
          once(
            key,
            `${who} skipped: the process does not wake on a queued message`,
          );
          continue;
        }
        // Recorded first: a failure or a refusal is never tried again for this start.
        try {
          woken.add(`${key}#${n}`);
        } catch (e) {
          once(
            key,
            `${who} skipped: could not record the wake (${e instanceof Error ? e.message : String(e)})`,
          );
          continue;
        }
        const res = await codex.wake(
          r.ref,
          h.pid,
          `${key}#${n}`,
          CODEX_WAKE_TEXT,
        );
        wakeWaiting.set(key, row.waiting);
        ev("codex_wake", { thread: r.ref, state: res });
        // A refusal (or a timeout) ends the wakes for this start: spend the rest.
        if (res === "failed" || res === "maybe")
          try {
            for (let m = n + 1; m <= WAKES_MAX; m++) woken.add(`${key}#${m}`);
          } catch {}
        if (res === "sent")
          wakeSent.set(key, { ref: r.ref, at: now, logged: false });
        log(
          res === "sent"
            ? `${who} sent`
            : res === "no_host"
              ? `${who} skipped: the process does not wake on a queued message`
              : `${who} failed: ${res}`,
        );
      }
    } catch (e) {
      log(`codex wake failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      waking = false;
    }
  };

  /**
   * A Codex thread is live while its process is the one pinned at its first
   * call (lstart, every sync) and still holds the thread's lock (lsof, every
   * `relockEvery` syncs: 30 s by default). Holding the lock means Codex has the
   * thread loaded, not that a user is watching (the shared daemon keeps threads).
   */
  const syncCodex = () => {
    try {
      syncCodexInner();
    } finally {
      trackAway();
      if (!deps.attest && relockTickNow) void wakeAway();
    }
  };
  let relockTickNow = false;
  const syncCodexInner = () => {
    renameCodexThreads();
    // Not-live threads join only on a relock tick: a thread that dropped its
    // lock keeps its proof, and comes back when the same process holds it again.
    codexTicks = (codexTicks + 1) % relockEvery;
    const relockTick = codexTicks === 0;
    relockTickNow = relockTick;
    const all = agents
      .all()
      .filter((a) => a.kind === "codex" && (a.live || relockTick))
      .map((a) => ({ thread: a.ref, pid: a.pid, live: a.live }));
    // Stubbed attestation leaves no proofs to sweep.
    if (!all.length || deps.attest) return persistCodex();
    const still = codexCheck.sweep(all, relockTick);
    let changed = false;
    for (const { thread, live } of all) {
      if (still.has(thread) === live) continue;
      const a = agents.byRef(thread);
      if (!a) continue;
      a.live = !live;
      if (!live) {
        // Back: the hub only learns of a revival from an agent_up, and mail waits.
        announceUp(a);
        tellOwed(a.ref);
      } else changed = true;
      ev("codex_liveness", { thread, state: live ? "not_live" : "live" });
      log(`codex thread ${thread} ${live ? "not live" : "live again"}`);
    }
    if (changed) announceSessions();
    // persistCodex keeps only live threads: a restart during a drop still needs a hello.
    persistCodex();
  };

  const sync = () => {
    for (const [what, fn] of [
      ["claude", syncClaude],
      ["opencode", syncOpenCode],
      ["codex", syncCodex],
    ] as const) {
      try {
        fn();
      } catch (e) {
        log(
          `${what} session sync failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // After the syncs, so a name held back goes as its latest value, not the
    // one it had when the hold began. Pi and omp have no session file to
    // prompt it.
    for (const rec of agents.all()) if (rec.live) flushRename(rec);
    sweepBindings();
    // Queued Codex mail a turn has taken is acked now, late (#2029).
    try {
      codexTaken.check();
    } catch (e) {
      log(
        `codex taken check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  restoreCodex();
  sync();
  const watcher = setInterval(sync, cl.syncMs ?? 2000);
  watcher.unref();
  // A notice that failed for a live sender is retried; `tell` keeps one in flight per entry.
  const retry = setInterval(() => {
    for (const a of agents.all()) if (a.live) tellOwed(a.ref);
  }, NOTICE_RETRY_MS);
  retry.unref();

  // After the socket is up, so `npx @open-artifacts/bus install` sees the daemon at once.
  const ocVersion = await (
    oc.version ?? (() => opencodeVersion(spawnExec(ocSpawn)))
  )().catch(() => undefined);
  promptIdSupported = supportsPromptId(ocVersion);
  if (!promptIdSupported)
    log(
      `OpenCode ${ocVersion ?? "(version unknown)"} is below ${MIN_PROMPT_ID_VERSION}: a timed-out prompt is never retried`,
    );
  hub.start();
  ev("daemon_start", { version: deps.version, pid: process.pid });
  return {
    hub,
    agents,
    bindings: { count: () => bindings.size, sweep: sweepBindings },
    stop: async () => {
      ev("daemon_stop", { pid: process.pid });
      clearInterval(socketWatch);
      clearInterval(watcher);
      clearInterval(retry);
      delivery.stop();
      outbox.stop();
      resends.stop();
      for (const t of limited.values()) clearTimeout(t);
      hub.stop();
      // A send waiting for delivered is queued at the hub: it answers so, not as an error.
      receipts.release();
      await new Promise((r) => setImmediate(r));
      pending.failAll("hub_unavailable", "the daemon is stopping");
      sent.flush();
      await Promise.all([server.close(), claude.close()]);
      // daemon_stop must reach the file before the process exits.
      await deps.events?.flush?.().catch(() => {});
    },
  };
}

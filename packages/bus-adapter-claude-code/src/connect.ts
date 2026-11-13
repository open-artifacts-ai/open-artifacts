import { BUS_CMD, HelloRefused } from "@oa/bus-ipc";
import {
  type ClaudeSession,
  NOT_UNDER_CLAUDE,
  type NoSessionReason,
  RECOVERABLE_REASONS,
  type SessionLookup,
} from "./session.ts";

export const RESTARTING_MESSAGE =
  "oa-bus: the bus daemon is restarting; retry in a few seconds. If it keeps failing, run /mcp and reconnect oa_bus.";

/** How long a call waits for a daemon that is restarting (#2364). */
export const RESTART_WAIT_MS = 2000;
const RESTART_STEP_MS = 200;

export const BUSY_MESSAGE =
  "oa-bus: the bus daemon did not answer in time (busy?). Try again.";

export type ConnectOutcome<C> =
  | { kind: "ok"; client: C }
  /** No session above this process, or an unsafe socket folder; `reason` says which. */
  | { kind: "no-session"; reason: NoSessionReason }
  /**
   * A session, but no daemon answered within the wait. `seen` is true when a
   * socket file existed at some point (a daemon that is restarting): then no
   * install would help. False means no daemon at all: the install hint applies.
   */
  | { kind: "no-socket"; seen: boolean }
  /** A session and a socket, but the connect or hello timed out or was reset. */
  | { kind: "busy" }
  /** The daemon answered hello with a refusal: its reason is the message. */
  | { kind: "refused"; reason: string };

export type ConnectDeps<C> = {
  findSession: () => SessionLookup;
  socketDirProblem: () => unknown;
  socketExists: () => boolean;
  connect: (session: ClaudeSession) => Promise<C>;
  /** Injected by tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
};

export async function connectOutcome<C>(
  deps: ConnectDeps<C>,
): Promise<ConnectOutcome<C>> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? RESTART_WAIT_MS;
  // A restarting daemon leaves its socket absent or refusing for a moment.
  // Every attempt looks everything up again, so nothing stale survives.
  let seen = false;
  for (let waited = 0; ; waited += RESTART_STEP_MS) {
    const out = await attempt(deps);
    if (out.kind === "no-session") {
      if (!RECOVERABLE_REASONS.includes(out.reason) || waited >= waitMs)
        return out;
      await sleep(RESTART_STEP_MS);
      continue;
    }
    if (out.kind !== "no-socket") return out;
    seen ||= out.seen;
    if (waited >= waitMs) return { kind: "no-socket", seen };
    await sleep(RESTART_STEP_MS);
  }
}

async function attempt<C>(deps: ConnectDeps<C>): Promise<ConnectOutcome<C>> {
  let session: ClaudeSession;
  try {
    const found = deps.findSession();
    if (!found.ok) return { kind: "no-session", reason: found.reason };
    session = found.session;
    if (deps.socketDirProblem())
      return { kind: "no-session", reason: "socket_dir" };
  } catch {
    // ps did not answer in time (ProcStartUnknownError): a loaded machine, not a missing install.
    return { kind: "busy" };
  }
  if (!deps.socketExists()) return { kind: "no-socket", seen: false };
  try {
    return { kind: "ok", client: await deps.connect(session) };
  } catch (e) {
    if (e instanceof HelloRefused)
      return { kind: "refused", reason: e.reason ?? e.message };
    const code = (e as NodeJS.ErrnoException)?.code;
    // The socket file exists but nothing is listening (or it vanished): a daemon coming up or going down.
    if (code === "ECONNREFUSED" || code === "ENOENT")
      return { kind: "no-socket", seen: code === "ECONNREFUSED" };
    // A timeout, a reset, a dropped connection: a daemon that exists but is not answering.
    return { kind: "busy" };
  }
}

/** The text for a failed connect; `underClaude` decides whether an install would help. */
export function noSessionMessage(
  out: Exclude<ConnectOutcome<unknown>, { kind: "ok" }>,
  underClaude: boolean,
): string {
  if (out.kind === "busy") return BUSY_MESSAGE;
  if (out.kind === "refused")
    return `oa-bus: the bus daemon refused: ${out.reason}`;
  if (out.kind === "no-socket" && out.seen) return RESTARTING_MESSAGE;
  if (out.kind === "no-session")
    return underClaude
      ? `oa-bus: this Claude session isn't visible to the bus right now (${out.reason}); retry, or run /mcp and reconnect oa_bus.`
      : NOT_UNDER_CLAUDE;
  return underClaude
    ? `oa-bus: no Claude session or daemon found. Run \`${BUS_CMD} install\`.`
    : NOT_UNDER_CLAUDE;
}

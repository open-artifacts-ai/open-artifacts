import { BUS_CMD, HelloRefused } from "@oa/bus-ipc";
import { type ClaudeSession, NOT_UNDER_CLAUDE } from "./session.ts";

export const BUSY_MESSAGE =
  "oa-bus: the bus daemon did not answer in time (busy?). Try again.";

export type ConnectOutcome<C> =
  | { kind: "ok"; client: C }
  /** No session above this process, or an unsafe socket folder. */
  | { kind: "no-session" }
  /** A session, but no daemon socket: the install hint applies. */
  | { kind: "no-socket" }
  /** A session and a socket, but the connect or hello timed out or was reset. */
  | { kind: "busy" }
  /** The daemon answered hello with a refusal: its reason is the message. */
  | { kind: "refused"; reason: string };

export type ConnectDeps<C> = {
  findSession: () => ClaudeSession | null;
  socketDirProblem: () => unknown;
  socketExists: () => boolean;
  connect: (session: ClaudeSession) => Promise<C>;
};

export async function connectOutcome<C>(
  deps: ConnectDeps<C>,
): Promise<ConnectOutcome<C>> {
  let session: ClaudeSession | null;
  try {
    session = deps.findSession();
    if (!session || deps.socketDirProblem()) return { kind: "no-session" };
  } catch {
    // ps did not answer in time (ProcStartUnknownError): a loaded machine, not a missing install.
    return { kind: "busy" };
  }
  if (!deps.socketExists()) return { kind: "no-socket" };
  try {
    return { kind: "ok", client: await deps.connect(session) };
  } catch (e) {
    if (e instanceof HelloRefused)
      return { kind: "refused", reason: e.reason ?? e.message };
    const code = (e as NodeJS.ErrnoException)?.code;
    // Nothing is listening: the daemon is not running (or not installed).
    if (code === "ECONNREFUSED" || code === "ENOENT")
      return { kind: "no-socket" };
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
  return underClaude
    ? `oa-bus: no Claude session or daemon found. Run \`${BUS_CMD} install\`.`
    : NOT_UNDER_CLAUDE;
}

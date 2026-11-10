import { BUS_CMD } from "@oa/bus-ipc";
import { type ClaudeSession, NOT_UNDER_CLAUDE } from "./session.ts";

export const BUSY_MESSAGE =
  "oa-bus: the bus daemon did not answer in time (busy?). Try again.";

export type ConnectOutcome<C> =
  | { kind: "ok"; client: C }
  /** No session above this process, or an unsafe socket folder. */
  | { kind: "no-session" }
  /** A session, but no daemon socket: the install hint applies. */
  | { kind: "no-socket" }
  /** A session and a socket, but the connect or hello failed or timed out. */
  | { kind: "busy" };

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
    // ps did not answer in time: a loaded machine, not a missing install.
    return { kind: "busy" };
  }
  if (!deps.socketExists()) return { kind: "no-socket" };
  try {
    return { kind: "ok", client: await deps.connect(session) };
  } catch {
    return { kind: "busy" };
  }
}

/** The text for a failed connect; `underClaude` decides whether an install would help. */
export function noSessionMessage(
  kind: "no-session" | "no-socket" | "busy",
  underClaude: boolean,
): string {
  if (kind === "busy") return BUSY_MESSAGE;
  return underClaude
    ? `oa-bus: no Claude session or daemon found. Run \`${BUS_CMD} install\`.`
    : NOT_UNDER_CLAUDE;
}

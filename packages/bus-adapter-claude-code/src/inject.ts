import { connect } from "node:net";

export type InjectArgs = {
  socketPath: string;
  peerToken: string;
  fromSocket: string;
  fromName: string;
  msgId: string;
  text: string;
  /** Production 5000 ms. */
  timeoutMs?: number;
};

/** `connected` false: nothing listens there (gone). True: it took the connection, then failed (retry). */
export class InjectError extends Error {
  constructor(
    message: string,
    readonly connected: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "InjectError";
  }
}

const attr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** A body can neither close the wrapper nor open a second one with a forged sender. */
const neutralize = (s: string) =>
  s.replace(/<(\s*\/?\s*cross-session-message)/gi, "&lt;$1");

export function frameOf(
  a: Pick<InjectArgs, "fromSocket" | "fromName" | "msgId" | "text">,
): Record<string, unknown> {
  const from = `uds:${a.fromSocket}`;
  const inner =
    `<cross-session-message from="${attr(from)}" from-name="${attr(a.fromName)}" from-mode="prompting">\n` +
    `${neutralize(a.text)}\n</cross-session-message>`;
  return {
    msgV: 1,
    msg_id: a.msgId,
    type: "user",
    message: { role: "user", content: inner },
    priority: "next",
    from,
  };
}

/**
 * Auth first, frame second, half-close (Claude's UDS protocol; never read the
 * inbound connection). Resolves once Claude has drained it; rejects on any
 * socket error or after the timeout.
 */
export function inject(a: InjectArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(a.socketPath);
    let connected = false;
    const fail = (e: Error & { code?: string }) => {
      clearTimeout(timer);
      sock.destroy();
      reject(new InjectError(e.message, connected, e.code));
    };
    const timer = setTimeout(
      () =>
        fail(
          Object.assign(new Error(`injection into ${a.socketPath} timed out`), {
            code: "ETIMEDOUT",
          }),
        ),
      a.timeoutMs ?? 5000,
    );
    sock.on("error", fail);
    sock.once("connect", () => {
      connected = true;
      sock.write(`${JSON.stringify({ type: "auth", token: a.peerToken })}\n`);
      // end()'s callback also runs on error; only `finish` means written.
      sock.once("finish", () => {
        clearTimeout(timer);
        sock.destroy();
        resolve();
      });
      sock.end(`${JSON.stringify(frameOf(a))}\n`);
    });
  });
}

import { lstat, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import WebSocket from "ws";

export type SteerResult = "fallback" | "accepted" | "uncertain";

/** A private leaf is renameable if another user controls a parent. Sticky /tmp is safe
 * because every child on this canonical path must belong to root or this user. */
async function trustedParents(path: string, uid: number): Promise<boolean> {
  const parent = dirname(path);
  if (parent !== path && !(await trustedParents(parent, uid))) return false;
  const s = await lstat(path);
  return (
    s.isDirectory() &&
    (s.uid === uid || s.uid === 0) &&
    ((s.mode & 0o022) === 0 || (s.mode & 0o1000) !== 0)
  );
}

/** Use the local Codex daemon's WebSocket API. A stdio-only host has no control socket. */
export async function steerCodex(
  home: string,
  thread: string,
  text: string,
): Promise<SteerResult> {
  const dir = join(home, "app-server-control");
  let path: string;
  try {
    // Recent Codex versions publish a symlink to a short Unix socket path.
    path = await realpath(join(dir, "app-server-control.sock"));
    const [directory, targetDir, socket] = await Promise.all([
      lstat(dir),
      lstat(dirname(path)),
      lstat(path),
    ]);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !directory.isDirectory() ||
      directory.uid !== uid ||
      (directory.mode & 0o022) !== 0 ||
      !targetDir.isDirectory() ||
      targetDir.uid !== uid ||
      (targetDir.mode & 0o022) !== 0 ||
      !socket.isSocket() ||
      socket.uid !== uid ||
      !(await trustedParents(dirname(path), uid))
    )
      return "fallback";
  } catch {
    return "fallback";
  }
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost/", {
      createConnection: () => connect(path),
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
    });
    let step = 1;
    let turn: string | undefined;
    const finish = (result: SteerResult) => {
      clearTimeout(timer);
      resolve(result);
      ws.terminate();
    };
    // A lost response after sending steer is ambiguous. A queue fallback
    // would deliver twice. The ordinary rollout watcher can still confirm it.
    const disconnected = () => finish(step === 3 ? "uncertain" : "fallback");
    const timer = setTimeout(disconnected, 2000);
    timer.unref();
    ws.once("close", disconnected);
    ws.on("error", disconnected);
    ws.once("open", () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "oa-bus", version: "1" } },
        }),
      ),
    );
    ws.on("message", (raw) => {
      let msg: {
        id?: number;
        error?: { code: number };
        result?: { data?: { id?: string; status?: string }[]; turnId?: string };
      } | null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return disconnected();
      }
      if (msg?.id !== step) return;
      if (msg.error) {
        // Invalid request/params (including a finished or replaced turn), or
        // an unsupported method: the request was rejected before delivery.
        if (
          step < 3 ||
          [-32600, -32601, -32602, -32001].includes(msg.error.code)
        )
          return finish("fallback");
        return disconnected();
      }
      if (step === 1) {
        step = 2;
        ws.send(JSON.stringify({ method: "initialized" }));
        ws.send(
          JSON.stringify({
            id: 2,
            method: "thread/turns/list",
            params: {
              threadId: thread,
              limit: 1,
              sortDirection: "desc",
              itemsView: "notLoaded",
            },
          }),
        );
      } else if (step === 2) {
        const latest = msg.result?.data?.[0];
        if (
          latest?.status !== "inProgress" ||
          typeof latest.id !== "string" ||
          !latest.id
        )
          return finish("fallback");
        turn = latest.id;
        step = 3;
        ws.send(
          JSON.stringify({
            id: 3,
            method: "turn/steer",
            params: {
              threadId: thread,
              expectedTurnId: turn,
              input: [{ type: "text", text }],
            },
          }),
        );
      } else {
        finish(msg.result?.turnId === turn ? "accepted" : "uncertain");
      }
    });
  });
}

import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hello } from "../src/frames.ts";

export const tmpSock = (name = "d.sock") =>
  join(mkdtempSync(join(tmpdir(), "ob-adv-")), name);
export const hello = (ref = "s1") =>
  Hello.parse({
    v: 1,
    id: "h",
    type: "hello",
    kind: "claude-code",
    agent_ref: ref,
    pid: process.pid,
    cwd: "/",
    attest: {},
  });
export const ok = () => ({ bus_name: "b", namespace: "dir:x", global: false });
export const within = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([
    p,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);
export const welcomeLine = (id = "h") =>
  `${JSON.stringify({ v: 1, id, type: "welcome", agent_ref: "s1", bus_name: "b", namespace: "n", global: false })}\n`;
/** A fake daemon: on the hello line, calls onHello(sock). */
export async function fakeDaemon(
  path: string,
  onLine: (sock: Socket, line: { type: string; id: string }) => void,
): Promise<Server> {
  const srv = createServer((sock) => {
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString();
      let i = buf.indexOf("\n");
      while (i !== -1) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(sock, JSON.parse(l));
        i = buf.indexOf("\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(path, () => r()));
  return srv;
}

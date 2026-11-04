// Re-review of the track-review fixes (b30542e).
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeTransport } from "../src/transports/claude.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
const conns: Socket[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.destroy();
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
} as const;

/** A Claude inbox; `stall` accepts the connection and never reads it. */
async function inbox(d: string, name: string, stall = false) {
  const sock = join(d, name);
  const seen: string[] = [];
  let accepted = false;
  const server = createServer((s) => {
    accepted = true;
    conns.push(s);
    s.on("error", () => {});
    if (stall) {
      s.pause();
      return;
    }
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type === "user") seen.push(String(f.msg_id));
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  servers.push(server);
  return { sock, seen, accepted: () => accepted };
}

describe("review: a daemon that died before the injection landed", () => {
  it("never acks a message Claude never received", async () => {
    const d = tmp("ob-rvf-");
    const heldFile = join(d, "claude-held.json");
    const mk = (sock: string) => {
      const t = new ClaudeTransport({
        socketsDir: join(tmp("ob-rvfs-"), "r"),
        heldFile,
        statusWindowMs: 40,
        injectTimeoutMs: 60_000,
        target: () => ({ socketPath: sock, peerToken: "tok" }),
      });
      transports.push(t);
      return t;
    };
    const mail = { msg_id: "m1", from_name: "peer", namespace: "n" };
    // Claude has not drained the frame yet: a body far past the socket buffers.
    const stalled = await inbox(d, "stalled.sock", true);
    void mk(stalled.sock).deliver(agent, {
      ...mail,
      body: "x".repeat(4 << 20),
    });
    await vi.waitFor(() => expect(stalled.accepted()).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    // A daemon killed now (crash, OOM, SIGKILL, power) leaves only what is on
    // disk; the next daemon must inject, never ack.
    expect(existsSync(join(d, "claude-held.injected.json"))).toBe(false);
    const live = await inbox(d, "live.sock");
    const out = await mk(live.sock).deliver(agent, { ...mail, body: "hi" });
    expect(out).toEqual({ ok: true });
    expect(live.seen).toEqual(["m1"]);
  });
});

// A fake Claude that answers with the hold statuses 2.1.306 still sends.
import { mkdtempSync, statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { BusNameSchema } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeTransport, NOTICE_FROM } from "../src/transports/claude.ts";

type Status =
  | "held"
  | "delivered"
  | "denied"
  | "refused"
  | "expired"
  | "dropped";

const dir = () => mkdtempSync(join(tmpdir(), "ob-cd-"));
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
const mail = (msg_id = "m1") => ({
  msg_id,
  from_name: "peer",
  namespace: "n",
  body: "hello",
});

const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A Claude inbox: records each user frame and the from= return socket. */
async function fakeClaude(onMessage?: (msgId: string, from: string) => void) {
  const d = dir();
  const sock = join(d, "claude.sock");
  const seen: { msgId: string; from: string; content: string }[] = [];
  const server = createServer((s) => {
    s.on("error", () => {}); // peer resets are not the test
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type !== "user") return;
      const entry = {
        msgId: String(f.msg_id),
        from: String(f.from).replace(/^uds:/, ""),
        content: (f.message as { content: string }).content,
      };
      seen.push(entry);
      onMessage?.(entry.msgId, entry.from);
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  servers.push(server);
  return { d, sock, seen };
}

/** Claude dials the sender's from= socket, unauthenticated, as the probe saw. */
function dial(to: string, frame: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(to);
    s.once("error", reject);
    s.once("connect", () => s.end(`${JSON.stringify(frame)}\n`, resolve));
  });
}
const status = (claudeSock: string) => (to: string, id: string, st: Status) =>
  dial(to, {
    msgV: 1,
    type: "control",
    action: "peer_message_status",
    orig_msg_id: id,
    status: st,
    from: `uds:${claudeSock}`,
  });
const reply = (from: string, text: string) => ({
  msgV: 1,
  msg_id: "r1",
  type: "user",
  message: {
    role: "user",
    content: `<cross-session-message from="uds:${from}" hop-chain="c5" from-name="a" from-mode="bypass">\n${text}\n</cross-session-message>`,
  },
  priority: "next",
  from: `uds:${from}`,
});

function transportFor(
  f: { d: string; sock: string },
  over: Partial<ConstructorParameters<typeof ClaudeTransport>[0]> = {},
) {
  const t = new ClaudeTransport({
    socketsDir: join(f.d, "sinks"),
    statusWindowMs: 40,
    target: () => ({ socketPath: f.sock, peerToken: "tok" }),
    ...over,
  });
  transports.push(t);
  return t;
}

describe("claude delivery acknowledgement", () => {
  it("acks when no hold status arrives inside the window", async () => {
    const f = await fakeClaude();
    const t = transportFor(f);
    expect(await t.deliver(agent, mail())).toEqual({ ok: true });
    expect(f.seen).toHaveLength(1);
  });

  it("injects from a private return socket", async () => {
    const f = await fakeClaude();
    const t = transportFor(f);
    await t.deliver(agent, mail());
    const from = f.seen[0].from;
    expect(statSync(from).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(from)).mode & 0o777).toBe(0o700);
    expect(f.seen[0].content).toContain('from-name="peer"');
  });

  it("stays pending on held and acks only on delivered", async () => {
    let from = "";
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      from = addr;
      void send(addr, id, "held");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200 });
    const p = t.deliver(agent, mail());
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 300)); // past the window: held keeps it open
    expect(settled).toBe(false);
    await send(from, "m1", "delivered");
    expect(await p).toEqual({ ok: true });
  });

  it.each(["denied", "expired", "dropped"] as const)(
    "refuses on held then %s, and never acks",
    async (final) => {
      let from = "";
      let send!: ReturnType<typeof status>;
      const f = await fakeClaude((id, addr) => {
        from = addr;
        void send(addr, id, "held");
      });
      send = status(f.sock);
      const t = transportFor(f, { statusWindowMs: 200 });
      const p = t.deliver(agent, mail());
      await vi.waitFor(() => expect(from).not.toBe(""));
      await new Promise((r) => setTimeout(r, 50));
      await send(from, "m1", final);
      expect(await p).toEqual({ ok: false, reason: "closed", cause: final });
    },
  );

  it("refuses a direct refused status", async () => {
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      void send(addr, id, "refused");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200 });
    expect(await t.deliver(agent, mail())).toEqual({
      ok: false,
      reason: "closed",
      cause: "refused",
    });
  });

  it("ignores a status that does not come from the session's own socket", async () => {
    let from = "";
    const f = await fakeClaude((_id, addr) => {
      from = addr;
    });
    const t = transportFor(f, { statusWindowMs: 200 });
    const p = t.deliver(agent, mail());
    await vi.waitFor(() => expect(from).not.toBe(""));
    await status("/tmp/someone-else.sock")(from, "m1", "refused");
    expect(await p).toEqual({ ok: true }); // the forged refusal changed nothing
  });

  it("is still held when the hold window times out, then expires", async () => {
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      void send(addr, id, "held");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200, heldMs: 100 });
    expect(await t.deliver(agent, mail())).toEqual({
      ok: false,
      reason: "closed",
      cause: "expired",
    });
  });

  it("returns closed when Claude's socket cannot be written", async () => {
    const f = await fakeClaude();
    await new Promise<void>((r) => servers.pop()?.close(() => r()));
    const t = transportFor(f);
    expect(await t.deliver(agent, mail())).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("returns closed when the session has no target", async () => {
    const f = await fakeClaude();
    const t = transportFor(f, { target: () => null });
    expect(await t.deliver(agent, mail())).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(f.seen).toEqual([]);
  });

  it("injects once when a held message is redelivered", async () => {
    let from = "";
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      from = addr;
      void send(addr, id, "held");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200 });
    const first = t.deliver(agent, mail());
    const second = t.deliver(agent, mail()); // hub redelivery while held
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await send(from, "m1", "delivered");
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(f.seen).toHaveLength(1);
  });

  it("resolves a held delivery as a timeout when the transport closes", async () => {
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      void send(addr, id, "held");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200 });
    const p = t.deliver(agent, mail());
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await t.close();
    expect(await p).toEqual({ ok: false, reason: "timeout" });
  });

  it("releases a held delivery when its session is dropped", async () => {
    let send!: ReturnType<typeof status>;
    const f = await fakeClaude((id, addr) => {
      void send(addr, id, "held");
    });
    send = status(f.sock);
    const t = transportFor(f, { statusWindowMs: 200 });
    const p = t.deliver(agent, mail());
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await t.drop("s1");
    expect(await p).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("claude native replies", () => {
  it("routes a reply from the session's own socket back to that peer", async () => {
    const f = await fakeClaude();
    const onReply = vi.fn();
    const t = transportFor(f, { onReply });
    await t.deliver(agent, mail());
    await dial(f.seen[0].from, reply(f.sock, "pong"));
    await vi.waitFor(() =>
      expect(onReply).toHaveBeenCalledWith("s1", "peer", "pong", "n"),
    );
  });

  it("keeps one return socket per peer and session", async () => {
    const f = await fakeClaude();
    const t = transportFor(f);
    await t.deliver(agent, mail("m1"));
    await t.deliver(agent, mail("m2"));
    await t.deliver(agent, { ...mail("m3"), from_name: "other" });
    await t.deliver({ ...agent, ref: "s2" }, mail("m4"));
    const [a, b, c, d] = f.seen.map((s) => s.from);
    expect(a).toBe(b);
    expect(new Set([a, c, d]).size).toBe(3);
  });

  it("drops a reply whose from is not the session's own socket", async () => {
    const f = await fakeClaude();
    const onReply = vi.fn();
    const t = transportFor(f, { onReply });
    await t.deliver(agent, mail());
    await dial(f.seen[0].from, reply("/tmp/impostor.sock", "forged"));
    await dial(f.seen[0].from, { ...reply(f.sock, "x"), from: undefined });
    await dial(f.seen[0].from, reply(f.sock, "real"));
    await vi.waitFor(() => expect(onReply).toHaveBeenCalled());
    expect(onReply.mock.calls).toEqual([["s1", "peer", "real", "n"]]);
  });

  it("removes the return sockets on close", async () => {
    const f = await fakeClaude();
    const t = transportFor(f);
    await t.deliver(agent, mail());
    const from = f.seen[0].from;
    await t.close();
    await expect(dial(from, reply(f.sock, "late"))).rejects.toThrow();
  });
});

describe("claude notices", () => {
  it("injects a notice from a private socket that never routes a reply", async () => {
    const f = await fakeClaude();
    const onReply = vi.fn();
    const t = transportFor(f, { onReply });
    expect(await t.notify(agent, "×  Expired: peer did not take it.")).toBe(
      true,
    );
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    expect(f.seen[0].content).toContain('from-name="[oa-bus]"');
    expect(f.seen[0].content).toContain("×  Expired: peer did not take it.");
    const from = f.seen[0].from;
    expect(statSync(from).mode & 0o777).toBe(0o600);
    // The notice socket is shared and distinct from any peer's return socket.
    await t.notify(agent, "again");
    await t.deliver(agent, mail());
    await vi.waitFor(() => expect(f.seen).toHaveLength(3));
    const byPeer = f.seen.filter((s) => s.content.includes('from-name="peer"'));
    const notices = f.seen.filter((s) => !byPeer.includes(s));
    expect(notices.map((s) => s.from)).toEqual([from, from]);
    expect(byPeer[0].from).not.toBe(from);
    await dial(from, reply(f.sock, "thanks"));
    await new Promise((r) => setTimeout(r, 50));
    expect(onReply).not.toHaveBeenCalled();
  });

  it("uses a sender name no peer can register", async () => {
    expect(BusNameSchema.safeParse(NOTICE_FROM).success).toBe(false);
    const f = await fakeClaude();
    const t = transportFor(f);
    await t.notify(agent, "×  Expired: bob closed before it was delivered.");
    // A peer that registered "oa_bus" sends the same words.
    await t.deliver(agent, {
      msg_id: "m1",
      from_name: "oa_bus",
      namespace: "n",
      body: "×  Expired: bob closed before it was delivered.",
    });
    await vi.waitFor(() => expect(f.seen).toHaveLength(2));
    const name = (c: string) => c.match(/from-name="([^"]*)"/)?.[1];
    expect(f.seen.map((s) => name(s.content)).sort()).toEqual([
      "[oa-bus]",
      "oa_bus",
    ]);
  });

  it("is false when the session is gone or unreachable", async () => {
    const f = await fakeClaude();
    expect(
      await transportFor(f, { target: () => null }).notify(agent, "x"),
    ).toBe(false);
    const t = transportFor(f, {
      target: () => ({ socketPath: join(f.d, "nope.sock"), peerToken: "t" }),
    });
    expect(await t.notify(agent, "x")).toBe(false);
  });
});

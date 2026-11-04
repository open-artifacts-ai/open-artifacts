// Reply ids end to end in the daemon (the #1323 follow-up): the hello lists
// BUS_CAPS.ids; a native reply names the agent that wrote (to_id) only when
// the hub's hello_ok listed ids, and a reply the daemon refuses tells the
// session, as information.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ob-ids-"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALICE = "8Zc4mRnA2ySu9QwB";
const servers: Server[] = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A live Claude session the daemon delivers into; records where to reply and what it was told. */
async function session(
  hubCaps: string[] | undefined,
  index?: (d: string) => string,
) {
  const d = dir();
  const sock = join(d, "c.sock");
  const seen: { from: string; content: string }[] = [];
  const server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type === "user")
        seen.push({
          from: String(f.from).replace(/^uds:/, ""),
          content: (f.message as { content: string }).content,
        });
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(sock, () => r()));
  writeFileSync(
    join(d, "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: "s4242",
      procStart: "t0",
      name: "npm-test",
      messagingSocketPath: sock,
      cwd: "/repo",
    }),
  );
  writeFileSync(
    join(d, `4242.${sha(sock)}.key`),
    JSON.stringify({ peerToken: "tok", procStart: "t0" }),
  );
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      ...(index ? { returnIndexFile: index(d) } : {}),
      statusWindowMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    ...(hubCaps === undefined ? {} : { caps: hubCaps }),
  });
  await h.next("agent_up");
  return { h, d, sock, seen };
}

const reply = (claudeSock: string, text: string) =>
  `${JSON.stringify({
    msgV: 1,
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="uds:${claudeSock}" from-name="npm-test">\n${text}\n</cross-session-message>`,
    },
    from: `uds:${claudeSock}`,
  })}\n`;

async function answer(to: string, line: string) {
  const s = connect(to);
  await new Promise<void>((r) => s.once("connect", () => r()));
  s.end(line);
}

const deliver = (from_id?: string) => ({
  id: "d1",
  type: "deliver",
  msg_id: "mmmmmmmmmmmmmmm1",
  to_ref: "s4242",
  from_name: "alice",
  ...(from_id === undefined ? {} : { from_id }),
  namespace: "ns",
  body: "hi",
});

describe("reply ids in the daemon", () => {
  it("says hello with the ids cap", async () => {
    const { h } = await session(undefined);
    expect(h.of("hello")[0]?.caps).toEqual([BUS_CAPS.ids]);
  });

  it("a reply names the agent that wrote, when the hub listed ids", async () => {
    const { h, sock, seen } = await session([BUS_CAPS.rename, BUS_CAPS.ids]);
    h.toDaemon(deliver(ALICE));
    await h.next("ack");
    await answer(seen[0]?.from as string, reply(sock, "pong"));
    expect(await h.next("send")).toMatchObject({
      to_name: "alice",
      to_id: ALICE,
      body: "pong",
    });
  });

  it("never sends to_id to a hub that did not list ids", async () => {
    const { h, sock, seen } = await session(undefined);
    h.toDaemon(deliver(ALICE));
    await h.next("ack");
    await answer(seen[0]?.from as string, reply(sock, "pong"));
    const sent = await h.next("send");
    expect(sent).toMatchObject({ to_name: "alice", body: "pong" });
    expect(sent).not.toHaveProperty("to_id");
  });

  it("a revived socket that does not know who wrote refuses the reply and tells the session", async () => {
    const key = "s4242\u0000ns\u0000alice";
    const { h, d, seen } = await session([BUS_CAPS.ids], (dd) => {
      const file = join(dd, "claude-return.json");
      // A daemon before ids recorded alice, with no agent id.
      writeFileSync(
        file,
        JSON.stringify({
          [key]: {
            agentRef: "s4242",
            namespace: "ns",
            peerName: "alice",
            at: Date.now(),
          },
        }),
        { mode: 0o600 },
      );
      return file;
    });
    const path = join(d, "r", `${sha(key).slice(0, 8)}.sock`);
    await vi.waitFor(() => expect(existsSync(path)).toBe(true));
    await answer(path, reply(join(d, "c.sock"), "pong"));
    await vi.waitFor(() =>
      expect(seen.map((x) => x.content).join("\n")).toMatch(
        /Information: your reply to alice was not sent/,
      ),
    );
    expect(seen.map((x) => x.content).join("\n")).not.toContain("pong");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("send")).toEqual([]);
  });
});

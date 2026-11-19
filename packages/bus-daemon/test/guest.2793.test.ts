// #2793 S3b: a Claude Code session homed on one instance joins a second one as
// a GUEST only after it used that instance's tools. Two or three fake hubs, a
// Claude session file per session, a real settings file (the instance's MCP
// entry, found by address) and real transcript files. Waits are signals (a
// frame arriving), never sleeps.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof, daemonStatus } from "@oa/bus-ipc";
import { BUS_CAPS, PING, PONG } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { daemonHarness, stopAll, wsServer } from "./helpers.ts";

afterEach(stopAll);

const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
const TOKEN_C = `oa_machine_${"c".repeat(28)}9d1e`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const M = (c: string) => c.repeat(16);

async function fakeHub() {
  const { wss, url } = await wsServer();
  const raw: string[] = [];
  let sock: WebSocket | undefined;
  wss.on("connection", (ws) => {
    sock = ws;
    ws.on("message", (d) => {
      const text = String(d);
      if (text === PING) ws.send(PONG);
      else raw.push(text);
    });
  });
  const frames = () =>
    raw.map((t) => JSON.parse(t) as { type: string; [k: string]: unknown });
  return {
    origin: url.replace(/\/hub$/, ""),
    raw,
    of: (type: string) => frames().filter((f) => f.type === type),
    send: (f: object) =>
      (sock as WebSocket).send(JSON.stringify({ v: 1, ...f })),
    sendRaw: (text: string) => (sock as WebSocket).send(text),
    close: (code: number) => (sock as WebSocket).close(code),
  };
}
type Hub = Awaited<ReturnType<typeof fakeHub>>;

const GUEST_CAPS = [
  BUS_CAPS.ids,
  BUS_CAPS.link,
  BUS_CAPS.guest,
  BUS_CAPS.noticeMeta,
];
const helloOk = (caps: string[] = GUEST_CAPS) => ({
  id: "w",
  type: "hello_ok",
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1.2.0",
  caps,
});

const sessionFile = (dir: string, pid: number, id: string, cwd: string) =>
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: id,
      procStart: "t0",
      name: `name-${id}`,
      messagingSocketPath: "",
      cwd,
    }),
  );

const toolUse = (name: string) =>
  `${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name, input: {} }],
    },
  })}\n`;

type Opts = {
  instances?: string[];
  homeLookup?: (cwd: string) => { instance: string };
  ratePerMin?: number;
  files?: { links: string; guests: string };
  existing?: {
    home: string;
    sessions: string;
    projects: string;
    config: string;
    hubs: Hub[];
  };
  caps?: string[];
};

async function setup(o: Opts = {}) {
  const names = o.instances ?? ["b"];
  const hubs =
    o.existing?.hubs ?? (await Promise.all(names.map(() => fakeHub())));
  const home = o.existing?.home ?? mkdtempSync(join(tmpdir(), "ob-2793-g-"));
  mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
  names.forEach((n, i) => {
    writeFileSync(
      join(home, "instances", `${n}.json`),
      JSON.stringify({
        name: n,
        hub: (hubs[i] as Hub).origin,
        machine_id: "",
        label: "laptop",
        machine_token: n === "b" ? TOKEN_B : TOKEN_C,
      }),
      { mode: 0o600 },
    );
  });
  const sessions =
    o.existing?.sessions ?? mkdtempSync(join(tmpdir(), "ob-g-s-"));
  const projects =
    o.existing?.projects ?? mkdtempSync(join(tmpdir(), "ob-g-p-"));
  const config =
    o.existing?.config ??
    join(mkdtempSync(join(tmpdir(), "ob-g-c-")), ".claude.json");
  // Claude's settings: one entry per instance, found by address.
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        names.map((n, i) => [
          `oa-${n}`,
          { type: "http", url: `${(hubs[i] as Hub).origin}/mcp` },
        ]),
      ),
    }),
  );
  const tmp = mkdtempSync(join(tmpdir(), "ob-g-f-"));
  const files = o.files ?? {
    links: join(tmp, "claude-links.json"),
    guests: join(tmp, "claude-guests.json"),
  };
  if (!o.existing) {
    sessionFile(sessions, 4242, "sa", "/a/proj");
    sessionFile(sessions, 4545, "sc", "/a/other");
    sessionFile(sessions, 4343, "sb", "/b/proj");
  }
  const gone = new Set<number>();
  const told: { pid: number; ref: string; text: string }[] = [];
  const logs: string[] = [];
  const h = await daemonHarness({
    instancesHome: home,
    homeLookup:
      o.homeLookup ??
      ((cwd) =>
        cwd.startsWith("/b/") ? { instance: "b" } : { instance: "main" }),
    log: (m) => {
      logs.push(m);
      if (process.env.G_DEBUG) console.error(m);
    },
    notifiers: {
      "claude-code": async (agent, text) => {
        told.push({ pid: agent.pid, ref: agent.ref, text });
        return true;
      },
    },
    claude: {
      sessionsDir: sessions,
      socketsDir: join(sessions, "r"),
      linksFile: files.links,
      guestsFile: files.guests,
      projectsDir: projects,
      mcpConfigFile: config,
      syncMs: 20,
      procStart: () => "t0",
      isRunning: (pid) => !gone.has(pid),
      ...(o.ratePerMin === undefined ? {} : { guestRatePerMin: o.ratePerMin }),
    },
    transports: { "claude-code": async () => ({ ok: true }) },
  });
  for (const n of names)
    await vi.waitFor(() => expect(h.daemon.hubs.get(n)?.open).toBe(true));
  h.toDaemon(helloOk(o.caps));
  for (const hub of hubs) hub.send(helloOk(o.caps));
  // Only B has a session homed on it.
  await vi.waitFor(() =>
    expect((hubs[0] as Hub).of("agent_up").length).toBeGreaterThan(0),
  );
  return {
    h,
    hubs,
    hubB: hubs[0] as Hub,
    home,
    sessions,
    projects,
    config,
    files,
    told,
    logs,
    gone,
  };
}
type Scene = Awaited<ReturnType<typeof setup>>;

/** The transcript of session `sa` (homed on main, cwd /a/proj). */
const transcript = (s: Scene, id = "sa") => {
  const dir = join(s.projects, "-a-proj");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}.jsonl`);
};

const proof = (
  h: { socketPath: string },
  pid: number,
  hash: string,
  instance?: string,
) =>
  daemonLinkProof({
    path: h.socketPath,
    pid,
    hash,
    ...(instance === undefined ? {} : { instance }),
  });

let uid = 0;
const nextId = () =>
  String(++uid)
    .split("")
    .map((d) => "abcdefghij"[Number(d)])
    .join("")
    .padStart(16, "k");

/** A round trip on every link: a delivery to a session homed there is acked, so earlier frames were read. */
async function settled(s: Scene) {
  const probe = (
    send: (f: object) => void,
    to_ref: string,
    count: () => number,
  ) => {
    const before = count();
    send({
      id: `dz${uid}`,
      type: "deliver",
      msg_id: nextId(),
      to_ref,
      from_name: "peer",
      namespace: "ns",
      body: "x",
    });
    return vi.waitFor(() => expect(count()).toBeGreaterThan(before));
  };
  await probe(
    (f) => s.h.toDaemon(f),
    "sa",
    () => s.h.of("ack").length,
  );
  for (const [i, hub] of s.hubs.entries())
    if (i === 0)
      await probe(
        (f) => hub.send(f),
        "sb",
        () => hub.of("ack").length,
      );
}

/** Session sa holds a B proof (homed on main) and has called B's tools. */
async function holdAndUse(s: Scene, hash = HASH_B) {
  expect(await proof(s.h, 4242, hash, "b")).toBe(false);
  appendFileSync(transcript(s), toolUse("mcp__oa-b__publish_artifact"));
}

const seenB = (s: Scene, hash = HASH_B) =>
  s.hubB.send({ id: "ps", type: "proof_seen", hash });

describe("a guest joins only after using the instance's tools (#2793 S3b)", () => {
  it("registers the session as a guest on B (name and kind only), binds the hash on B, and tells home nothing", async () => {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    const up = s.hubB.of("guest_up")[0] as Record<string, unknown>;
    expect(Object.keys(up).sort()).toEqual([
      "agent_ref",
      "id",
      "kind",
      "proposed_name",
      "type",
      "v",
    ]);
    expect(up).toMatchObject({
      agent_ref: "guest:sa",
      kind: "claude-code",
      proposed_name: "name-sa",
    });
    await vi.waitFor(() => expect(s.hubB.of("link_bind")).toHaveLength(1));
    expect(s.hubB.of("link_bind")[0]).toMatchObject({
      agent_ref: "guest:sa",
      hash: HASH_B,
    });
    await settled(s);
    // Nothing of the guest, its folder or its hash went to main.
    expect(s.h.raw.join("\n")).not.toContain(HASH_B);
    expect(s.h.raw.join("\n")).not.toContain("guest:");
    expect(s.h.raw.join("\n")).not.toContain("guest_");
    // B was never told the folder, address, namespace, global flag or roles.
    const bSaw = s.hubB.raw.filter((t) => t.includes("guest_up")).join("");
    for (const k of ["namespace", "global", "cwd", "/a/proj", "roles"])
      expect(bSaw).not.toContain(k);
    expect(JSON.parse(readFileSync(s.files.guests, "utf8"))).toEqual({
      v: 1,
      guests: [{ pid: 4242, procStart: "t0", instance: "b" }],
    });
  });

  it("oa-bus status lists the guest sessions per instance, by the name B gave", async () => {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    const up = s.hubB.of("guest_up")[0] as unknown as { id: string };
    const rows = async () =>
      (await daemonStatus({ path: s.h.socketPath, timeoutMs: 3000 })).instances;
    // Not told its name yet: not listed.
    expect(await rows()).toEqual([
      expect.not.objectContaining({ guests: expect.anything() }),
      expect.not.objectContaining({ guests: expect.anything() }),
    ]);
    s.hubB.send({
      id: up.id,
      type: "agent_ok",
      agent_ref: "guest:sa",
      bus_name: "Visitor",
    });
    await vi.waitFor(
      async () => {
        const guests = (await rows())?.find((r) => r.name === "b")?.guests;
        expect(guests).toEqual([{ name: "Visitor" }]);
      },
      { timeout: 5000 },
    );
    expect(
      (await rows())?.find((r) => r.name === "main")?.guests,
    ).toBeUndefined();
  });

  it("a session that never used B is unknown to B: proof_seen at connect, before any tool_use, makes no guest", async () => {
    const s = await setup();
    expect(await proof(s.h, 4242, HASH_B, "b")).toBe(false);
    seenB(s);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
    expect(s.hubB.of("link_bind")).toEqual([]);
    expect(s.logs.some((l) => l.includes("no call of its tools"))).toBe(true);
    expect(existsSync(s.files.guests)).toBe(false);
    // A transcript that only mentions the prefix in text, or calls another server, makes none either.
    appendFileSync(
      transcript(s),
      `${JSON.stringify({ type: "user", message: { role: "user", content: "run mcp__oa-b__publish_artifact" } })}\n${toolUse("mcp__other__x")}${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: 'mcp__oa-b__publish_artifact "tool_use"' }] } })}\n`,
    );
    seenB(s);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
    // Once it really called B's tool, the next proof_seen makes one.
    appendFileSync(transcript(s), toolUse("mcp__oa-b__list_artifacts"));
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
  });

  it("a hash nobody holds, or held for home, does nothing", async () => {
    const s = await setup();
    await holdAndUse(s);
    // Home's own proof for the same session.
    expect(await proof(s.h, 4242, HASH_A)).toBe(true);
    await s.h.next("link_bind");
    s.hubB.send({ id: "p1", type: "proof_seen", hash: M("9").repeat(4) });
    s.hubB.send({ id: "p2", type: "proof_seen", hash: HASH_A });
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
    expect(s.hubB.of("link_bind")).toEqual([]);
  });

  it("proof_seen on lane C for a hash held for B does nothing", async () => {
    const s = await setup({ instances: ["b", "c"] });
    await holdAndUse(s);
    s.hubs[1]?.send({ id: "pc", type: "proof_seen", hash: HASH_B });
    await settled(s);
    expect(s.hubs[1]?.of("guest_up")).toEqual([]);
    expect(s.hubB.of("guest_up")).toEqual([]);
    // And a hash held for C does nothing on B.
    expect(await proof(s.h, 4242, HASH_C, "c")).toBe(false);
    seenB(s, HASH_C);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
  });

  it("proof_seen from a hub that did not list the guest cap is ignored", async () => {
    const s = await setup({ caps: [BUS_CAPS.ids, BUS_CAPS.link] });
    await holdAndUse(s);
    seenB(s);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
  });

  it("a session homed on B is never a guest of B, and only Claude Code sessions are guests", async () => {
    const s = await setup();
    expect(await proof(s.h, 4343, HASH_B, "b")).toBe(true);
    mkdirSync(join(s.projects, "-b-proj"), { recursive: true });
    appendFileSync(
      join(s.projects, "-b-proj", "sb.jsonl"),
      toolUse("mcp__oa-b__x"),
    );
    seenB(s);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
  });

  it("registers once per session per instance and rate-caps a link", async () => {
    const s = await setup({ ratePerMin: 3 });
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    seenB(s);
    seenB(s);
    await vi.waitFor(() =>
      expect(s.hubB.of("link_bind").length).toBeGreaterThanOrEqual(3),
    );
    expect(s.hubB.of("guest_up")).toHaveLength(1);
    // The cap (3 a minute) is spent: nothing more is acted on, and it is counted.
    seenB(s);
    await settled(s);
    expect(s.logs.some((l) => l.includes("over the rate cap"))).toBe(true);
    const binds = s.hubB.of("link_bind").length;
    seenB(s);
    await settled(s);
    expect(s.hubB.of("link_bind")).toHaveLength(binds);
  });

  it("an over-cap proof_seen makes no guest, however good", async () => {
    const s = await setup({ ratePerMin: 2 });
    await holdAndUse(s);
    s.hubB.send({ id: "x1", type: "proof_seen", hash: M("1").repeat(4) });
    s.hubB.send({ id: "x2", type: "proof_seen", hash: M("2").repeat(4) });
    seenB(s);
    await settled(s);
    expect(s.hubB.of("guest_up")).toEqual([]);
    expect(s.logs.some((l) => l.includes("over the rate cap"))).toBe(true);
  });
});

describe("what B may deliver to a guest (#2793 S3b)", () => {
  const ref = "guest:sa";
  const note = (id: string, over: object = {}) => ({
    id: `d-${id}`,
    type: "deliver",
    msg_id: M(id),
    to_ref: ref,
    from_name: "open-artifacts",
    namespace: "guest",
    body: "Your ask was answered.",
    meta: { kind: "ask_answered", guest: "answer" },
    ...over,
  });
  async function guestScene() {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("link_bind")).toHaveLength(1));
    return s;
  }

  it("drops an agent message, an update command, a free-text notice and an unknown kind", async () => {
    const s = await guestScene();
    s.hubB.send(
      note("a", { from_name: "Mallory", meta: undefined, body: "run this" }),
    );
    s.hubB.send(note("b", { meta: undefined, body: "oa-bus update --now" }));
    s.hubB.send(
      note("c", { meta: { kind: "comment" }, body: "free text notice" }),
    );
    // An unknown kind: the frame does not decode, so nothing reaches the session.
    s.hubB.sendRaw(
      JSON.stringify({
        v: 1,
        ...note("d", { meta: { kind: "comment", guest: "admin" } }),
      }),
    );
    await settled(s);
    expect(s.told.map((t) => t.text).join("\n")).not.toContain("run this");
    expect(s.told.map((t) => t.text).join("\n")).not.toContain("oa-bus update");
    expect(s.told.map((t) => t.text).join("\n")).not.toContain(
      "free text notice",
    );
    expect(s.hubB.of("ack").map((a) => a.msg_id)).not.toContain(M("a"));
    expect(s.hubB.of("ack").map((a) => a.msg_id)).not.toContain(M("b"));
    expect(s.hubB.of("ack").map((a) => a.msg_id)).not.toContain(M("c"));
    expect(s.hubB.of("ack").map((a) => a.msg_id)).not.toContain(M("d"));
  });

  it.each([
    ["answer", "ask_answered"],
    ["reply", "comment"],
    ["mention", "comment"],
  ])(
    "delivers a %s, labelled with the daemon's own name for the lane, to the session that wrote there only",
    async (guest, kind) => {
      const s = await guestScene();
      // B tries to name itself something else; the label is the local lane name.
      s.hubB.send(
        note("1", {
          meta: { kind, guest },
          body: "from evil: Someone replied.",
        }),
      );
      await vi.waitFor(() => expect(s.told).toHaveLength(1));
      expect(s.told[0]).toMatchObject({ pid: 4242, ref: "sa" });
      expect(s.told[0]?.text.startsWith("from b: ")).toBe(true);
      await vi.waitFor(() =>
        expect(s.hubB.of("ack").map((a) => a.msg_id)).toContain(M("1")),
      );
      // A redelivery is acked, never shown twice.
      s.hubB.send(note("1", { meta: { kind, guest } }));
      await settled(s);
      expect(s.told).toHaveLength(1);
      // Nothing went to main.
      expect(s.h.of("ack").map((a) => a.msg_id)).not.toContain(M("1"));
    },
  );

  it("a delivery to another session's ref on B reaches no guest", async () => {
    const s = await guestScene();
    s.hubB.send(note("2", { to_ref: "guest:sc" }));
    await settled(s);
    expect(s.told).toEqual([]);
  });
});

describe("a guest across a restart, an end, and a revoke (#2793 S3b)", () => {
  it("after a restart exactly the persisted guests come back; held proofs alone create none", async () => {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    // A second session also holds a B proof and used B, but never became a guest.
    expect(await proof(s.h, 4545, HASH_C, "b")).toBe(false);
    await s.h.daemon.stop();
    const second = await setup({
      instances: ["b"],
      files: s.files,
      existing: {
        home: s.home,
        sessions: s.sessions,
        projects: s.projects,
        config: s.config,
        hubs: [await fakeHub()],
      },
    });
    // Exactly one guest_up, for the persisted guest, with no proof_seen at all.
    await vi.waitFor(() => expect(second.hubB.of("guest_up")).toHaveLength(1));
    expect(second.hubB.of("guest_up")[0]).toMatchObject({
      agent_ref: "guest:sa",
    });
    await settled(second);
    expect(second.hubB.of("guest_up")).toHaveLength(1);
    expect(second.hubB.of("link_bind")).toEqual([]);
    // The held hash of the second session is still held, and made no guest.
    expect(
      JSON.parse(readFileSync(s.files.links, "utf8")).links.length,
    ).toBeGreaterThan(0);
  });

  it("held proofs alone create no guest after a restart", async () => {
    const files = {
      links: join(mkdtempSync(join(tmpdir(), "ob-g-l-")), "claude-links.json"),
      guests: join(
        mkdtempSync(join(tmpdir(), "ob-g-g-")),
        "claude-guests.json",
      ),
    };
    const first = await setup({ files });
    await holdAndUse(first);
    await vi.waitFor(() =>
      expect(readFileSync(files.links, "utf8")).toContain(HASH_B),
    );
    await first.h.daemon.stop();
    expect(existsSync(files.guests)).toBe(false);
    const second = await setup({
      files,
      existing: {
        home: first.home,
        sessions: first.sessions,
        projects: first.projects,
        config: first.config,
        hubs: [await fakeHub()],
      },
    });
    await settled(second);
    // Several sync ticks later: still none.
    await new Promise((r) => setTimeout(r, 120));
    expect(second.hubB.of("guest_up")).toEqual([]);
    expect(existsSync(files.guests)).toBe(false);
  });

  it("a guest ends when its session ends: B is told, and the file forgets it", async () => {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    // The process is gone (a different start time, as a reused pid would show).
    s.gone.add(4242);
    await vi.waitFor(() => expect(s.hubB.of("guest_down")).toHaveLength(1));
    expect(s.hubB.of("guest_down")[0]).toMatchObject({ agent_ref: "guest:sa" });
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(s.files.guests, "utf8")).guests).toEqual(
        [],
      ),
    );
  });

  it("a revoke on B drops B's guests and B's lane, and leaves home connected", async () => {
    const s = await setup();
    await holdAndUse(s);
    seenB(s);
    await vi.waitFor(() => expect(s.hubB.of("guest_up")).toHaveLength(1));
    s.hubB.close(4403);
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(s.files.guests, "utf8")).guests).toEqual(
        [],
      ),
    );
    expect(s.h.daemon.hubs.get("b")?.open).toBe(false);
    expect(s.h.daemon.hub.open).toBe(true);
    // Home still delivers to the session.
    s.h.toDaemon({
      id: "dh",
      type: "deliver",
      msg_id: M("h"),
      to_ref: "sa",
      from_name: "peer",
      namespace: "ns",
      body: "hi",
    });
    await vi.waitFor(() => expect(s.h.of("ack")).toHaveLength(1));
  });
});

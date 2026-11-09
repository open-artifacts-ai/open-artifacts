// A /clear in Claude Code (#1295): the same process reports a new session id.
// The daemon tells a mailbox hub the new ref replaces the old one, so the
// address and its mail carry over; a session in another process, or a hub
// without the cap, never gets `replaces`.
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  os.start = "t0";
  await stopAll();
});

const write = (
  d: string,
  pid: number,
  sessionId: string,
  name: string,
  procStart = "t0",
) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart,
      name,
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

type Harness = Awaited<ReturnType<typeof daemonHarness>>;
/** The agent_up the daemon sent for `ref`, once it has. */
const upFor = async (h: Harness, ref: string) => {
  await vi.waitFor(() =>
    expect(h.of("agent_up").some((u) => u.agent_ref === ref)).toBe(true),
  );
  return h
    .of("agent_up")
    .filter((u) => u.agent_ref === ref)
    .at(-1) as Extract<ReturnType<Harness["of"]>[number], { type: "agent_up" }>;
};

/** What the OS reports as every pid's start time. */
const os = { start: "t0" };

/** A daemon whose hub speaks mailbox, with no session file yet; admits go through `attest` as pid 4242. */
async function bare() {
  const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
  const h = await daemonHarness({
    attest: () => ({ ok: true, cwd: "/repo", pid: 4242 }),
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => os.start,
      isRunning: () => true,
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  await h.adapter("s-old", {
    kind: "claude-code",
    cwd: "/repo",
    pid: 4242,
    proposed_name: "npm-test",
  });
  await upFor(h, "s-old");
  return { h, d };
}

/** Resolves once the daemon has told the hub `ref` is closed. */
const closedRef = (h: Harness, ref: string) =>
  vi.waitFor(() =>
    expect(h.of("sessions").some((f) => f.closed.includes(ref))).toBe(true),
  );

async function start(hubCaps: string[] | undefined) {
  const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
  write(d, 4242, "s-old", "npm-test");
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => os.start,
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
  await upFor(h, "s-old");
  return { h, d };
}

describe("/clear handover in the daemon", () => {
  it("says hello with the ids and mailbox caps", async () => {
    const { h } = await start(undefined);
    expect(h.of("hello")[0]?.caps).toEqual([
      BUS_CAPS.ids,
      BUS_CAPS.mailbox,
      BUS_CAPS.links,
      BUS_CAPS.follow,
    ]);
  });

  it("same pid, new session id: agent_up replaces the old ref and keeps its name", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 4242, "s-new", "fresh-name");
    const up = await upFor(h, "s-new");
    expect(up).toMatchObject({
      agent_ref: "s-new",
      replaces: "s-old",
      proposed_name: "npm-test",
    });
  });

  it("a different pid is another agent: no replaces", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 5555, "s-other", "other");
    const up = await upFor(h, "s-other");
    expect(up).toMatchObject({ agent_ref: "s-other", proposed_name: "other" });
    expect(up).not.toHaveProperty("replaces");
  });

  it("a hub that did not list mailbox never sees replaces", async () => {
    const { h, d } = await start([BUS_CAPS.ids]);
    write(d, 4242, "s-new", "npm-test");
    const up = await upFor(h, "s-new");
    expect(up).toMatchObject({ agent_ref: "s-new" });
    expect(up).not.toHaveProperty("replaces");
  });

  it("a reused pid (another process start) is not a /clear: no replaces, its own name", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    os.start = "t1";
    write(d, 4242, "s-reuse", "reused", "t1");
    const up = await upFor(h, "s-reuse");
    expect(up).toMatchObject({ proposed_name: "reused" });
    expect(up).not.toHaveProperty("replaces");
  });

  it("after the link drops, a handover waits for hello_ok: no agent_up without replaces", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 4242, "s-new", "x");
    expect(await upFor(h, "s-new")).toHaveProperty("replaces", "s-old");
    // Another live session, listed after s-new: its replay marks the end of the replay.
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    const before = h.of("agent_up").length;
    h.hubSock()?.close();
    // The daemon reconnects and replays; the fake hub has not said hello_ok.
    await vi.waitFor(() =>
      expect(
        h
          .of("agent_up")
          .slice(before)
          .some((u) => u.agent_ref === "s-mark"),
      ).toBe(true),
    );
    for (const u of h.of("agent_up").slice(before)) {
      expect(u.agent_ref).not.toBe("s-new");
      expect(u).not.toHaveProperty("replaces");
    }
    // hello_ok arrives: the handover goes out whole.
    h.toDaemon({
      id: "w2",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });
    await vi.waitFor(() =>
      expect(
        h
          .of("agent_up")
          .slice(before)
          .some((u) => u.agent_ref === "s-new" && u.replaces === "s-old"),
      ).toBe(true),
    );
  });

  it("a /clear seen by the sync tick before hello_ok is held, then sent with replaces (#1582)", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
    write(d, 4242, "s-old", "npm-test");
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => os.start,
        isRunning: () => true,
      },
    });
    // The link is open and has said no hello_ok yet.
    await upFor(h, "s-old");
    write(d, 4242, "s-new", "other");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    // Several ticks have run; s-new waited.
    await closedRef(h, "s-old");
    expect(h.of("agent_up").some((u) => u.agent_ref === "s-new")).toBe(false);
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });
    expect(await upFor(h, "s-new")).toMatchObject({
      replaces: "s-old",
      proposed_name: "npm-test",
    });
  });

  /** A daemon whose link is open but has said no hello_ok; s-old is up from its file. */
  async function unhelloed(attest = false) {
    const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
    write(d, 4242, "s-old", "npm-test");
    const h = await daemonHarness({
      ...(attest
        ? { attest: () => ({ ok: true as const, cwd: "/repo", pid: 4242 }) }
        : {}),
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => os.start,
        isRunning: () => true,
      },
    });
    await upFor(h, "s-old");
    return { h, d };
  }
  const helloOk = (h: Harness) =>
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });

  it("a second /clear while the first is held replaces the original, never the unannounced one (#1582)", async () => {
    const { h, d } = await unhelloed();
    write(d, 4242, "s-b", "b");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    write(d, 4242, "s-c", "c");
    write(d, 6666, "s-mark2", "mark2");
    await upFor(h, "s-mark2");
    helloOk(h);
    expect(await upFor(h, "s-c")).toMatchObject({
      replaces: "s-old",
      proposed_name: "npm-test",
    });
    expect(h.of("agent_up").some((u) => u.agent_ref === "s-b")).toBe(false);
  });

  it("a held session is not listed open in sessions before its agent_up (#1582)", async () => {
    const { h, d } = await unhelloed();
    write(d, 4242, "s-new", "other");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    await closedRef(h, "s-old");
    for (const f of h.of("sessions")) expect(f.open).not.toContain("s-new");
  });

  it("a send from a held session waits for its agent_up, then goes after it (#1582)", async () => {
    const { h, d } = await unhelloed(true);
    write(d, 4242, "s-new", "other");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    const a = await h.adapter("s-new", {
      kind: "claude-code",
      cwd: "/repo",
      pid: 4242,
    });
    void a.request({ type: "send", to: "peer", body: "hi" }).catch(() => {});
    // Let the daemon take the request in before the hub speaks.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("send")).toHaveLength(0);
    helloOk(h);
    await h.next("send");
    const kinds = h.frames.map((f) =>
      f.type === "agent_up" && f.agent_ref === "s-new"
        ? "up-new"
        : f.type === "send"
          ? "send"
          : "",
    );
    expect(kinds.indexOf("up-new")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("up-new")).toBeLessThan(kinds.indexOf("send"));
  });

  it("a hub without mailbox: a handover held for hello_ok is sent without replaces", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
    write(d, 4242, "s-old", "npm-test");
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => os.start,
        isRunning: () => true,
      },
    });
    await upFor(h, "s-old");
    write(d, 4242, "s-new", "other");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids],
    });
    const up = await upFor(h, "s-new");
    expect(up).not.toHaveProperty("replaces");
  });

  it("admitted before its session file exists, a session still hands over on a /clear", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
    const h = await daemonHarness({
      attest: () => ({ ok: true, cwd: "/repo", pid: 4242 }),
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => os.start,
        isRunning: () => true,
      },
    });
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });
    await h.adapter("s-old", {
      kind: "claude-code",
      cwd: "/repo",
      pid: 4242,
      proposed_name: "npm-test",
    });
    await upFor(h, "s-old");
    // The session file appears; a marker session in the same sync tick tells
    // us the tick (and so the backfill of s-old) has run.
    write(d, 4242, "s-old", "npm-test");
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    write(d, 4242, "s-new", "other");
    const up = await upFor(h, "s-new");
    expect(up).toMatchObject({ replaces: "s-old", proposed_name: "npm-test" });
  });

  it("the tick closed the old session before the new one appeared (its file was briefly gone): still a handover", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    unlinkSync(join(d, "4242.json"));
    await closedRef(h, "s-old");
    write(d, 4242, "s-new", "other");
    expect(await upFor(h, "s-new")).toMatchObject({
      replaces: "s-old",
      proposed_name: "npm-test",
    });
  });

  it("closed by a tick before its process start was known: a later file still backfills it", async () => {
    const { h, d } = await bare();
    // Only another session's file exists: the tick closes s-old, which has no procStart yet.
    write(d, 5555, "s-mark", "mark");
    await upFor(h, "s-mark");
    await closedRef(h, "s-old");
    // Its file appears (the same process), then a marker so the tick has run.
    write(d, 4242, "s-old", "npm-test");
    write(d, 6666, "s-mark2", "mark2");
    await upFor(h, "s-mark2");
    write(d, 4242, "s-new", "other");
    expect(await upFor(h, "s-new")).toMatchObject({
      replaces: "s-old",
      proposed_name: "npm-test",
    });
  });

  it("repeated clears in one process: C replaces B, never A", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 4242, "s-b", "b");
    expect(await upFor(h, "s-b")).toMatchObject({ replaces: "s-old" });
    // Let the tick that closes A run before the next clear.
    await closedRef(h, "s-old");
    write(d, 4242, "s-c", "c");
    expect(await upFor(h, "s-c")).toMatchObject({
      replaces: "s-b",
      proposed_name: "npm-test",
    });
  });

  it("/resume of a session this daemon already knows is not a takeover of the current one", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    // s-x ran in another process, then ended.
    write(d, 7777, "s-x", "x-name");
    await upFor(h, "s-x");
    unlinkSync(join(d, "7777.json"));
    await closedRef(h, "s-x");
    const before = h.of("agent_up").filter((u) => u.agent_ref === "s-x").length;
    // This process (4242, running s-old) resumes s-x.
    write(d, 4242, "s-x", "x-name");
    await vi.waitFor(() =>
      expect(
        h.of("agent_up").filter((u) => u.agent_ref === "s-x").length,
      ).toBeGreaterThan(before),
    );
    const up = await upFor(h, "s-x");
    expect(up).toMatchObject({ proposed_name: "x-name" });
    expect(up).not.toHaveProperty("replaces");
    // Then a /clear in that process hands s-x's address on, not s-old's.
    write(d, 4242, "s-y", "y");
    expect(await upFor(h, "s-y")).toMatchObject({ replaces: "s-x" });
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/agents.ts";
import { HeldStore } from "../src/transports/held.ts";
import { OpenCodeTransport, type Spawn } from "../src/transports/opencode.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(stopAll);

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const agent: AgentRecord = {
  ref: "ses_root",
  kind: "opencode",
  proposedName: "a",
  busName: "a",
  namespace: "ns",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
};
const mail = {
  msg_id: "mmmmmmmmmmmmmmm1",
  from_name: "peer",
  namespace: "ns",
  body: "hello",
};
const timesOut: Spawn = async () => ({ code: null, stdout: "", stderr: "" });

function transport(spawn: Spawn, promptIdSupported: boolean, file?: string) {
  const s = vi.fn(spawn);
  const t = new OpenCodeTransport({
    openSessions: () => new Set(["ses_root"]),
    spawn: s,
    promptIdSupported,
    uncertain: new HeldStore(file ?? join(tmp("ob-un-"), "u.json")),
  });
  return { t, spawn: s };
}

describe("opencode below the prompt-id floor", () => {
  it("never retries a timed-out prompt: the redelivery is refused expired", async () => {
    const { t, spawn } = transport(timesOut, false);
    expect(await t.deliver(agent, mail)).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await t.deliver(agent, mail)).toEqual({
      ok: false,
      reason: "closed",
      cause: "expired",
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("remembers the uncertain prompt across a daemon restart", async () => {
    const file = join(tmp("ob-un-"), "u.json");
    await transport(timesOut, false, file).t.deliver(agent, mail);
    const { t, spawn } = transport(timesOut, false, file);
    expect(await t.deliver(agent, mail)).toMatchObject({ cause: "expired" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still retries a prompt that failed without timing out", async () => {
    let n = 0;
    const { t, spawn } = transport(async () => {
      n++;
      return n === 1
        ? { code: 1, stdout: "", stderr: "500 boom" }
        : { code: 0, stdout: "{}", stderr: "" };
    }, false);
    expect(await t.deliver(agent, mail)).toMatchObject({ reason: "timeout" });
    expect(await t.deliver(agent, mail)).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not re-tell a notice whose prompt timed out", async () => {
    const { t, spawn } = transport(timesOut, false);
    expect(await t.notify(agent, "x", "mmmmmmmmmmmmmmm1")).toBe(false);
    // Told once, maybe: never a second copy.
    expect(await t.notify(agent, "x", "mmmmmmmmmmmmmmm1")).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("retries a timed-out prompt at or above the floor", async () => {
    const { t, spawn } = transport(timesOut, true);
    await t.deliver(agent, mail);
    await t.deliver(agent, mail);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("runDaemon reads the OpenCode version once", () => {
  async function harness(version: string | undefined, spawn: Spawn) {
    const dir = tmp("ob-ot-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "4321.json"),
      JSON.stringify({ pid: 4321, sessionIDs: ["ses_root"] }),
    );
    const readVersion = vi.fn(async () => version);
    const s = vi.fn(spawn);
    const h = await daemonHarness({
      claude: { syncMs: 3_600_000 },
      opencode: {
        presenceDir: dir,
        spawn: s,
        isRunning: () => true,
        procStart: () => null,
        version: readVersion,
        uncertainFile: join(tmp("ob-un-"), "u.json"),
      },
    });
    await h.adapter("ses_root", { kind: "opencode" });
    return { h, spawn: s, readVersion };
  }

  it("below 2.0.0: timeout, then the redelivery is refused expired", async () => {
    const { h, spawn, readVersion } = await harness("1.9.4", timesOut);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      reason: "closed",
      detail: "expired",
    });
    expect(spawn).toHaveBeenCalledOnce();
    expect(h.of("ack")).toHaveLength(0);
    expect(readVersion).toHaveBeenCalledOnce();
  });

  it("an unreadable version is treated as below the floor", async () => {
    const { h, spawn } = await harness(undefined, timesOut);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    expect(await h.next("refuse")).toMatchObject({ detail: "expired" });
  });
});

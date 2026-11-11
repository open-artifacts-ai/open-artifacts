import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_REFUSALS, createEventLog } from "../src/index.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(stopAll);

describe("the daemon event log (#2029)", () => {
  it("writes a Codex refusal with its key, and never a message body", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ob-ev-")), "events.log");
    const events = createEventLog(file);
    const h = await daemonHarness({
      events,
      attest: (hello) =>
        hello.kind === "codex"
          ? { ok: false, reason: CODEX_REFUSALS.subagent }
          : { ok: true },
    });
    await expect(
      h.adapter("CODEXREF1", { kind: "codex" }),
    ).rejects.toBeDefined();
    await h.adapter("A", { kind: "pi" });
    h.toDaemon({
      ...deliverFrame("mmmmmmmmmmmmmmm1"),
      body: "CANARY-BODY-TEXT",
    });
    await new Promise((r) => setTimeout(r, 100));
    await events.flush();
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(
      / codex_refused kind=codex ref=CODEXREF1 reason=subagent\n/,
    );
    expect(text).toMatch(/ daemon_start /);
    expect(text).toMatch(/ agent_join kind=pi /);
    expect(text).not.toMatch(/CANARY|body|SECRET/);
  });
  it("stop() waits for the log to flush, so daemon_stop is written", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ob-ev-")), "events.log");
    const events = createEventLog(file);
    const h = await daemonHarness({ events });
    await h.daemon.stop();
    expect(readFileSync(file, "utf8")).toMatch(/ daemon_stop /);
  });
  it("logs one agent_join for a Claude session the sync found", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-evc-"));
    const file = join(d, "events.log");
    const events = createEventLog(file);
    writeFileSync(
      join(d, "4242.json"),
      JSON.stringify({
        pid: 4242,
        sessionId: "s4242",
        procStart: "t0",
        name: "found",
        cwd: "/repo",
      }),
    );
    const h = await daemonHarness({
      events,
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
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
    });
    await h.next("agent_up");
    await events.flush();
    const joins = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes(" agent_join "));
    expect(joins).toHaveLength(1);
    expect(joins[0]).toContain("kind=claude-code");
  });
});

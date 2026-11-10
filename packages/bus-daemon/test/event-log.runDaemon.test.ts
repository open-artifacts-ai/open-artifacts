import { mkdtempSync, readFileSync } from "node:fs";
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
});

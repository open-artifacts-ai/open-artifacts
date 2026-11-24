// #3043: every session is told the bus's habits at start. One source: the
// daemon answers the rules, and nothing when the install opted out, so an
// adapter or extension never carries its own copy.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { habitsOff } from "@oa/bus-ipc";
import { BRIEF_RULES } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const install = (dir: string, habits: unknown) =>
  writeFileSync(join(dir, "install.json"), JSON.stringify({ habits }), {
    mode: 0o600,
  });

describe("the habits a session is told (#3043)", () => {
  it("the daemon answers the brief rules", async () => {
    const h = await daemonHarness();
    const a = await h.adapter("A");
    const r = await a.request({ type: "habits" });
    expect(r.type).toBe("habits");
    expect(r.type === "habits" && r.rules).toBe(BRIEF_RULES);
  });

  it("answers none when the install opted out", async () => {
    const h = await daemonHarness({ habitsOff: () => true });
    const a = await h.adapter("A");
    const r = await a.request({ type: "habits" });
    expect(r.type === "habits" && r.rules).toBeNull();
  });

  it("reads the opt-out from install.json, and silence means on", () => {
    const on = mkdtempSync(join(tmpdir(), "ob-h-on-"));
    expect(habitsOff(on)).toBe(false);
    install(on, { optedOut: true });
    expect(habitsOff(on)).toBe(true);
    const off = mkdtempSync(join(tmpdir(), "ob-h-off-"));
    install(off, { optedOut: false });
    expect(habitsOff(off)).toBe(false);
  });
});

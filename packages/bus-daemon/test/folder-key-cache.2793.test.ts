// #2793 S6: a folder's key runs `git rev-parse`; the daemon does it once per
// folder, not once per hello.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

const gitCalls: string[][] = [];
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: ((cmd: string, args: string[], ...rest: unknown[]) => {
      if (cmd === "git" && args.includes("--show-toplevel"))
        gitCalls.push(args);
      return (real.execFileSync as (...a: unknown[]) => unknown)(
        cmd,
        args,
        ...rest,
      );
    }) as typeof real.execFileSync,
  };
});

afterEach(stopAll);

describe("folder key cache (#2793 S6)", () => {
  it("runs git once for a folder however many sessions say hello there", async () => {
    const home = mkdtempSync(join(tmpdir(), "ob-2793-fk-"));
    mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "instances", "b.json"),
      JSON.stringify({
        name: "b",
        hub: "http://127.0.0.1:9",
        machine_id: "",
        label: "l",
        machine_token: `oa_machine_${"b".repeat(28)}7f3a`,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        hub: "http://127.0.0.1:8",
        machine_id: "m1",
        label: "l",
        machine_token: `oa_machine_${"a".repeat(28)}7f3a`,
      }),
      { mode: 0o600 },
    );
    const cwd = mkdtempSync(join(tmpdir(), "ob-2793-fk-cwd-"));
    const h = await daemonHarness({ instancesHome: home });
    gitCalls.length = 0;
    for (const ref of ["r1", "r2", "r3"]) await h.adapter(ref, { cwd });
    const mine = gitCalls.filter(
      (a) => a.includes(cwd) || a.some((x) => x.startsWith(cwd.slice(0, 20))),
    );
    expect(mine).toHaveLength(1);
    expect(h.daemon.agents.byRef("r3")).toBeDefined();
  });
});

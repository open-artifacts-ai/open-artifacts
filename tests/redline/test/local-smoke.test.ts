import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Cred, sessionCred, withCred } from "../src/http.ts";
import {
  groupMembers,
  ownChildren,
  startLocalPair,
} from "../src/local-pair.ts";
import { crossCheck } from "../src/refused.ts";
import { loadTargets, type Target } from "../src/targets.ts";

// Boots the real local pair (wrangler dev x2, redline build). Slow, so it runs
// only with REDLINE_LOCAL_SMOKE=1 (needs pnpm -F @oa/server run gen).
const on = process.env.REDLINE_LOCAL_SMOKE === "1";

describe.skipIf(!on)("local pair smoke", () => {
  it("boots two installs, refuses A's session at B, and tears down with nothing left", async () => {
    const pair = await startLocalPair();
    let left: number[] = [];
    try {
      expect(pair.installs.map((i) => i.testDomain)).toEqual([
        "oa-redline-a.fyi",
        "oa-redline-c.fyi",
      ]);
      const ports = new Set(pair.installs.map((i) => i.port));
      expect(ports.size).toBe(2);
      const T = await loadTargets({ REDLINE_TARGETS: pair.targets });
      const credA = await sessionCred(T.a);
      const credB = await sessionCred(T.b);
      const me = (cred: Cred, t: Target) =>
        new Request(`${t.app}/api/v1/me`, withCred(cred));
      await crossCheck(me, { a: T.a, b: T.b, credA, credB });
    } finally {
      left = await pair.stop();
    }
    expect(left).toEqual([]);
    expect(pair.spawned.length).toBeGreaterThanOrEqual(4);
    // Every group was confirmed empty and dropped from the live list.
    expect(pair.pids).toEqual([]);
    for (const p of pair.spawned) expect(groupMembers(p)).toEqual([]);
    const kids = ownChildren();
    for (const p of pair.spawned) expect(kids).not.toContain(p);
    expect(existsSync(pair.dir)).toBe(false);
    console.log(
      `smoke: spawned groups ${pair.spawned.join(" ")}; after teardown: group members ${pair.spawned.flatMap(groupMembers).join(" ") || "none"}, own children ${kids.join(" ") || "none"}`,
    );
  }, 300_000);

  it("SIGINT mid-boot stops what was spawned so far", async () => {
    const script = join(import.meta.dirname, "..", "scripts", "local-pair.ts");
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", script, "--", "sleep", "600"],
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(out).not.toContain("local-pair: rl-a app");
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) =>
      child.on("exit", (c) => r(c)),
    );
    expect(code).toBe(130);
    const m = /spawned groups ([\d ]+|none); left after teardown: (.+)/.exec(
      out,
    );
    expect(m?.[2]).toBe("none");
    const groups =
      m?.[1] === "none" ? [] : (m?.[1] ?? "").trim().split(" ").map(Number);
    for (const g of groups) expect(groupMembers(g)).toEqual([]);
    console.log(
      `sigint mid-boot: spawned groups ${groups.join(" ") || "none"}; left: none`,
    );
  }, 120_000);

  for (const [sig, want] of [
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)
    it(`${sig} to scripts/local-pair.ts stops every group it spawned`, async () => {
      const script = join(
        import.meta.dirname,
        "..",
        "scripts",
        "local-pair.ts",
      );
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", script, "--", "sleep", "600"],
        {
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        out += d;
      });
      const deadline = Date.now() + 240_000;
      while (!out.includes("local-pair: rl-a app") && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 250));
      expect(out).toContain("local-pair: rl-a app");
      child.kill(sig);
      const code = await new Promise<number | null>((r) =>
        child.on("exit", (c) => r(c)),
      );
      expect(code).toBe(want);
      const m = /spawned groups ([\d ]+); left after teardown: (.+)/.exec(out);
      expect(m?.[2]).toBe("none");
      const groups = (m?.[1] ?? "").trim().split(" ").map(Number);
      expect(groups.length).toBeGreaterThanOrEqual(3);
      for (const g of groups) expect(groupMembers(g)).toEqual([]);
      console.log(`${sig}: spawned groups ${groups.join(" ")}; left: none`);
    }, 300_000);
});

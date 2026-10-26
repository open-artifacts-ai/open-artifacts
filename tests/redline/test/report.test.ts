import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  type CaseResult,
  exitCode,
  formatReport,
  gateOn,
  gatePasses,
  LEVELS,
  type Level,
  levelOf,
  proof,
  type Report,
} from "../src/report.ts";

const c = (name: string, level: Level, reason?: string): CaseResult => ({
  name,
  level,
  ...(reason ? { reason } : {}),
});

describe("levelOf", () => {
  it("passed without a mark is pass; a mark sets the level", () => {
    expect(levelOf("passed", {}).level).toBe("pass");
    for (const l of [
      "staging-only",
      "not-applicable",
      "unproven-live",
    ] as const)
      expect(levelOf("passed", { redline: { level: l, reason: "r" } })).toEqual(
        { level: l, reason: "r" },
      );
  });

  it("a failure wins over a mark; skipped and pending are never pass", () => {
    expect(
      levelOf("failed", { redline: { level: "staging-only", reason: "r" } })
        .level,
    ).toBe("fail");
    expect(levelOf("skipped", {}).level).toBe("not-applicable");
    expect(levelOf("pending", {}).level).toBe("fail");
  });

  it("proof() writes the mark on the task meta", () => {
    const ctx = {
      task: {
        meta: {} as { redline?: { level: "unproven-live"; reason: string } },
      },
    };
    proof(ctx, "unproven-live", "needs a real tenant");
    expect(ctx.task.meta.redline).toEqual({
      level: "unproven-live",
      reason: "needs a real tenant",
    });
  });
});

describe("gate", () => {
  it("passes only when every case is pass", () => {
    expect(gatePasses([c("a", "pass"), c("b", "pass")])).toBe(true);
    for (const l of LEVELS.filter((x) => x !== "pass"))
      expect(gatePasses([c("a", "pass"), c("b", l)]), l).toBe(false);
  });

  it("an empty run never passes", () => {
    expect(gatePasses([])).toBe(false);
    expect(buildReport([]).gate.reason).toBe("no cases ran");
  });

  it("exit codes: fail is 1 always; non-pass is 1 only with the gate; no report is 1", () => {
    const ok = buildReport([c("a", "pass")]);
    const stg = buildReport([c("a", "pass"), c("b", "staging-only")]);
    const bad = buildReport([c("a", "fail")]);
    expect(exitCode(ok, true)).toBe(0);
    expect(exitCode(stg, false)).toBe(0);
    expect(exitCode(stg, true)).toBe(1);
    expect(exitCode(bad, false)).toBe(1);
    expect(exitCode(ok, false, 2)).toBe(2);
    expect(exitCode(null, false)).toBe(1);
  });

  it("--gate or REDLINE_GATE=1 turns the gate on", () => {
    expect(gateOn(["--gate"], {})).toBe(true);
    expect(gateOn([], { REDLINE_GATE: "1" })).toBe(true);
    expect(gateOn([], { REDLINE_GATE: "0" })).toBe(false);
  });
});

describe("report", () => {
  const r = buildReport(
    [
      c("A's PAT at B", "pass"),
      c("prodClean", "not-applicable", "inventory not configured"),
      c("cross-site cookies", "unproven-live", "PSL"),
      c("nightly replay", "staging-only", "stg only"),
      c("session at B", "fail"),
    ],
    "staging",
  );

  it("counts every level and lists every non-pass case by name", () => {
    expect(r.counts).toEqual({
      pass: 1,
      fail: 1,
      "staging-only": 1,
      "not-applicable": 1,
      "unproven-live": 1,
    });
    expect(r.nonPass.map((x) => x.name)).toEqual([
      "prodClean",
      "cross-site cookies",
      "nightly replay",
      "session at B",
    ]);
    expect(r.gate.passed).toBe(false);
  });

  it("text names every non-pass case and the gate result", () => {
    const t = formatReport(r);
    for (const n of r.nonPass) expect(t).toContain(n.name);
    expect(t).not.toContain("A's PAT at B");
    expect(t).toContain('Gate: FAIL (4 of 5 cases are not "pass")');
  });
});

describe("reporter and gate end to end (vitest on a fixture)", () => {
  const vitest = join(
    import.meta.dirname,
    "..",
    "node_modules",
    ".bin",
    "vitest",
  );
  const run = (level: string, gate: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "oa-redline-gate-"));
    try {
      const p = spawnSync(
        vitest,
        ["run", "-c", "test/fixtures/vitest.gate.config.ts"],
        {
          cwd: join(import.meta.dirname, ".."),
          encoding: "utf8",
          timeout: 60_000,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            FIXTURE_LEVEL: level,
            REDLINE_REPORT: join(dir, "report.json"),
            REDLINE_GATE: gate ? "1" : "0",
          },
        },
      );
      const report = JSON.parse(
        readFileSync(join(dir, "report.json"), "utf8"),
      ) as Report;
      return { status: p.status, report };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("all pass: exit 0 with and without the gate", () => {
    expect(run("pass", true).status).toBe(0);
    expect(run("pass", false).status).toBe(0);
  }, 60_000);

  for (const l of ["staging-only", "not-applicable", "unproven-live"]) {
    it(`${l}: vitest passes, the report lists it, the gate exits non-zero`, () => {
      const off = run(l, false);
      expect(off.status).toBe(0);
      expect(off.report.nonPass.map((x) => [x.name, x.level])).toEqual([
        ["fixture: the case under test", l],
      ]);
      const on = run(l, true);
      expect(on.status).not.toBe(0);
      expect(on.report.gate.passed).toBe(false);
    }, 60_000);
  }

  it("setup failure: tests skipped by a failed beforeAll are fail, not not-applicable", () => {
    const r = run("setup-fail", false);
    expect(r.status).not.toBe(0);
    expect(r.report.counts["not-applicable"]).toBe(0);
    expect(r.report.counts.fail).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("fail: non-zero without the gate", () => {
    const r = run("fail", false);
    expect(r.status).not.toBe(0);
    expect(r.report.counts.fail).toBe(1);
  }, 60_000);
});

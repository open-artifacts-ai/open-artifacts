import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAIMS,
  type Claims,
  conflicts,
  type LaneResult,
  mergeLanes,
  type Phase,
  PLAN,
} from "../src/lanes.ts";
import {
  buildReport,
  exitCode,
  parseManifest,
  type Report,
} from "../src/report.ts";
import { MAX_RETRIED_CASES } from "../src/retry.ts";

const pkg = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(pkg, f), "utf8");
const liveFiles = readdirSync(join(pkg, "live"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `live/${f}`)
  .sort();
const planned = PLAN.flat(2);

describe("the lane plan", () => {
  it("runs every live file exactly once, and only live files", () => {
    expect([...planned].sort()).toEqual(liveFiles);
    expect(new Set(planned).size).toBe(planned.length);
    expect(Object.keys(CLAIMS).sort()).toEqual(liveFiles);
  });

  it("runs every file the manifest requires", () => {
    const m = parseManifest(read("live/manifest.json"));
    for (const c of m.cases) expect(planned).toContain(c.file);
  });

  it("puts no shared state or rate-limit bucket in two lanes of one phase", () => {
    expect(conflicts()).toEqual([]);
  });

  // The check above can fail: each of these plans breaks one rule.
  it.each<[string, Phase[], RegExp]>([
    [
      "two install files side by side",
      [[["live/guard.test.ts"], ["live/live.test.ts"]]],
      /both hold rl-a/,
    ],
    [
      "edge (the token snapshot) beside provisioning (P36's PAT use)",
      [[["live/edge.test.ts"], ["live/provisioning.test.ts"]]],
      /both hold rl-a\/admin-pat/,
    ],
    [
      "signin beside provisioning (P34 spends the broker's IP bucket)",
      [[["live/signin.test.ts"], ["live/provisioning.test.ts"]]],
      /both spend broker-ip/,
    ],
  ])("finds the conflict: %s", (_, plan, want) => {
    expect(conflicts(plan).join("\n")).toMatch(want);
  });

  it("a file without claims is refused", () => {
    expect(() => conflicts([[["live/new.test.ts"], ["x"]]])).toThrow(
      /no claims/,
    );
  });
});

// The claims are written by hand; these read the code for what each file
// does and fail when a claim is missing.
const importsOf = (text: string): string[] =>
  [...text.matchAll(/from "\.\.\/src\/([\w-]+\.ts)"/g)].map(
    (m) => `src/${m[1]}`,
  );

function claimGaps(file: string, c: Claims): string[] {
  const text = read(file);
  const imports = importsOf(text);
  const gaps: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) gaps.push(`${file}: ${what}`);
  };
  const all = [text, ...imports.map(read)].join("\n");
  if (text.includes("loadTargets(")) {
    for (const k of ["rl-a", "rl-b"])
      need(c.state[k] === "write", `loadTargets: needs ${k} write`);
    for (const b of [
      "rl-a/hooks",
      "rl-b/hooks",
      "rl-a/codes",
      "rl-b/codes",
      "anon-ip",
    ])
      need(c.buckets.includes(b), `loadTargets: needs bucket ${b}`);
  } else {
    // No install of its own: no hook, session or seeding on rl-a or rl-b.
    for (const s of ["hook(", "prepareSide(", "sessionCred(", "loadTargets("])
      need(!all.includes(s), `calls ${s} without claiming the installs`);
  }
  if (/state: "\/api\/v1\/tokens"|"GET", "\/api\/v1\/tokens"/.test(text))
    for (const k of ["rl-a/admin-pat", "rl-b/admin-pat"])
      need(
        c.state[k] === "write",
        `snapshots the token list: needs ${k} write`,
      );
  if (text.includes("brokerState(") || imports.includes("src/provisioning.ts"))
    need(
      c.buckets.includes("broker-ip"),
      "reaches the broker: needs broker-ip",
    );
  if (imports.includes("src/provisioning.ts")) {
    need(
      c.buckets.includes("provisioning-api"),
      "the Provisioning API: needs provisioning-api",
    );
    need(
      read("src/provisioning.ts").includes("rlAPat") &&
        c.state["rl-a/admin-pat"] !== undefined,
      "P36 uses rl-a's admin PAT: needs rl-a/admin-pat",
    );
  }
  return gaps;
}

describe("the claims match the code", () => {
  it("every live file claims what it touches", () => {
    expect(liveFiles.flatMap((f) => claimGaps(f, CLAIMS[f] as Claims))).toEqual(
      [],
    );
  });

  it.each([
    ["live/surfaces.test.ts", { state: {}, buckets: [] }, /needs rl-a write/],
    [
      "live/edge.test.ts",
      {
        state: { "rl-a": "write", "rl-b": "write" },
        buckets: [
          "rl-a/hooks",
          "rl-b/hooks",
          "rl-a/codes",
          "rl-b/codes",
          "anon-ip",
        ],
      },
      /snapshots the token list/,
    ],
    [
      "live/signin.test.ts",
      { ...(CLAIMS["live/signin.test.ts"] as Claims), buckets: [] },
      /needs broker-ip/,
    ],
    [
      "live/provisioning.test.ts",
      { state: {}, buckets: ["broker-ip"] },
      /needs provisioning-api[\s\S]*needs rl-a\/admin-pat/,
    ],
  ] as [string, Claims, RegExp][])(
    "a missing claim fails: %s",
    (file, c, want) => {
      expect(claimGaps(file, c).join("\n")).toMatch(want);
    },
  );
});

describe("mergeLanes", () => {
  const pass = (file: string, name = "x") => ({
    name,
    file,
    level: "pass" as const,
  });
  const lane = (
    files: string[],
    part: LaneResult["part"],
    exit = 0,
  ): LaneResult => ({ lane: files, exit, part });

  it("keeps every lane's cases and notes, in plan order", () => {
    const m = mergeLanes([
      lane(["live/a.test.ts"], {
        cases: [pass("live/a.test.ts")],
        fileNotes: [{ file: "live/a.test.ts", note: "n" }],
      }),
      lane(["live/b.test.ts"], {
        cases: [pass("live/b.test.ts")],
        fileNotes: [],
      }),
    ]);
    expect(m.cases.map((c) => c.file)).toEqual([
      "live/a.test.ts",
      "live/b.test.ts",
    ]);
    expect(m.fileNotes).toHaveLength(1);
    expect(m.runExit).toBe(0);
  });

  it("a lane that wrote no part is a fail case, and its exit is the run's", () => {
    const m = mergeLanes([lane(["live/a.test.ts"], null, 7)]);
    expect(m.cases).toEqual([
      expect.objectContaining({ name: "lane a: no results", level: "fail" }),
    ]);
    expect(m.runExit).toBe(7);
  });

  it("a case from a file outside its lane is a fail case", () => {
    const m = mergeLanes([
      lane(["live/a.test.ts"], {
        cases: [pass("live/b.test.ts")],
        fileNotes: [],
      }),
    ]);
    expect(m.cases[0]).toEqual(
      expect.objectContaining({
        name: "lane a: ran live/b.test.ts",
        level: "fail",
      }),
    );
  });

  // The provisioning lane fails while the install lane passes: the run fails,
  // whether the lane reported its failure or died without a part.
  it.each<[string, LaneResult]>([
    [
      "a failed case",
      lane(
        ["live/provisioning.test.ts"],
        {
          cases: [
            {
              name: "P11",
              file: "live/provisioning.test.ts",
              level: "fail",
              reason: "403 expected",
            },
          ],
          fileNotes: [],
        },
        1,
      ),
    ],
    ["no part at all", lane(["live/provisioning.test.ts"], null, 1)],
  ])("one lane fails, the other passes: the run fails (%s)", (_, bad) => {
    const m = mergeLanes([
      lane(["live/guard.test.ts"], {
        cases: [pass("live/guard.test.ts")],
        fileNotes: [],
      }),
      bad,
    ]);
    const r = buildReport(m.cases, "staging");
    expect(r.counts.fail).toBeGreaterThan(0);
    expect(r.gate.passed).toBe(false);
    expect(exitCode(r, true, m.runExit)).not.toBe(0);
    // Even had the lane's vitest exited 0, its fail case fails the run.
    expect(exitCode(r, false, 0)).not.toBe(0);
  });
});

/** Runs `node --experimental-strip-types <args>` in pkg; bounded, own group. */
function node(
  args: string[],
  env: Record<string, string>,
  ms: number,
): Promise<{ code: number; out: string }> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", ...args],
    { cwd: pkg, detached: true, stdio: ["ignore", "pipe", "pipe"], env },
  );
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const kill = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  const timer = setTimeout(kill, ms);
  return new Promise((res) =>
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code: code ?? 1, out });
    }),
  );
}

describe("the retry cap across processes", () => {
  it("lanes taking retries at once never take more than the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-lanes-retry-"));
    try {
      const file = join(dir, "report.json.retries");
      const script = `import { runBudget } from "./src/retry.ts";
let n = 0;
for (let i = 0; i < ${MAX_RETRIED_CASES}; i++) if (runBudget(${JSON.stringify(file)}).take()) n++;
console.log("took " + n);`;
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      };
      const runs = await Promise.all(
        Array.from({ length: 4 }, () =>
          node(["--input-type=module", "-e", script], env, 60_000),
        ),
      );
      const took = runs.map((r) =>
        Number(/took (\d+)/.exec(r.out)?.[1] ?? NaN),
      );
      expect(took.every(Number.isFinite)).toBe(true);
      expect(took.reduce((a, b) => a + b, 0)).toBe(MAX_RETRIED_CASES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

// The runner end to end with NO targets: every file fails its setup before
// any request (parseTargets throws; provisioning is not-applicable without
// REDLINE_RELEASE), so nothing leaves this machine. It proves the phases run,
// every lane writes its part, the report holds every manifest case, and the
// run fails.
describe("scripts/redline.ts with no targets", () => {
  it("runs every lane, builds one report, and fails the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-lanes-run-"));
    try {
      const report = join(dir, "report.json");
      const r = await node(
        ["scripts/redline.ts", "--gate"],
        {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          REDLINE_REPORT: report,
        },
        170_000,
      );
      expect(r.code).not.toBe(0);
      for (let i = 1; i <= PLAN.length; i++)
        expect(r.out).toContain(`redline: phase ${i} of ${PLAN.length}`);
      // Phase 2's lanes ran beside each other: their output is prefixed.
      expect(r.out).toContain("[credentials] ");
      expect(r.out).toContain("[provisioning] ");
      const parts = readdirSync(join(dir, "report.lanes")).sort();
      expect(parts).toEqual(
        PLAN.flat()
          .map(
            (l) => `${(l[0] ?? "").replace(/^live\/|\.test\.ts$/g, "")}.json`,
          )
          .sort(),
      );
      const rep = JSON.parse(readFileSync(report, "utf8")) as Report;
      expect(existsSync(join(dir, "report.txt"))).toBe(true);
      const m = parseManifest(read("live/manifest.json"));
      const names = new Set(rep.cases.map((c) => `${c.file} ${c.name}`));
      for (const c of m.cases) expect(names).toContain(`${c.file} ${c.name}`);
      expect(rep.gate.passed).toBe(false);
      expect(rep.cases.some((c) => c.level === "pass")).toBe(false);
      expect(rep.cases.some((c) => /^lane /.test(c.name))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

import { describe, expect, it } from "vitest";
import {
  ID_TOKEN_CASES,
  ID_TOKEN_DESCRIBE,
  ID_TOKEN_FILE,
  NEEDS_CAPTURE,
} from "../src/capture.ts";
import {
  combineReports,
  PROD_CLEAN,
  PROD_RULE_LABEL,
  parseCiLog,
} from "../src/combine-reports.ts";
import { buildReport, type CaseResult, type Report } from "../src/report.ts";

// The laptop full run standing in for verdicts.json: only CI's two
// "needs capture" cases are filled in, and only from a matching run.

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const BINDING = {
  installs: { a: "ijzbmraouh5r", b: "i42fdk7ahvs2" },
  versions: { a: "0.74.1", b: "0.74.1" },
  suiteSha: "5469cf7811e17857091d49dc18e0daa327bdbf89",
};
const ID = Object.values(ID_TOKEN_CASES).map((n) => ({
  file: ID_TOKEN_FILE,
  name: `${ID_TOKEN_DESCRIBE} > ${n}`,
}));
const OTHER = [
  { file: "live/edge.test.ts", name: "mapping > HOSTS maps each host once" },
  { file: "live/guard.test.ts", name: "guard > prod is clean" },
  { file: "live/x.test.ts", name: "x > A's PAT at B: refused" },
];

function report(
  level: (c: { file: string; name: string }) => Partial<CaseResult>,
  o: { finishedAt?: number; binding?: typeof BINDING; mode?: string } = {},
): Report {
  const cases = [...OTHER, ...ID].map(
    (c) => ({ ...c, level: "pass", ...level(c) }) as CaseResult,
  );
  const r = buildReport(cases, o.mode ?? "staging");
  return {
    ...r,
    finishedAt: new Date(o.finishedAt ?? NOW - 3_600_000).toISOString(),
    binding: o.binding ?? BINDING,
  };
}
const isId = (c: { file: string }) => c.file === ID_TOKEN_FILE;
const ciReport = (o = {}) =>
  report(
    (c) => (isId(c) ? { level: "unproven-live", reason: NEEDS_CAPTURE } : {}),
    o,
  );
const localReport = (o = {}) =>
  report(
    (c) =>
      isId(c)
        ? { level: "pass", label: "redeemed by capture run XUvaQD" }
        : c.file === "live/edge.test.ts"
          ? { level: "unproven-live", reason: "CI-only (not-local)" }
          : c.file === "live/guard.test.ts"
            ? { level: "not-applicable", reason: "prod probe not configured" }
            : {},
    o,
  );

describe("combineReports", () => {
  it("fills exactly CI's two needs-capture cases from the local run; everything else is CI's", () => {
    const r = combineReports(ciReport(), localReport(), NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(r.report.gate.passed).toBe(true);
    expect(r.captureRun).toBe("XUvaQD");
    expect(r.sources.filter((s) => s.source === "local")).toEqual(
      ID.map((c) => ({ ...c, source: "local" })),
    );
    expect(r.sources.filter((s) => s.source === "ci")).toHaveLength(
      OTHER.length,
    );
    expect(r.report.binding).toEqual(BINDING);
  });

  it("never fills any other case from the local run: a CI non-pass stays a non-pass", () => {
    const ci = report((c) =>
      isId(c)
        ? { level: "unproven-live", reason: NEEDS_CAPTURE }
        : c.file === "live/guard.test.ts"
          ? { level: "not-applicable", reason: "prod probe not configured" }
          : {},
    );
    const local = report((c) =>
      isId(c) ? { level: "pass", label: "redeemed by capture run XUvaQD" } : {},
    );
    const r = combineReports(ci, local, NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(r.report.gate.passed).toBe(false);
    expect(r.report.nonPass.map((c) => c.name)).toEqual([
      "guard > prod is clean",
    ]);
  });

  it("refuses another suite commit, another install, a version drift", () => {
    const other = {
      ...BINDING,
      suiteSha: "456b3d387d8c231f478a0597f3359b647a6054e0",
    };
    expect(
      combineReports(ciReport({ binding: other }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^suite commit differs/),
    });
    const inst = {
      ...BINDING,
      installs: { a: "ijzbmraouh5r", b: "izzz999yyy88" },
    };
    expect(
      combineReports(ciReport({ binding: inst }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^install b differs/),
    });
    const ver = { ...BINDING, versions: { a: "0.74.1", b: "0.74.2" } };
    expect(
      combineReports(ciReport({ binding: ver }), localReport(), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^install b's version differs/),
    });
  });

  it("refuses runs more than 24 h apart, a future run, and a non-staging report", () => {
    expect(
      combineReports(
        ciReport({ finishedAt: NOW - 1 }),
        localReport({ finishedAt: NOW - 25 * 3_600_000 }),
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/apart \(at most 24 h\)/),
    });
    expect(
      combineReports(
        ciReport({ finishedAt: NOW + 3_600_000 }),
        localReport(),
        NOW,
      ),
    ).toMatchObject({ ok: false, reason: "a report finishes in the future" });
    expect(
      combineReports(ciReport(), localReport({ mode: "local" }), NOW),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/staging runs/),
    });
  });

  it("refuses a local ID-token case that isn't a capture pass, and a CI one that isn't needs-capture", () => {
    const noCapture = report((c) => (isId(c) ? { level: "pass" } : {}));
    expect(combineReports(ciReport(), noCapture, NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a pass redeemed by a capture run/),
    });
    const ciFail = report((c) =>
      isId(c) ? { level: "fail", reason: "B accepted it" } : {},
    );
    expect(combineReports(ciFail, localReport(), NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is fail .* not "unproven: needs capture"/),
    });
  });

  it("refuses two reports that don't list the same cases", () => {
    const local = localReport();
    local.cases = local.cases.slice(1);
    expect(combineReports(ciReport(), local, NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/same cases/),
    });
  });
});

// The user's rule (2026-10-30): zero prod results count as a passing check,
// only for CI's exact "prod not brought up" and only when the CI run's log
// proves the probe ran with all three secrets and the inventory URL.
describe("combineReports: prod is clean, zero prod installs", () => {
  const SHA = BINDING.suiteSha;
  const ACCT = "0123456789abcdef0123456789abcdef";
  const T = "2026-10-30T10:00:00.0000000Z";
  const log = (
    o: {
      sha?: string;
      r2?: string;
      scripts?: string;
      inv?: string;
      url?: string;
      acct?: string;
    } = {},
  ) =>
    [
      `redline\tRun actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683\t${T} ${o.sha ?? SHA}`,
      `redline\tWrite the suite's secrets as 0600 files\t${T} env:`,
      `redline\tWrite the suite's secrets as 0600 files\t${T}   RL_A_PAT: ***`,
      `redline\tWrite the suite's secrets as 0600 files\t${T}   PROD_R2_TOKEN:${o.r2 ?? " ***"}`,
      `redline\tWrite the suite's secrets as 0600 files\t${T}   PROD_SCRIPTS_TOKEN:${o.scripts ?? " ***"}`,
      `redline\tWrite the suite's secrets as 0600 files\t${T}   PROD_INVENTORY_KEY:${o.inv ?? " ***"}`,
      `redline\tRun the suite\t${T} env:`,
      `redline\tRun the suite\t${T}   REDLINE_PROD_ACCOUNT_ID:${o.acct ?? ` ${ACCT}`}`,
      `redline\tRun the suite\t${T}   REDLINE_PROD_INVENTORY_URL:${o.url ?? " https://inventory.example.dev"}`,
    ].join("\n");
  const withProd = (prod: Partial<CaseResult>) => {
    const add = (r: Report): Report => {
      const cases = [
        ...r.cases,
        {
          file: PROD_CLEAN.file,
          name: PROD_CLEAN.name,
          level: "pass",
          ...prod,
        } as CaseResult,
      ];
      return {
        ...buildReport(cases, "staging"),
        finishedAt: r.finishedAt,
        binding: r.binding,
      };
    };
    return {
      ci: add(ciReport()),
      local: {
        ...localReport(),
        cases: [
          ...localReport().cases,
          {
            file: PROD_CLEAN.file,
            name: PROD_CLEAN.name,
            level: "not-applicable",
            reason: "prod probe not configured",
          } as CaseResult,
        ],
      },
    };
  };
  const exact = {
    level: "not-applicable",
    reason: "prod not brought up",
  } as const;
  const prodCase = (r: ReturnType<typeof combineReports>) =>
    r.ok ? r.report.cases.find((c) => c.name === PROD_CLEAN.name) : undefined;

  it("exact reason, all three secrets and the inventory URL: pass by the user rule", () => {
    const { ci, local } = withProd(exact);
    const r = combineReports(ci, local, NOW, parseCiLog(log()));
    if (!r.ok) throw new Error(r.reason);
    expect(prodCase(r)).toMatchObject({
      level: "pass",
      label: PROD_RULE_LABEL,
    });
    expect(r.prodRule).toEqual({ applied: true });
    expect(r.report.gate.passed).toBe(true);
    expect(r.sources.find((s) => s.name === PROD_CLEAN.name)?.source).toBe(
      "ci-rule",
    );
  });

  it.each([
    [
      "the inventory-not-configured variant",
      {
        level: "not-applicable",
        reason: "prod not brought up (inventory not configured)",
      },
    ],
    [
      "probe not configured",
      { level: "not-applicable", reason: "prod probe not configured" },
    ],
    [
      "a fail",
      { level: "fail", reason: "prodClean x: /healthz testHooks is true" },
    ],
  ] as const)("%s is never mapped: the gate fails", (_, prod) => {
    const { ci, local } = withProd(prod);
    const r = combineReports(ci, local, NOW, parseCiLog(log()));
    if (!r.ok) throw new Error(r.reason);
    expect(prodCase(r)).toMatchObject(prod);
    expect(r.prodRule).toBeNull();
    expect(r.report.gate.passed).toBe(false);
  });

  it.each([
    ["the inventory URL missing", { url: "" }, /REDLINE_PROD_INVENTORY_URL/],
    ["the inventory key missing", { inv: "" }, /REDLINE_PROD_INVENTORY_KEY/],
    ["the R2 token missing", { r2: "" }, /REDLINE_PROD_R2_TOKEN/],
    [
      "the scripts token missing",
      { scripts: "" },
      /REDLINE_PROD_SCRIPTS_TOKEN/,
    ],
    ["the account id missing", { acct: "" }, /REDLINE_PROD_ACCOUNT_ID/],
    [
      "another commit's log",
      { sha: "456b3d387d8c231f478a0597f3359b647a6054e0" },
      /checkout is not/,
    ],
  ] as const)("exact reason but %s: stays not-applicable", (_, o, why) => {
    const { ci, local } = withProd(exact);
    const r = combineReports(ci, local, NOW, parseCiLog(log(o)));
    if (!r.ok) throw new Error(r.reason);
    expect(prodCase(r)).toMatchObject(exact);
    expect(r.prodRule).toMatchObject({
      applied: false,
      reason: expect.stringMatching(why),
    });
    expect(r.report.gate.passed).toBe(false);
  });

  it("exact reason without a CI log: stays not-applicable", () => {
    const { ci, local } = withProd(exact);
    const r = combineReports(ci, local, NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(prodCase(r)).toMatchObject(exact);
    expect(r.report.gate.passed).toBe(false);
  });

  it("only the redline job's own env lines count", () => {
    const other = log().replaceAll("redline\t", "t19\t");
    const env = parseCiLog(other);
    expect(env.prodSecrets).toEqual({
      r2: false,
      scripts: false,
      inventoryKey: false,
    });
    expect(env.prodInventoryUrl).toBe("");
    expect(env.checkoutShas).toEqual([]);
  });
});

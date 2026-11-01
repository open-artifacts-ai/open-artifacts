import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  label,
  labelOf,
  levelOf,
  PRE_PROD_GUARD,
  PRE_PROD_GUARD_REASON,
  PRE_PROD_NA,
  PRE_PROD_REASON,
  proof,
  type Report,
  redactReason,
} from "../src/report.ts";

const c = (name: string, level: Level, reason?: string): CaseResult => ({
  name,
  level,
  ...(reason ? { reason } : {}),
});

describe("redactReason", () => {
  // Every input the review found leaking, with the secret that must go and
  // what must stay readable.
  const cases: [input: string, secret: string, keeps: string][] = [
    ["code 4%2F0AeanS0aXyz at B", "0AeanS0aXyz", "at B"],
    ["code=4%2F0AeanS0aXyz&state=x refused", "0AeanS0aXyz", "refused"],
    ["signed in as alice%40tenant.com", "alice", "signed in as [email]"],
    ["?login_hint=alice%40tenant.com&hd=x", "alice", "login_hint=[redacted]"],
    ["(state=Zq3kL9aBxYzQ)", "Zq3kL9aBxYzQ", "(state=[redacted])"],
    ["state:Zq3kL9aBxYzQ wrong", "Zq3kL9aBxYzQ", "state:[redacted] wrong"],
    ['{"state":"Zq3kL9aBxYzQ"}', "Zq3kL9aBxYzQ", '"state":"[redacted]"'],
    [
      "Cookie: session=s3cr3tv4l; other=zz9q",
      "s3cr3tv4l",
      "Cookie: session=[redacted]; other=[redacted]",
    ],
    ["Set-Cookie: sid=s3cr3tv4l; Path=/", "s3cr3tv4l", "sid=[redacted]"],
    [
      "sent __Secure-x=s3cr3tv4l to B",
      "s3cr3tv4l",
      "__Secure-x=[redacted] to B",
    ],
    ["token ya29.short at B", "ya29.short", "token [token] at B"],
    ["refresh 1//0gshort at B", "0gshort", "refresh [token] at B"],
    ["nonce 9fK2_aB3cD mismatch", "9fK2_aB3cD", "nonce [redacted] mismatch"],
    ['"id_token": "abc.def.ghi"', "abc.def", '"id_token": "[redacted]"'],
  ];
  for (const [input, secret, keeps] of cases)
    it(`redacts ${JSON.stringify(input)}`, () => {
      const out = redactReason(input);
      expect(out).not.toContain(secret);
      expect(out).toContain(keeps);
    });

  it("leaves a plain leg reason readable", () => {
    const r =
      "A's credential at B (rl-b; expected refused at sign-in (error=tenant, no session)): rl-b did not refuse the sign-in (status 302, body sha256:0011223344556677 (0 bytes); to /sign-in?error=failed)";
    expect(redactReason(r)).toBe(r);
  });
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

  it("a failure on infra errors only is infra; any other error makes it fail", () => {
    const t = { message: "infra: setup publish timed out after 60s on rl-b" };
    expect(levelOf("failed", {}, [t])).toEqual({
      level: "infra",
      reason: t.message,
    });
    expect(levelOf("failed", {}, [t, { message: "boom" }]).level).toBe("fail");
    expect(levelOf("failed", {}, []).level).toBe("fail");
  });

  it("one infra case with every other case passing fails the gate", () => {
    const r = buildReport([
      c("a", "pass"),
      c("b", "pass"),
      c("c", "infra", "infra: setup publish timed out after 60s on rl-b"),
    ]);
    expect(r.gate.passed).toBe(false);
    expect(r.counts.infra).toBe(1);
    expect(r.gate.reason).toBe('1 of 3 cases are not "pass" (1 infra)');
    expect(formatReport(r)).toContain(
      "[infra] c (infra: setup publish timed out after 60s on rl-b)",
    );
    expect(exitCode(r, true)).toBe(1);
    expect(exitCode(r, false)).toBe(1);
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

  // #1012 (design 5.8): only the frozen prod-host probes, only with the
  // not-resolved reason, count as a pass before the prod deploy.
  it("accepts a pre-prod not-applicable only for the frozen prod-host probes", () => {
    expect(PRE_PROD_NA).toEqual(["P7", "P46"]);
    expect(Object.isFrozen(PRE_PROD_NA)).toBe(true);
    const na = (
      name: string,
      reason = PRE_PROD_REASON,
      file = "live/provisioning.test.ts",
    ): CaseResult => ({
      name,
      file,
      level: "not-applicable",
      reason,
    });
    const ok = c("a", "pass");
    expect(
      gatePasses([
        ok,
        na("provisioning > P7: staging OIDC against prod /v1/me: 401"),
      ]),
    ).toBe(true);
    expect(
      gatePasses([
        ok,
        na("provisioning > P46: staging OIDC on prod /mcp: 401"),
      ]),
    ).toBe(true);
    for (const bad of [
      na("provisioning > P29: self-serve"),
      na("provisioning > P70: lookalike"),
      na("provisioning > P7: x", "dispatch runs only"),
      na("provisioning > P7: x", PRE_PROD_REASON, "live/live.test.ts"),
      { ...na("provisioning > P7: x"), level: "unproven-live" as const },
    ])
      expect(gatePasses([ok, bad]), JSON.stringify(bad)).toBe(false);
  });

  // The guard's prod-clean case: exact file, exact name, exact reason.
  it("accepts the guard's pre-prod not-applicable only as frozen", () => {
    expect(PRE_PROD_GUARD).toEqual({
      file: "live/guard.test.ts",
      name: "guard > prod is clean (no test hooks on any prod install)",
    });
    expect(Object.isFrozen(PRE_PROD_GUARD)).toBe(true);
    const g: CaseResult = {
      ...PRE_PROD_GUARD,
      level: "not-applicable",
      reason: PRE_PROD_GUARD_REASON,
    };
    const ok = c("a", "pass");
    expect(gatePasses([ok, g])).toBe(true);
    const r = buildReport([ok, g]);
    expect(r.nonPass).toEqual([g]);
    expect(formatReport(r)).toContain(
      `[not-applicable] ${PRE_PROD_GUARD.name} (${PRE_PROD_GUARD_REASON})`,
    );
    const { file: _f, ...noFile } = g;
    for (const bad of [
      { ...g, file: "live/provisioning.test.ts" },
      { ...g, file: "live/live.test.ts" },
      { ...g, file: "x/live/guard.test.ts" },
      noFile,
      { ...g, name: `${g.name} ` },
      {
        ...g,
        name: "guard > both targets report ok, testHooks: true and their own installId",
      },
      { ...g, reason: PRE_PROD_REASON },
      { ...g, reason: "local mode" },
      { ...g, level: "unproven-live" as const },
      { ...g, level: "fail" as const },
      // The guard reason never widens the P7/P46 rule either.
      {
        name: "provisioning > P7: x",
        file: "live/provisioning.test.ts",
        level: "not-applicable" as const,
        reason: PRE_PROD_GUARD_REASON,
      },
    ])
      expect(gatePasses([ok, bad]), JSON.stringify(bad)).toBe(false);
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
      infra: 0,
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

describe("labels", () => {
  it("label() writes the label on the task meta; labelOf reads it", () => {
    const ctx = { task: { meta: {} as { redlineLabel?: string } } };
    expect(labelOf(ctx.task.meta)).toBeUndefined();
    label(ctx, "Turnstile test key");
    expect(ctx.task.meta.redlineLabel).toBe("Turnstile test key");
    expect(labelOf(ctx.task.meta)).toBe("Turnstile test key");
    expect(labelOf({ redlineLabel: 3 })).toBeUndefined();
    expect(labelOf(undefined)).toBeUndefined();
  });

  it("a labeled pass still passes, and the text names it under its label", () => {
    const r = buildReport([
      { ...c("code at B", "pass"), label: "Turnstile test key" },
      c("A's PAT at B", "pass"),
    ]);
    expect(r.gate.passed).toBe(true);
    const t = formatReport(r);
    expect(t).toContain("Labeled:\n  [Turnstile test key] code at B\n");
    expect(t).not.toContain("A's PAT at B");
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
  const fixtureManifest = join(
    import.meta.dirname,
    "fixtures",
    "gate.manifest.json",
  );
  const run = (level: string, gate: boolean, manifest = fixtureManifest) => {
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
            REDLINE_MANIFEST: manifest,
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

  it("fail: the report records the error message as the reason", () => {
    const r = run("fail", false);
    expect(r.status).not.toBe(0);
    expect(r.report.nonPass).toEqual([
      {
        name: "fixture: the case under test",
        file: "test/fixtures/gate.fixture.ts",
        level: "fail",
        reason: "fixture failure",
      },
    ]);
  }, 60_000);

  it("fail: codes, states, cookies, tokens and emails are redacted from the reason", () => {
    const r = run("secret-fail", false);
    const reason = r.report.nonPass[0]?.reason ?? "";
    expect(reason).toMatch(
      /^rl-b callback http:\/\/rl-b\.app\.localhost:8787\/auth\/callback\/google\?state=\[redacted\]&code=\[redacted\]&bstate=\[redacted\] for \[email\] with cookie oa_oidc_ab12=\[redacted\]; Bearer \[redacted\] token \[token\]$/,
    );
    for (const s of [
      "st0123456789",
      "4/0AeanS",
      "eyJ",
      "alice",
      "v4lu3s3cr3t",
      "oa_pat_0123",
    ])
      expect(JSON.stringify(r.report)).not.toContain(s);
  }, 60_000);

  it("leg-fail: the report records the leg, host, expected and actual", () => {
    const r = run("leg-fail", false);
    expect(r.report.nonPass).toHaveLength(1);
    expect(r.report.nonPass[0]).toMatchObject({
      level: "fail",
      leg: "A's credential at B",
      host: "rl-b",
      expected: "refused at sign-in (error=tenant, no session)",
      actual:
        "rl-b did not refuse the sign-in (status 302, body sha256:0011223344556677 (0 bytes); to /)",
    });
    expect(r.report.nonPass[0]?.reason).toMatch(
      /^A's credential at B \(rl-b; expected refused at sign-in \(error=tenant, no session\)\): rl-b did not refuse/,
    );
  }, 60_000);

  it("labeled: the report carries the case's label; it still passes the gate", () => {
    const r = run("labeled", true);
    expect(r.status).toBe(0);
    expect(
      r.report.cases.filter((c) => c.label).map((c) => [c.name, c.label]),
    ).toEqual([
      ["outer > inner > fixture: a nested case", "Turnstile test key"],
    ]);
  }, 60_000);

  it("setup failure: tests skipped by a failed beforeAll are fail, not not-applicable", () => {
    const r = run("setup-fail", false);
    expect(r.status).not.toBe(0);
    expect(r.report.counts["not-applicable"]).toBe(0);
    expect(r.report.counts.fail).toBeGreaterThanOrEqual(2);
    // A throw before any request (the beforeAll) is recorded with its reason.
    // (The file-level beforeAll also shows as a module error, which the
    // manifest doesn't list.)
    const skipped = r.report.nonPass.filter((c) =>
      c.name.startsWith("fixture: "),
    );
    expect(skipped.length).toBeGreaterThanOrEqual(2);
    for (const c of skipped)
      expect(c.reason).toBe("setup failed: fixture setup");
  }, 60_000);

  it("nested setup failure: a test under a failed outer beforeAll is fail", () => {
    const r = run("nested-setup-fail", false);
    expect(r.status).not.toBe(0);
    const nested = r.report.cases.find(
      (c) => c.name === "outer > inner > fixture: a nested case",
    );
    expect(nested?.level).toBe("fail");
  }, 60_000);

  it("a required case that didn't run is fail (missing or renamed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-redline-manifest-"));
    try {
      const m = JSON.parse(readFileSync(fixtureManifest, "utf8"));
      m.cases.push({
        file: "test/fixtures/gone.fixture.ts",
        name: "a case from a deleted file",
      });
      const path = join(dir, "manifest.json");
      writeFileSync(path, JSON.stringify(m));
      const r = run("pass", true, path);
      expect(r.status).not.toBe(0);
      expect(r.report.nonPass).toEqual([
        {
          name: "a case from a deleted file",
          file: "test/fixtures/gone.fixture.ts",
          level: "fail",
          reason: "required case did not run",
        },
      ]);
      // Also non-zero without the gate: it is a FAIL, not a soft level.
      expect(run("pass", false, path).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a case missing from the manifest is fail; no manifest at all is fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-redline-manifest-"));
    try {
      const m = JSON.parse(readFileSync(fixtureManifest, "utf8"));
      m.cases = m.cases.filter(
        (c: { name: string }) => c.name !== "fixture: a passing case",
      );
      const path = join(dir, "manifest.json");
      writeFileSync(path, JSON.stringify(m));
      const r = run("pass", false, path);
      expect(r.status).not.toBe(0);
      expect(r.report.nonPass.map((c) => [c.name, c.reason])).toEqual([
        ["fixture: a passing case", "not in the required-case manifest"],
      ]);
      const none = run("pass", false, join(dir, "absent.json"));
      expect(none.status).not.toBe(0);
      expect(none.report.nonPass.map((c) => c.name)).toEqual([
        "required-case manifest",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("infra: one setup timeout, everything else passing, fails the gate and the run", () => {
    const msg = "infra: setup publish timed out after 60s on rl-b";
    for (const gate of [true, false]) {
      const r = run("infra", gate);
      expect(r.status).not.toBe(0);
      expect(r.report.gate.passed).toBe(false);
      expect(r.report.counts.infra).toBe(1);
      expect(r.report.counts.pass).toBe(r.report.total - 1);
      expect(r.report.nonPass).toEqual([
        {
          name: "fixture: the case under test",
          file: "test/fixtures/gate.fixture.ts",
          level: "infra",
          reason: msg,
        },
      ]);
    }
  }, 60_000);

  it("setup infra: tests skipped by a beforeAll setup timeout are infra, never pass or n/a", () => {
    const r = run("setup-infra", true);
    expect(r.status).not.toBe(0);
    expect(r.report.gate.passed).toBe(false);
    expect(r.report.counts["not-applicable"]).toBe(0);
    expect(r.report.counts.infra).toBeGreaterThanOrEqual(2);
    for (const c of r.report.cases.filter((x) => x.level === "infra"))
      expect(c.reason).toBe("infra: setup publish timed out after 60s on rl-b");
  }, 60_000);

  it("setup hook refused: one infra result for the whole file, not one per case", () => {
    const r = run("setup-hook", false);
    expect(r.status).not.toBe(0);
    expect(r.report.gate.passed).toBe(false);
    expect(r.report.counts).toMatchObject({ pass: 0, fail: 0, infra: 1 });
    expect(r.report.total).toBe(1);
    const [only] = r.report.cases;
    expect(only?.name).toBe("infra: setup /__test/session spaces_blocked");
    expect(only?.level).toBe("infra");
    expect(only?.reason).toMatch(
      /^infra: setup \/__test\/session spaces_blocked on rl-a \(status 404, body sha256:[0-9a-f]{16} \(\d+ bytes\)\); 3 case\(s\) in test\/fixtures\/gate\.fixture\.ts did not run$/,
    );
    // The manifest counts the blocked cases as run (no "did not run" fails).
    expect(only?.blocked).toEqual({
      file: "test/fixtures/gate.fixture.ts",
      cases: [
        "fixture: a passing case",
        "fixture: the case under test",
        "outer > inner > fixture: a nested case",
      ],
    });
    // Only the reason word leaves the body.
    expect(JSON.stringify(r.report)).not.toContain("leaked-body-text");
  }, 60_000);

  it("setup hook refused plus another infra error: the folded reason names both", () => {
    const r = run("setup-hook-more", false);
    expect(r.status).not.toBe(0);
    expect(r.report.counts).toMatchObject({ pass: 0, fail: 0, infra: 1 });
    const [only] = r.report.cases;
    expect(only?.name).toBe("infra: setup /__test/session spaces_blocked");
    expect(only?.reason).toMatch(
      /^infra: setup \/__test\/session spaces_blocked on rl-a \(status 404, [^)]+\)\); infra: setup publish timed out after 60s on rl-b; 3 case\(s\) in test\/fixtures\/gate\.fixture\.ts did not run$/,
    );
  }, 60_000);

  it("fail: non-zero without the gate", () => {
    const r = run("fail", false);
    expect(r.status).not.toBe(0);
    expect(r.report.counts.fail).toBe(1);
  }, 60_000);
});

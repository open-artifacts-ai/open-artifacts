// #1084: the owner's address is a secret. Every workflow that uses it refuses
// an unset or unnormalized value before it changes anything. Setup prints the
// address trimmed and lowercased, and only the exact stored value is masked,
// so a differently spelled secret would reach the public log.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "${{ secrets.OA_OWNER_EMAIL }}";
const GUARD = "The owner address is set and normalized";
const read = (f: string) => readFileSync(join(root, f), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const jobSteps = (file: string, job: string): Step[] =>
  parse(read(`.github/workflows/${file}`)).jobs[job].steps;

const bash = (script: string, env: Record<string, string>) => {
  const r = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const usesSecret = (s: Step) => JSON.stringify(s.env ?? {}).includes(SECRET);
const BAD = ["Me@Test.Invalid", " me@test.invalid", "me@test.invalid\n"];

describe("every workflow that needs the owner address guards it first", () => {
  const JOBS: [string, string][] = [
    ["deploy-staging.yml", "deploy"],
    ["ops-prod-install.yml", "install"],
    ["ops-demo-install.yml", "install"],
    ["release-please.yml", "deploy-prod"],
    ["release-please.yml", "deploy-demo"],
  ];
  const guards = JOBS.map(([f, j]) => {
    const steps = jobSteps(f, j);
    const i = steps.findIndex((s) => s.name === GUARD);
    return { f, j, steps, i, step: steps[i] as Step };
  });

  for (const { f, j, steps, i, step } of guards) {
    it(`${f} ${j}: refuses before anything else uses the secret`, () => {
      expect(i, GUARD).toBeGreaterThanOrEqual(0);
      expect(step.env).toEqual({ OWNER: SECRET });
      expect(steps.findIndex(usesSecret)).toBe(i);
      // Nothing that installs, builds or changes state runs before it.
      for (const s of steps.slice(0, i))
        expect(JSON.stringify(s)).not.toMatch(/pnpm|wrangler|migrations/);
    });
  }

  it("the guard is one script everywhere (the tag's checkout can't share a file)", () => {
    expect(new Set(guards.map((g) => g.step.run)).size).toBe(1);
  });

  it("the guard refuses unset and unnormalized values, and never prints them", () => {
    const run = guards[0]?.step.run as string;
    expect(bash(run, { OWNER: "me@test.invalid" }).code).toBe(0);
    const unset = bash(run, { OWNER: "" });
    expect(unset.code).toBe(1);
    expect(unset.out).toContain("OA_OWNER_EMAIL is not set");
    for (const v of BAD) {
      const r = bash(run, { OWNER: v });
      expect(r.code, JSON.stringify(v)).toBe(1);
      expect(r.out).toContain("must be trimmed and lowercase");
      expect(r.out).not.toContain("test.invalid");
    }
  });

  it("deploy-staging refuses before its migrations", () => {
    const steps = jobSteps("deploy-staging.yml", "deploy");
    const guard = steps.findIndex((s) => s.name === GUARD);
    const migrate = steps.findIndex((s) =>
      String(s.run).includes("d1 migrations apply"),
    );
    expect(migrate).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(migrate);
  });
});

describe("the setup steps carry the address they need", () => {
  const cases: [string, string, string][] = [
    ["release-please.yml", "deploy-prod", "PROD_OWNER_EMAIL"],
    ["ops-prod-install.yml", "install", "PROD_OWNER_EMAIL"],
    ["release-please.yml", "deploy-demo", "DEMO_OWNER_EMAIL"],
    ["ops-demo-install.yml", "install", "DEMO_OWNER_EMAIL"],
  ];
  for (const [f, j, name] of cases)
    it(`${f} ${j}: ${name} on every step that runs setup`, () => {
      const need = jobSteps(f, j).filter((s) =>
        /prod-setup\.sh|oa:setup/.test(String(s.run)),
      );
      expect(need.length).toBeGreaterThan(0);
      for (const s of need) expect(s.env?.[name], s.name).toBe(SECRET);
    });
});

describe("deploy-hosted-platform.yml refuses before any target runs", () => {
  const steps = jobSteps("deploy-hosted-platform.yml", "deploy");
  const check = steps[0] as Step;
  const FULL =
    "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,provisioning,zones";
  const run = (TARGETS: string, OA_OWNER_EMAIL: string) =>
    bash(check.run, {
      TAG: "v1.2.3",
      TARGETS,
      REASON: TARGETS === FULL ? "" : "a reason",
      VERIFY_ONLY: "false",
      OA_OWNER_EMAIL,
    });

  it("is the job's first step", () => {
    expect(check.name).toBe("Check the inputs");
    expect(check.env.OA_OWNER_EMAIL).toBe(SECRET);
  });
  it("unset: refused when the targets include the scheduler", () => {
    for (const t of [FULL, "scheduler"]) {
      const r = run(t, "");
      expect(r.code, t).toBe(1);
      expect(r.out).toContain("OA_OWNER_EMAIL is not set");
    }
  });
  it("unset: fine for targets without the scheduler", () => {
    expect(run("dispatch", "").code).toBe(0);
  });
  it("set and normalized: passes", () => {
    expect(run(FULL, "me@test.invalid").code).toBe(0);
  });
  it("unnormalized: refused for any target, without printing it", () => {
    for (const v of BAD) {
      const r = run("dispatch", v);
      expect(r.code, JSON.stringify(v)).toBe(1);
      expect(r.out).toContain("must be trimmed and lowercase");
      expect(r.out).not.toContain("test.invalid");
    }
  });
});

describe("a failed verify never prints the address", () => {
  const script = read("scripts/ops/deploy-hosted-platform.sh");
  it("ALERT_TO and the ALERT_EMAIL destination use the quiet check", () => {
    expect(script).toMatch(
      /expect_private "\$S" '\[\.result\.bindings\[\] \| select\(\.name == "ALERT_TO"\)/,
    );
    expect(script).toMatch(
      /expect_private "\$S" '\[\.result\.bindings\[\] \| select\(\.name == "ALERT_EMAIL"\)/,
    );
    // Only the values: ALERT_EMAIL's binding type isn't an address.
    expect(script).not.toMatch(
      /expect "\$S" '\[\.result\.bindings\[\] \| select\(\.name == "ALERT_(TO|EMAIL)"\)/,
    );
  });
  it("expect_private names the field, not its values", () => {
    const fn = /^expect_private\(\) \{\n[\s\S]*?^\}\n/m.exec(script)?.[0];
    expect(fn).toBeDefined();
    const call = (got: string) =>
      bash(
        `${fn}expect_private '{"a":"${got}"}' .a new@test.invalid ALERT_TO`,
        {},
      );
    expect(call("new@test.invalid").code).toBe(0);
    const r = call("old@test.invalid");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ALERT_TO");
    expect(r.out).not.toContain("test.invalid");
  });
});

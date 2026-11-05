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

// The hosted deploy's guard (deploy-hosted-platform.yml and its script) is
// tested in owner-email-guard-hosted.test.ts, a private path (#1056).

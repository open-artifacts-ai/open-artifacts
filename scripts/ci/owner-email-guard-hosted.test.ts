// #1084, hosted half: the owner's address guard on the hosted platform deploy.
// Moved from owner-email-guard.test.ts so the public repo tests without the
// hosted workflow and deploy script (#1056); this file is a private path.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "${{ secrets.OA_OWNER_EMAIL }}";
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

const BAD = ["Me@Test.Invalid", " me@test.invalid", "me@test.invalid\n"];

describe("deploy-hosted-platform.yml refuses before any target runs", () => {
  const steps = jobSteps("deploy-hosted-platform.yml", "deploy");
  const check = steps[0] as Step;
  const FULL =
    "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,provisioning,zones";
  const run = (TARGETS: string, OA_OWNER_EMAIL: string) =>
    bash(check.run, {
      DEPLOY_ENV: "prod",
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

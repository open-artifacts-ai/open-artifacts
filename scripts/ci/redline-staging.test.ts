// redline-staging.yml: the red-line suite against rl-a and rl-b, on demand.
// Secrets live only in the redline-staging Environment and reach the suite as
// 0600 files by path; no other step sees them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(
  join(root, ".github/workflows/redline-staging.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const w: any = parse(text);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const job: any = w.jobs.redline;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
const SHA_PIN =
  /^(actions\/(checkout|upload-artifact|setup-node)|pnpm\/action-setup)@[0-9a-f]{40}$/;
const SECRETS = [
  "REDLINE_RL_A_PAT",
  "REDLINE_RL_A_HOOK_KEY",
  "REDLINE_RL_B_PAT",
  "REDLINE_RL_B_HOOK_KEY",
  "REDLINE_STG_INVENTORY_KEY",
];

describe("redline-staging.yml", () => {
  it("runs only on demand, in the redline-staging Environment, read-only and bounded", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(Object.keys(w.jobs)).toEqual(["redline"]);
    expect(job.environment).toBe("redline-staging");
    expect(job.permissions).toBeUndefined();
    expect(job["timeout-minutes"]).toBe(45);
    expect(w.concurrency).toEqual({
      group: "redline",
      "cancel-in-progress": false,
    });
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const s of steps) if (s.uses) expect(s.uses).toMatch(SHA_PIN);
    expect(steps[0]?.with?.["persist-credentials"]).toBe(false);
    for (const s of steps) expect(s.with?.cache).toBeUndefined();
  });

  it("only the write step sees secrets, through env, and it writes 0600 files", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets).toHaveLength(1);
    const st = withSecrets[0] as Record<string, any>;
    expect(st.run).not.toContain("secrets.");
    expect(Object.values(st.env as object).sort()).toEqual(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expressions
      SECRETS.map((n) => "${{ secrets." + n + " }}").sort(),
    );
    expect(st.run).toMatch(/^set -euo pipefail\numask 077\n/);
    for (const n of SECRETS) expect(st.run).toContain(`> "$d/${n}"`);
    expect(job.env).toBeUndefined();
    expect(w.env).toBeUndefined();
  });

  it("the suite gets the secrets dir by path, runs live without the gate, and the files are removed", () => {
    const run = steps.find((s) => (s.run ?? "").includes("@oa/redline live"));
    expect(run?.run).toContain(
      `jq -c --arg d "$RUNNER_TEMP/redline-secrets" '. + {secretsDir: $d}'`,
    );
    expect(run?.run).not.toMatch(/--gate|REDLINE_GATE/);
    expect(JSON.stringify(run)).not.toContain("secrets.");
    const rm = steps.find((s) => (s.run ?? "").includes("rm -rf"));
    expect(rm?.if).toBe("always()");
    expect(rm?.run).toBe('rm -rf "$RUNNER_TEMP/redline-secrets"');
    expect(steps.indexOf(rm as object)).toBeGreaterThan(
      steps.indexOf(run as object),
    );
  });

  it("order: install, build, write the secrets, run the suite, scan, remove", () => {
    const at = (pred: (s: Record<string, any>) => boolean) =>
      steps.findIndex(pred);
    const install = at((s) => s.run === "pnpm install --frozen-lockfile");
    const build = at((s) => s.run === "pnpm --filter @oa/provision build");
    const write = at((s) => JSON.stringify(s).includes("secrets."));
    const suite = at((s) => (s.run ?? "").includes("@oa/redline live"));
    const scan = at((s) => s.id === "scan");
    const rm = at((s) => (s.run ?? "").includes("rm -rf"));
    expect(install).toBeGreaterThan(-1);
    expect([install, build, write, suite, scan, rm]).toEqual(
      [install, build, write, suite, scan, rm].slice().sort((x, y) => x - y),
    );
    expect(new Set([install, build, write, suite, scan, rm]).size).toBe(6);
    // Nothing but the suite runs code while the secret files exist.
    expect(steps.slice(write + 1, rm).map((s) => s.id ?? s.name)).toEqual([
      "Run the suite",
      "scan",
    ]);
    expect(
      steps.filter((s) => (s.run ?? "").includes("@oa/provision build")),
    ).toHaveLength(1);
  });

  it("a secret file's contents anywhere in the report fails the job and stops the upload", () => {
    const scan = steps.find((s) => s.id === "scan");
    expect(scan?.if).toBe("always()");
    expect(scan?.run).toContain('[ -d "$d" ] && [ -d "$r" ] || exit 0');
    expect(scan?.run).toContain(
      'if grep -rqF -- "$(cat "$f")" "$r"; then echo "secret in report: ${f##*/}"; exit 1; fi',
    );
    const up = steps.find((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up?.if).toBe("always() && steps.scan.outcome == 'success'");
    expect(steps.indexOf(up as object)).toBeGreaterThan(
      steps.indexOf(scan as object),
    );
  });

  it("uploads only the report directory", () => {
    const up = steps.filter((s) =>
      String(s.uses ?? "").startsWith("actions/upload-artifact"),
    );
    expect(up).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(up[0]?.with?.path).toBe("${{ runner.temp }}/redline-report");
    expect(text).not.toMatch(/redline-secrets[^"\n]*\n[^\n]*upload/);
  });

  it("the live suite prints each case as it runs and still writes the report", () => {
    const cfg = readFileSync(
      join(root, "tests/redline/vitest.live.config.ts"),
      "utf8",
    );
    expect(cfg).toContain('reporters: ["verbose", "./src/reporter.ts"],');
  });
});

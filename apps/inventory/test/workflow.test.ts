import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { MONITOR_WORKFLOW } from "../src/prodclean.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const raw = readFileSync(join(ROOT, MONITOR_WORKFLOW), "utf8");
const wf = parse(raw) as {
  on: Record<string, unknown>;
  permissions: unknown;
  jobs: Record<
    string,
    {
      if?: string;
      environment?: string;
      permissions?: unknown;
      "timeout-minutes"?: number;
      steps: {
        uses?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
        if?: string;
      }[];
    }
  >;
};
const wrangler = JSON.parse(
  readFileSync(join(ROOT, "apps/inventory/wrangler.jsonc"), "utf8").replace(
    /^\s*\/\/.*$/gm,
    "",
  ),
) as { env: { prod: { vars: Record<string, string> } } };
const job = wf.jobs.monitor;
if (!job) throw new Error("no monitor job");
const steps = job.steps;

describe("prodclean-monitor.yml", () => {
  it("runs hourly and on dispatch only", () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    const s = wf.on.schedule as { cron: string }[];
    expect(s).toHaveLength(1);
    expect(s[0]?.cron).toMatch(/^\d{1,2} \* \* \* \*$/);
  });

  it("has exactly contents: read and id-token: write, on the one job", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(["monitor"]);
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("runs in the environment the prod inventory pins", () => {
    expect(job.environment).toBe(wrangler.env.prod.vars.OIDC_ENVIRONMENT);
  });

  it("every action is pinned to a full SHA; checkout keeps no credentials", () => {
    const uses = steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    // The same SHAs as redline-staging.yml.
    const redline = readFileSync(
      join(ROOT, ".github/workflows/redline-staging.yml"),
      "utf8",
    );
    for (const u of uses) expect(redline).toContain(u);
    const co = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(co?.with?.["persist-credentials"]).toBe(false);
  });

  it("no secret reaches a run: string or argv; only env of the file-writing step", () => {
    for (const s of steps) {
      expect(s.run ?? "", "run").not.toMatch(/\$\{\{\s*secrets\./);
      const secretEnv = Object.values(s.env ?? {}).filter((v) =>
        /secrets\./.test(v),
      );
      if (secretEnv.length > 0) {
        expect(s.run).toMatch(/umask 077/);
        expect(s.run).toMatch(/set \+x/);
      }
    }
    const withSecrets = steps.filter((s) =>
      Object.values(s.env ?? {}).some((v) => /secrets\./.test(v)),
    );
    expect(withSecrets).toHaveLength(1);
    expect(Object.values(withSecrets[0]?.env ?? {}).sort()).toEqual([
      "${{ secrets.REDLINE_PROD_R2_TOKEN }}",
      "${{ secrets.REDLINE_PROD_SCRIPTS_TOKEN }}",
    ]);
  });

  it("prints nothing itself: no echo, and printf only into the token files", () => {
    for (const s of steps) {
      const run = s.run ?? "";
      expect(run).not.toMatch(
        /\becho\b|::(notice|warning|error|debug)|GITHUB_STEP_SUMMARY|\btee\b|\bcat\b/,
      );
      for (const line of run.split("\n").filter((l) => /printf/.test(l)))
        expect(line).toMatch(
          /printf '%s' "\$PROD_\w+" > "\$d\/REDLINE_PROD_\w+"/,
        );
    }
  });

  it("opens no issue", () => {
    for (const s of steps) {
      expect(s.run ?? "").not.toMatch(/\bgh\b|api\.github\.com/);
      expect(s.uses ?? "").not.toMatch(/github-script|issue/);
    }
  });

  it("runs the monitor script with the prod inventory's audience; files removed always", () => {
    const run = steps.find((s) => s.run?.includes("prodclean-monitor.ts"));
    expect(run?.run).toBe("node apps/inventory/scripts/prodclean-monitor.ts");
    expect(
      existsSync(join(ROOT, "apps/inventory/scripts/prodclean-monitor.ts")),
    ).toBe(true);
    expect(run?.env).toEqual({
      INVENTORY_URL: "${{ vars.REDLINE_PROD_INVENTORY_URL }}",
      INVENTORY_OIDC_AUDIENCE: wrangler.env.prod.vars.OIDC_AUDIENCE,
      REDLINE_PROD_ACCOUNT_ID: "${{ vars.REDLINE_PROD_ACCOUNT_ID }}",
      REDLINE_PROD_SECRETS_DIR: "${{ runner.temp }}/prodclean-secrets",
      NODE_NO_WARNINGS: "1",
    });
    expect(run?.env?.INVENTORY_OIDC_AUDIENCE).toBe("https://oa-p-inventory");
    const last = steps.at(-1);
    expect(last?.if).toBe("${{ always() }}");
    expect(last?.run).toBe('rm -rf "$RUNNER_TEMP/prodclean-secrets"');
    // The token files exist only after the build, and only for the script.
    const write = steps.findIndex((s) => s.run?.includes("umask 077"));
    const build = steps.findIndex((s) =>
      s.run?.includes("@oa/provision build"),
    );
    expect(build).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(build);
  });
});

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
      needs?: unknown;
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
const buildJob = wf.jobs.build;
if (!buildJob) throw new Error("no build job");
const buildSteps = buildJob.steps;
const allSteps = [...buildSteps, ...steps];
const pkg = JSON.parse(
  readFileSync(join(ROOT, "apps/inventory/package.json"), "utf8"),
) as { scripts: Record<string, string> };
const SETUP_NODE =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
const DOWNLOAD =
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
const UPLOAD =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02";

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

  it("two jobs: build has contents: read only, monitor has id-token: write only", () => {
    expect(wf.permissions).toEqual({});
    expect(Object.keys(wf.jobs)).toEqual(["build", "monitor"]);
    expect(buildJob.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ "id-token": "write" });
    for (const j of [buildJob, job]) {
      expect(j.if).toBe("github.ref == 'refs/heads/main'");
      expect(j["timeout-minutes"]).toBeGreaterThan(0);
    }
    expect(job.needs).toBe("build");
    expect(buildJob.needs).toBeUndefined();
  });

  it("build: no environment, no secrets, no id-token; bundles and uploads the script", () => {
    expect(buildJob.environment).toBeUndefined();
    for (const s of buildSteps) {
      const text = JSON.stringify(s);
      expect(text).not.toMatch(/secrets\.|id-token|ACTIONS_ID_TOKEN/);
    }
    const runs = buildSteps.flatMap((s) => (s.run ? [s.run] : []));
    expect(runs).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm --filter @oa/provision build",
      "pnpm --filter @oa/inventory bundle:monitor",
      expect.stringContaining(
        'env -i PATH="$PATH" node apps/inventory/dist/prodclean-monitor.mjs',
      ),
    ]);
    // The smoke step expects the fail-closed line and a non-zero exit, so a
    // bundle that never runs its entry point fails the build job.
    const smoke = runs.at(-1) ?? "";
    expect(smoke).toContain('[ "$out" = "prod-clean: fail (not_configured)" ]');
    expect(smoke).toContain('[ "$code" -ne 0 ]');
    // One self-contained ESM file for node, at the .nvmrc version.
    expect(pkg.scripts["bundle:monitor"]).toBe(
      "esbuild scripts/prodclean-monitor.ts --bundle --platform=node --format=esm --target=node$(cat ../../.nvmrc) --log-level=warning --outfile=dist/prodclean-monitor.mjs",
    );
    const up = buildSteps.at(-1);
    expect(up?.uses?.split(" ")[0]).toBe(UPLOAD);
    expect(up?.with).toEqual({
      name: "prodclean-monitor",
      path: "apps/inventory/dist/prodclean-monitor.mjs",
      "retention-days": 1,
      "if-no-files-found": "error",
    });
  });

  it("monitor: only setup-node and download-artifact, no checkout, install or build", () => {
    const uses = steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses).toEqual([SETUP_NODE, DOWNLOAD]);
    for (const s of steps)
      expect(s.run ?? "").not.toMatch(
        /\b(pnpm|npm|npx|yarn|corepack)\b|install|build/,
      );
    const nvmrc = readFileSync(join(ROOT, ".nvmrc"), "utf8").trim();
    const node = steps.find((s) => s.uses === SETUP_NODE);
    expect(node?.with).toEqual({ "node-version": nvmrc });
    const dl = steps.find((s) => s.uses === DOWNLOAD);
    expect(dl?.with).toEqual({
      name: "prodclean-monitor",
      path: "${{ runner.temp }}/prodclean-bundle",
    });
  });

  it("runs in the environment the prod inventory pins", () => {
    expect(job.environment).toBe(wrangler.env.prod.vars.OIDC_ENVIRONMENT);
  });

  it("every action is pinned to a full SHA; checkout keeps no credentials", () => {
    const uses = allSteps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    // The same SHAs as redline-staging.yml, plus download-artifact (v4.3.0).
    const redline = readFileSync(
      join(ROOT, ".github/workflows/redline-staging.yml"),
      "utf8",
    );
    for (const u of uses) if (u !== DOWNLOAD) expect(redline).toContain(u);
    const co = buildSteps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(co?.with?.["persist-credentials"]).toBe(false);
  });

  it("no secret reaches a run: string or argv; only env of the file-writing step", () => {
    for (const s of allSteps) {
      expect(s.run ?? "", "run").not.toMatch(/\$\{\{\s*secrets\./);
      const secretEnv = Object.values(s.env ?? {}).filter((v) =>
        /secrets\./.test(v),
      );
      if (secretEnv.length > 0) {
        expect(s.run).toMatch(/umask 077/);
        expect(s.run).toMatch(/set \+x/);
      }
    }
    const withSecrets = allSteps.filter((s) =>
      Object.values(s.env ?? {}).some((v) => /secrets\./.test(v)),
    );
    expect(withSecrets).toHaveLength(1);
    expect(Object.values(withSecrets[0]?.env ?? {}).sort()).toEqual([
      "${{ secrets.REDLINE_PROD_R2_TOKEN }}",
      "${{ secrets.REDLINE_PROD_SCRIPTS_TOKEN }}",
    ]);
  });

  it("prints nothing itself: no echo, and printf only into the token files", () => {
    for (const s of allSteps) {
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
    for (const s of allSteps) {
      expect(s.run ?? "").not.toMatch(/\bgh\b|api\.github\.com/);
      expect(s.uses ?? "").not.toMatch(/github-script|issue/);
    }
  });

  it("runs the monitor script with the prod inventory's audience; files removed always", () => {
    const run = steps.find((s) => s.run?.includes("prodclean-monitor.mjs"));
    expect(run?.run).toBe(
      'node "$RUNNER_TEMP/prodclean-bundle/prodclean-monitor.mjs"',
    );
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
    // The token files exist only after the download, and only for the script.
    const write = steps.findIndex((s) => s.run?.includes("umask 077"));
    const dl = steps.findIndex((s) => s.uses === DOWNLOAD);
    const script = steps.indexOf(run as (typeof steps)[number]);
    expect(dl).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(dl);
    expect(script).toBe(write + 1);
  });
});

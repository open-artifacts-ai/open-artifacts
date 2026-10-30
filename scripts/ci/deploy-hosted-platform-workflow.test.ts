// deploy-hosted-platform.yml: one env's hosted platform Workers deploy by hand
// only, from a stable tag that passed the release gate, in that env's
// main-only Environment (no approval step), with main's deploy scripts and the
// tag's code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root } from "./stubs.ts";

const text = readFileSync(
  join(root, ".github/workflows/deploy-hosted-platform.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const w: any = parse(text);
const job = w.jobs.deploy;
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
const steps: Record<string, any>[] = job.steps;
const named = (n: string) =>
  steps.find((s) => s.name === n) as Record<string, any>;

describe("deploy-hosted-platform.yml", () => {
  it("runs only on dispatch, read-only, one at a time, in the env's Environment", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    const inputs = w.on.workflow_dispatch.inputs;
    expect(inputs.tag.required).toBe(true);
    expect(inputs.env).toMatchObject({
      type: "choice",
      options: ["staging", "prod"],
      required: true,
    });
    expect(inputs.verify_only).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(w.permissions).toEqual({ contents: "read", actions: "read" });
    expect(Object.keys(inputs).sort()).toEqual([
      "env",
      "tag",
      "targets",
      "verify_only",
    ]);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    expect(w.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      group: "hosted-platform-${{ inputs.env }}",
      "cancel-in-progress": false,
    });
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
  });

  it("pins every action by SHA and keeps no git credentials", () => {
    for (const l of text.split("\n").filter((l) => /^\s*- uses: /.test(l)))
      expect(l).toMatch(/@[0-9a-f]{40} # v\d/);
    for (const s of steps.filter((s) => s.uses)) {
      expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
      if (String(s.uses).startsWith("actions/checkout@"))
        expect(s.with["persist-credentials"]).toBe(false);
    }
  });

  it("deploys the tag's code with main's deploy scripts", () => {
    const outs = steps.filter((s) =>
      String(s.uses).startsWith("actions/checkout@"),
    );
    expect(outs).toHaveLength(3);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(outs[1]?.with.ref).toBe("refs/tags/${{ inputs.tag }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(outs[2]?.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".deploy-logic",
      "sparse-checkout": "scripts/ops\npackages/provision/src\n",
    });
    expect(named("The checkout is exactly the tag").run).toContain(
      'test "$(git describe --tags --exact-match)" = "$TAG"',
    );
    const use = named("Use main's deploy scripts").run as string;
    expect(use).toContain(
      "deploy-hosted-platform.sh deploy-platform-worker.sh",
    );
    // The broker's Google client pin is main's, never the tag's.
    expect(use).toContain(
      'cp .deploy-logic/packages/provision/src/wfp.ts "$RUNNER_TEMP/main-wfp.ts"',
    );
    expect(named("Deploy and verify").env.BROKER_PIN_FILE).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ runner.temp }}/main-wfp.ts",
    );
    expect(steps.indexOf(named("Use main's deploy scripts"))).toBeLessThan(
      steps.indexOf(named("Deploy and verify")),
    );
  });

  it("only the deploy step sees secrets, through env, exactly these", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual([
      "Deploy and verify",
      "Zones",
    ]);
    // The zone token is in the Zones step only.
    expect(JSON.stringify(named("Deploy and verify"))).not.toContain(
      "ZONE_TOKEN",
    );
    expect(named("Zones").env.ZONE_TOKEN).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ secrets.ZONE_TOKEN }}",
    );
    const env = named("Deploy and verify").env as Record<string, string>;
    const secrets = Object.entries(env)
      .filter(([, v]) => v.includes("secrets."))
      .map(([k]) => k)
      .sort();
    expect(secrets).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
      "INVENTORY_KEY",
    ]);
    // The same names in each env's Environment: no env-specific secret names.
    expect(JSON.stringify(env)).not.toMatch(/PROD_|STAGING_/);
    expect(env.CLOUDFLARE_API_TOKEN).toBe("${{ secrets.DEPLOY_TOKEN }}");
    expect(env.VERIFY_ONLY).toBe("${{ inputs.verify_only && '1' || '' }}");
    expect(named("Deploy and verify").run).not.toContain("secrets.");
    expect(named("Deploy and verify").run).toContain(
      'bash scripts/ops/deploy-hosted-platform.sh "$DEPLOY_ENV" "$t"',
    );
  });

  it("the release gate runs main's script right after the input check, before the tag checkout, for both envs", () => {
    const gate = named("The tag passed every earlier check");
    const i = steps.indexOf(gate);
    expect(steps.indexOf(named("Check the inputs"))).toBe(i - 2);
    expect(steps[i - 1]?.with).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      ref: "${{ github.sha }}",
      path: ".release-gate",
      "sparse-checkout": "scripts/ci",
      "persist-credentials": false,
    });
    expect(gate.if).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(gate.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(gate.run).toContain(
      'bash .release-gate/scripts/ci/tag-passed-checks.sh "$DEPLOY_ENV" "$TAG"',
    );
    const tagOut = steps.find(
      (s) =>
        String(s.uses).startsWith("actions/checkout@") &&
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
        s.with.ref === "refs/tags/${{ inputs.tag }}",
    );
    expect(i).toBeLessThan(steps.indexOf(tagOut as Record<string, unknown>));
  });

  it("zones plan, then apply in the same job; verify_only stays plan only", () => {
    const z = named("Zones");
    expect(z.env.VERIFY_ONLY).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ inputs.verify_only && '1' || '' }}",
    );
    expect(text).not.toContain("apply_zones");
    const lines = (z.run as string).trim().split("\n");
    expect(lines).toEqual([
      "set -euo pipefail",
      'bash scripts/ops/hosted-zones.sh "$DEPLOY_ENV" plan',
      '[ -n "$VERIFY_ONLY" ] || bash scripts/ops/hosted-zones.sh "$DEPLOY_ENV" apply',
    ]);
    expect(steps.indexOf(z)).toBeGreaterThan(
      steps.indexOf(named("Deploy and verify")),
    );
  });

  it("prod runs only from main, checked in the workflow and again in the script", () => {
    const s = named("Prod runs only from main");
    expect(s.if).toBe("${{ inputs.env == 'prod' }}");
    expect(s.run).toBe('test "$REF" = refs/heads/main');
    expect(named("Deploy and verify").env.DEPLOY_ENVIRONMENT).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
  });

  it("the input check accepts known targets in order and refuses anything else", () => {
    const check = named("Check the inputs").run as string;
    const go = (TAG: string, TARGETS: string) =>
      spawnSync("bash", ["-c", check], {
        env: { PATH: process.env.PATH, TAG, TARGETS },
        encoding: "utf8",
      }).status;
    expect(
      go("v0.74.1", "auth-broker,directory-broker,dispatch,scheduler"),
    ).toBe(0);
    expect(go("v0.74.1", "inventory-key")).toBe(0);
    expect(go("v0.74.1", "inventory,inventory-key,zones")).toBe(0);
    expect(go("v0.74.1", "zones,dispatch")).toBe(1);
    expect(go("v0.74.1", "dispatch,scheduler")).toBe(0);
    for (const [tag, t] of [
      ["0.74.1", "dispatch"],
      ["v0.74.1-rc.1", "dispatch"],
      ["main", "dispatch"],
      ["v0.74.1", "scheduler,dispatch"],
      ["v0.74.1", "dispatch,dispatch"],
      ["v0.74.1", "bogus"],
      ["v0.74.1", "dispatch;rm -rf /"],
      ["v0.74.1", ""],
    ])
      expect(go(tag as string, t as string), `${tag} ${t}`).toBe(1);
  });
});

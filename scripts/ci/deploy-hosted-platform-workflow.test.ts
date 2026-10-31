// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
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
    expect(w.permissions).toEqual({
      contents: "read",
      actions: "read",
      issues: "write",
    });
    expect(Object.keys(inputs).sort()).toEqual([
      "env",
      "tag",
      "targets",
      "verify_only",
    ]);
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBe(
      "${{ inputs.env == 'prod' && 'hosted-prod-deploy' || 'hosted-staging-deploy' }}",
    );
    expect(w.concurrency).toEqual({
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
    expect(outs[1]?.with.ref).toBe("refs/tags/${{ inputs.tag }}");
    expect(outs[2]?.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".deploy-logic",
      "sparse-checkout":
        "scripts/ops\nscripts/ci\npackages/provision/src\n.github/hosted\n",
    });
    expect(named("The checkout is exactly the tag").run).toContain(
      'test "$(git describe --tags --exact-match)" = "$TAG"',
    );
    const use = named("Use main's deploy scripts").run as string;
    expect(use).toContain(
      "for f in deploy-hosted-platform.sh deploy-platform-worker.sh hosted-zones.sh platform-db.mjs check-migration-lock.mjs wrangler-env.mjs broker-key.mjs; do",
    );
    // The broker's Google client pin is main's, never the tag's.
    expect(use).toContain(
      'cp .deploy-logic/packages/provision/src/wfp.ts "$RUNNER_TEMP/main-wfp.ts"',
    );
    expect(named("Deploy and verify").env.BROKER_PIN_FILE).toBe(
      "${{ runner.temp }}/main-wfp.ts",
    );
    expect(steps.indexOf(named("Use main's deploy scripts"))).toBeLessThan(
      steps.indexOf(named("Deploy and verify")),
    );
    // The constants and the id lookup are main's too, never the tag's.
    expect(use).toContain(
      "for f in hosted-cf.sh hosted-constants.sh hosted-resource-ids.sh staging-first-gate.sh deploy-token-expiry.sh; do",
    );
    expect(use).toContain(
      'cp -R .deploy-logic/.github/hosted "$RUNNER_TEMP/main-ci/hosted"',
    );
  });

  it("loads main's committed constants, then resolves the resource ids, before deploying; no variables", () => {
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Use main's deploy scripts")).toBeLessThan(
      i("Load the hosted constants"),
    );
    expect(i("Load the hosted constants")).toBe(
      i("Resolve the resource ids") - 1,
    );
    expect(i("Resolve the resource ids")).toBe(i("Deploy and verify") - 1);
    expect(named("Load the hosted constants")).toMatchObject({
      env: { DEPLOY_ENV: "${{ inputs.env }}" },
      run: 'bash "$RUNNER_TEMP/main-ci/hosted-constants.sh" "$DEPLOY_ENV" "$RUNNER_TEMP/main-ci/hosted"',
    });
    expect(named("Resolve the resource ids")).toMatchObject({
      env: {
        DEPLOY_ENV: "${{ inputs.env }}",
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      },
      run: 'bash "$RUNNER_TEMP/main-ci/hosted-resource-ids.sh" "$DEPLOY_ENV"',
    });
    expect(Object.keys(named("Resolve the resource ids").env)).toHaveLength(2);
    expect(named("Load the hosted constants").if).toBeUndefined();
    // Only the targets that bind an id (or the zone tag) look them up.
    const cond = named("Resolve the resource ids").if as string;
    const runsFor = (targets: string) => {
      const js = cond
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")
        .replace(
          /contains\(format\(',\{0\},', inputs\.targets\), '([^']*)'\)/g,
          (_, t) => JSON.stringify(`,${targets},`.includes(t)),
        );
      expect(js).toMatch(/^(true|false|\|\|| )+$/);
      return new Function(`return (${js});`)() as boolean;
    };
    for (const t of [
      "platform-db",
      "auth-broker",
      "directory-broker",
      "provision-token",
      "provisioner",
      "dispatch",
      "scheduler",
      "inventory",
      "provisioning",
      "auth-broker,directory-broker,dispatch,scheduler",
      "inventory,inventory-key,zones",
    ])
      expect(runsFor(t), t).toBe(true);
    for (const t of ["inventory-key", "zones", "inventory-key,zones"])
      expect(runsFor(t), t).toBe(false);
    // Everything the user used to copy into the Environment comes from these.
    expect(text).not.toContain("vars.");
    for (const k of [
      "CLOUDFLARE_ACCOUNT_ID",
      "PLATFORM_DB_ID",
      "HOSTS_KV_ID",
      "BROKER_REGISTRY_ID",
      "DIRECTORY_REGISTRY_ID",
      "EMAIL_ZONE_TAGS",
      "EMAIL_DAILY_LIMIT",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_DIRECTORY_CLIENT_ID",
    ])
      expect(named("Deploy and verify").env[k], k).toBeUndefined();
  });

  it("only the id lookup, deploy and zones steps see secrets, through env, exactly these", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual([
      "Resolve the resource ids",
      "Deploy and verify",
      "Zones",
      "The deploy token's expiry",
    ]);
    // One Cloudflare token for everything; the old names are gone.
    for (const old of ["DEPLOY_TOKEN", "ZONE_TOKEN", "PROVISION_TOKEN"])
      expect(text).not.toContain(old);
    expect(named("Zones").env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      VERIFY_ONLY: "${{ inputs.verify_only && '1' || '' }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
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
    expect(env.CLOUDFLARE_API_TOKEN).toBe(
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
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
      ref: "${{ github.sha }}",
      path: ".release-gate",
      "sparse-checkout": "scripts/ci",
      "persist-credentials": false,
    });
    expect(gate.if).toBeUndefined();
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
        s.with.ref === "refs/tags/${{ inputs.tag }}",
    );
    expect(i).toBeLessThan(steps.indexOf(tagOut as Record<string, unknown>));
  });

  it("zones plan, then apply in the same job; verify_only stays plan only", () => {
    const z = named("Zones");
    expect(z.env.VERIFY_ONLY).toBe("${{ inputs.verify_only && '1' || '' }}");
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
    expect(
      go(
        "v0.74.1",
        "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,inventory-key,provisioning,zones",
      ),
    ).toBe(0);
    expect(go("v0.74.1", "provisioning,provisioner")).toBe(1);
    expect(go("v0.74.1", "provisioner,provision-token")).toBe(1);
    expect(go("v0.74.1", "auth-broker,platform-db")).toBe(1);
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

  it("the order puts every bound target before its binder (design v7 10.2)", () => {
    const check = named("Check the inputs").run as string;
    const order = (/order="([^"]+)"/.exec(check)?.[1] ?? "").split(" ");
    expect(order).toEqual([
      "platform-db",
      "auth-broker",
      "directory-broker",
      "provision-token",
      "provisioner",
      "dispatch",
      "scheduler",
      "inventory",
      "inventory-key",
      "provisioning",
      "zones",
    ]);
    // What each app binds, from its committed config (prod block).
    const strip = (src: string) =>
      src
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, q) => q ?? "")
        .replace(/,(\s*[}\]])/g, "$1");
    const bound = (app: string): string[] => {
      const cfg = JSON.parse(
        strip(readFileSync(join(root, `apps/${app}/wrangler.jsonc`), "utf8")),
      ).env.prod;
      const out = new Set<string>();
      if (cfg.d1_databases?.length) out.add("platform-db");
      for (const s of cfg.services ?? []) out.add(String(s.service).replace(/^oa-p-/, ""));
      for (const wf of cfg.workflows ?? [])
        if (wf.script_name) out.add(String(wf.script_name).replace(/^oa-p-/, ""));
      for (const s of cfg.secrets_store_secrets ?? [])
        if (String(s.secret_name).endsWith("-provision-token")) out.add("provision-token");
      return [...out];
    };
    const apps = ["auth-broker", "directory-broker", "provisioner", "dispatch", "scheduler", "inventory", "provisioning"];
    for (const app of apps)
      for (const dep of bound(app)) {
        expect(order, `${app} binds ${dep}`).toContain(dep);
        expect(order.indexOf(dep), `${dep} before ${app}`).toBeLessThan(order.indexOf(app));
      }
    expect(bound("provisioning")).toEqual(
      expect.arrayContaining(["platform-db", "provisioner", "auth-broker"]),
    );
    expect(bound("provisioner")).toEqual(
      expect.arrayContaining(["platform-db", "provision-token"]),
    );
    // The zones route to every Worker, so they come last.
    expect(order.at(-1)).toBe("zones");
  });

  it("prod's provisioner and provisioning wait for a green staging run of the tag, before anything deploys", () => {
    const g = named("Staging passed this tag");
    expect(g.run).toBe('bash "$RUNNER_TEMP/main-ci/staging-first-gate.sh" "$TAG"');
    expect(g.env).toEqual({
      TAG: "${{ inputs.tag }}",
      GH_TOKEN: "${{ github.token }}",
    });
    const runsFor = (env: string, targets: string) =>
      new Function(
        "inputs",
        `return (${(g.if as string)
          .replace(/^\$\{\{\s*/, "")
          .replace(/\s*\}\}$/, "")
          .replace(
            /contains\(format\(',\{0\},', inputs\.targets\), '([^']*)'\)/g,
            (_, t) => JSON.stringify(`,${targets},`.includes(t)),
          )});`,
      )({ env }) as boolean;
    expect(runsFor("prod", "provisioner")).toBe(true);
    expect(runsFor("prod", "platform-db,provisioning,zones")).toBe(true);
    expect(runsFor("prod", "provision-token,dispatch")).toBe(false);
    expect(runsFor("staging", "provisioner,provisioning")).toBe(false);
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Use main's deploy scripts")).toBeLessThan(i("Staging passed this tag"));
    expect(i("Staging passed this tag")).toBeLessThan(i("Deploy and verify"));
  });

  it("builds and tests the Provisioning API Workers and the admin SPA too", () => {
    const run = named("Build and test the Workers being deployed").run as string;
    for (const p of ["@oa/provisioner", "@oa/provisioning", "@oa/admin"])
      expect(run).toContain(`--filter ${p}`);
  });

  it("passes the repository id for the OIDC principals, and reads back the token's expiry last", () => {
    expect(named("Deploy and verify").env.GITHUB_REPOSITORY_ID).toBe(
      "${{ github.repository_id }}",
    );
    const e = named("The deploy token's expiry");
    expect(steps.at(-1)).toBe(e);
    expect(e.if).toBe("${{ !cancelled() }}");
    expect(e.run).toBe('bash "$RUNNER_TEMP/main-ci/deploy-token-expiry.sh" "$DEPLOY_ENV"');
    expect(e.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      GH_TOKEN: "${{ github.token }}",
    });
  });
});

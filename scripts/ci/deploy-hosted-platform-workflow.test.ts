// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal workflow expressions
// deploy-hosted-platform.yml: one env's hosted platform Workers deploy by hand
// only, from a stable tag that passed the release gate, in that env's
// main-only Environment (no approval step), with main's deploy scripts and the
// tag's code.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,provisioning,zones";

describe("deploy-hosted-platform.yml", () => {
  it("one version (#1040): the default is every target, in order; required", () => {
    const t = w.on.workflow_dispatch.inputs.targets;
    expect(t.default).toBe(FULL);
    expect(t.required).toBe(true);
    // The order the input check enforces.
    const check = named("Check the inputs").run as string;
    expect(/order="([^"]+)"/.exec(check)?.[1]?.split(" ").join(",")).toBe(FULL);
    // The scheduler refuses without alert_to, so both envs commit one.
    for (const e of ["staging", "prod"])
      expect(
        JSON.parse(readFileSync(join(root, `.github/hosted/${e}.json`), "utf8"))
          .alert_to,
        e,
      ).toBeDefined();
  });
  it("names each run after its env and tag", () => {
    expect(w["run-name"]).toBe(
      "deploy-hosted-platform ${{ inputs.env }} ${{ inputs.tag }}",
    );
  });
  it("break-glass: fewer targets need a reason, checked before any checkout; verify_only is exempt", () => {
    expect(w.on.workflow_dispatch.inputs.reason).toMatchObject({
      type: "string",
      default: "",
    });
    const c = named("Check the inputs");
    expect(steps.indexOf(c)).toBe(0);
    expect(c.env).toEqual({
      TAG: "${{ inputs.tag }}",
      TARGETS: "${{ inputs.targets }}",
      REASON: "${{ inputs.reason }}",
      VERIFY_ONLY: "${{ inputs.verify_only }}",
    });
    const go = (TARGETS: string, REASON: string, VERIFY_ONLY = "false") =>
      spawnSync("bash", ["-c", c.run], {
        env: {
          PATH: process.env.PATH,
          TAG: "v0.90.3",
          TARGETS,
          REASON,
          VERIFY_ONLY,
        },
        encoding: "utf8",
      });
    expect(go(FULL, "").status).toBe(0);
    const no = go("dispatch", "");
    expect(no.status).toBe(1);
    expect(no.stdout).toContain("need a reason");
    expect(go("dispatch", "   ").status).toBe(1);
    expect(go("dispatch", "hotfix #1040: dispatch 5xx").status).toBe(0);
    // verify_only deploys nothing: no reason needed.
    expect(go("dispatch", "", "true").status).toBe(0);
    expect(go("dispatch", "x".repeat(501)).status).toBe(1);
    expect(go("dispatch", "two\nlines").status).toBe(1);
  });
  it("break-glass opens an issue with the reason, the run and the actor; not for verify_only or the full list", () => {
    const r = named("Record the break-glass deploy");
    expect(r.if).toBe(
      `\${{ !inputs.verify_only && inputs.targets != '${FULL}' }}`,
    );
    const i = (n: string) => steps.indexOf(named(n));
    // After the release gate and the main check, before anything deploys.
    expect(i("Record the break-glass deploy")).toBeGreaterThan(
      i("Prod runs only from main"),
    );
    expect(i("Record the break-glass deploy")).toBeLessThan(
      i("Deploy and verify"),
    );
    expect(r.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      TARGETS: "${{ inputs.targets }}",
      REASON: "${{ inputs.reason }}",
      ACTOR: "${{ github.actor }}",
      RUN_URL:
        "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(JSON.stringify(r)).not.toMatch(/secrets\.|email/i);
    const run = r.run as string;
    expect(run).toContain(
      'gh issue create --repo "$GITHUB_REPOSITORY" --title "Break-glass platform deploy: $DEPLOY_ENV $TAG $TARGETS" --body-file "$body"',
    );
    // The body, as the step writes it (gh stubbed out).
    const body = spawnSync(
      "bash",
      ["-c", `${run.replace(/^gh issue create.*$/m, 'cat "$body"')}`],
      {
        env: {
          PATH: process.env.PATH,
          RUNNER_TEMP: tmpdir(),
          REASON: "dispatch 5xx %s",
          RUN_URL: "https://github.com/o/r/actions/runs/1",
          ACTOR: "someone",
        },
        encoding: "utf8",
      },
    );
    expect(body.status).toBe(0);
    expect(body.stdout).toBe(
      "Reason: dispatch 5xx %s\n\nRun: https://github.com/o/r/actions/runs/1\n\nActor: someone\n",
    );
  });
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
      "reason",
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
        "scripts/ops\nscripts/ci\npackages/provision/src\napps/platform-db\n.github/hosted\n",
    });
    expect(named("The checkout is exactly the tag").run).toContain(
      'test "$(git describe --tags --exact-match)" = "$TAG"',
    );
    const use = named("Use main's deploy scripts").run as string;
    expect(use).toContain(
      "for f in deploy-hosted-platform.sh deploy-platform-worker.sh hosted-zones.sh platform-db.ts check-migration-lock.mjs wrangler-env.ts broker-key.ts; do",
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
      "for f in hosted-cf.sh hosted-constants.sh hosted-resource-ids.sh staging-first-gate.sh deploy-token-expiry.sh platform-tags.sh; do",
    );
    expect(use).toContain(
      'cp -R .deploy-logic/.github/hosted "$RUNNER_TEMP/main-ci/hosted"',
    );
    // main's migration pins, never the tag's own lock alone.
    expect(use).toContain(
      'cp .deploy-logic/apps/platform-db/migration-lock.json "$RUNNER_TEMP/main-ci/migration-lock.json"',
    );
    expect(named("Deploy and verify").env.MAIN_MIGRATION_LOCK).toBe(
      "${{ runner.temp }}/main-ci/migration-lock.json",
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
        // The Secrets Store id only for provision-token and provisioner.
        TARGETS: "${{ inputs.targets }}",
        CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      },
      run: 'bash "$RUNNER_TEMP/main-ci/hosted-resource-ids.sh" "$DEPLOY_ENV"',
    });
    expect(Object.keys(named("Resolve the resource ids").env)).toHaveLength(3);
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
      "inventory,zones",
    ])
      expect(runsFor(t), t).toBe(true);
    for (const t of ["zones"]) expect(runsFor(t), t).toBe(false);
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

  it("only the id lookup, deploy, zones, tag read-back and expiry steps see secrets, through env, exactly these", () => {
    const withSecrets = steps.filter((s) =>
      JSON.stringify(s).includes("secrets."),
    );
    expect(withSecrets.map((s) => s.name)).toEqual([
      "Resolve the resource ids",
      "Deploy and verify",
      "Zones",
      "Every platform Worker runs the tag",
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
      "ADMIN_IDENTITIES",
      "CLOUDFLARE_API_TOKEN",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_DIRECTORY_CLIENT_SECRET",
    ]);
    // The inventory key is gone (design v7 6.3): OIDC replaces it.
    expect(text).not.toContain("INVENTORY_KEY");
    expect(text).not.toContain("inventory-key");
    // The same names in each env's Environment: no env-specific secret names.
    expect(JSON.stringify(env)).not.toMatch(/PROD_|STAGING_/);
    expect(env.CLOUDFLARE_API_TOKEN).toBe(
      "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
    expect(env.VERIFY_ONLY).toBe("${{ inputs.verify_only && '1' || '' }}");
    // Every Worker version is tagged with the release (#1040): the wrapper
    // passes DEPLOY_TAG to wrangler deploy --tag.
    expect(env.DEPLOY_TAG).toBe("${{ inputs.tag }}");
    // #1007: the admin allowlist is the Environment's secret, never committed.
    expect(env.ADMIN_IDENTITIES).toBe("${{ secrets.ADMIN_IDENTITIES }}");
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
        env: { PATH: process.env.PATH, TAG, TARGETS, REASON: "test" },
        encoding: "utf8",
      }).status;
    expect(
      go("v0.74.1", "auth-broker,directory-broker,dispatch,scheduler"),
    ).toBe(0);
    expect(go("v0.74.1", "inventory,zones")).toBe(0);
    expect(go("v0.74.1", "inventory-key")).toBe(1);
    expect(go("v0.74.1", "zones,dispatch")).toBe(1);
    expect(
      go(
        "v0.74.1",
        "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,scheduler,inventory,provisioning,zones",
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
      "provisioning",
      "zones",
    ]);
    // What each app binds, from its committed config (prod block).
    const strip = (src: string) =>
      src
        .replace(
          /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
          (m, q) => q ?? "",
        )
        .replace(/,(\s*[}\]])/g, "$1");
    const bound = (app: string): string[] => {
      const cfg = JSON.parse(
        strip(readFileSync(join(root, `apps/${app}/wrangler.jsonc`), "utf8")),
      ).env.prod;
      const out = new Set<string>();
      if (cfg.d1_databases?.length) out.add("platform-db");
      for (const s of cfg.services ?? [])
        out.add(String(s.service).replace(/^oa-p-/, ""));
      for (const wf of cfg.workflows ?? [])
        if (wf.script_name)
          out.add(String(wf.script_name).replace(/^oa-p-/, ""));
      for (const s of cfg.secrets_store_secrets ?? [])
        if (String(s.secret_name).endsWith("-provision-token"))
          out.add("provision-token");
      return [...out];
    };
    const apps = [
      "auth-broker",
      "directory-broker",
      "provisioner",
      "dispatch",
      "scheduler",
      "inventory",
      "provisioning",
    ];
    for (const app of apps)
      for (const dep of bound(app)) {
        expect(order, `${app} binds ${dep}`).toContain(dep);
        expect(order.indexOf(dep), `${dep} before ${app}`).toBeLessThan(
          order.indexOf(app),
        );
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

  it("prod's platform-db, provisioner and provisioning wait for a green staging run of the tag, before anything deploys", () => {
    const g = named("Staging passed this tag");
    expect(g.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/staging-first-gate.sh" "$TAG"',
    );
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
    // prod platform-db alone is held to staging first too.
    expect(runsFor("prod", "platform-db")).toBe(true);
    expect(runsFor("prod", "platform-db,auth-broker")).toBe(true);
    expect(runsFor("staging", "platform-db")).toBe(false);
    expect(runsFor("prod", "provision-token,dispatch")).toBe(false);
    expect(runsFor("staging", "provisioner,provisioning")).toBe(false);
    const i = (n: string) => steps.indexOf(named(n));
    expect(i("Use main's deploy scripts")).toBeLessThan(
      i("Staging passed this tag"),
    );
    expect(i("Staging passed this tag")).toBeLessThan(i("Deploy and verify"));
  });

  it("builds and tests the Provisioning API Workers and the admin SPA too", () => {
    const run = named("Build and test the Workers being deployed")
      .run as string;
    for (const p of ["@oa/provisioner", "@oa/provisioning", "@oa/admin"])
      expect(run).toContain(`--filter ${p}`);
  });

  it("reads every Worker's tag back with main's script after a full-list run (#1064)", () => {
    const t = named("Every platform Worker runs the tag");
    // The condition follows the input's default, read from the YAML: a target
    // added to the default without the condition fails here, never silently
    // skips the read-back.
    expect(t.if).toBe(
      `\${{ inputs.targets == '${w.on.workflow_dispatch.inputs.targets.default}' }}`,
    );
    expect(t.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/platform-tags.sh" "$DEPLOY_ENV" "$TAG"',
    );
    expect(t.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      TAG: "${{ inputs.tag }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    });
    expect(steps.indexOf(named("Zones"))).toBeLessThan(steps.indexOf(t));
    expect(steps.indexOf(t)).toBeLessThan(
      steps.indexOf(named("The deploy token's expiry")),
    );
  });

  it("passes the repository id for the OIDC principals, and reads back the token's expiry last", () => {
    expect(named("Deploy and verify").env.GITHUB_REPOSITORY_ID).toBe(
      "${{ github.repository_id }}",
    );
    const e = named("The deploy token's expiry");
    expect(steps.at(-1)).toBe(e);
    expect(e.if).toBe("${{ !cancelled() }}");
    expect(e.run).toBe(
      'bash "$RUNNER_TEMP/main-ci/deploy-token-expiry.sh" "$DEPLOY_ENV"',
    );
    expect(e.env).toEqual({
      DEPLOY_ENV: "${{ inputs.env }}",
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      GH_TOKEN: "${{ github.token }}",
    });
  });
});

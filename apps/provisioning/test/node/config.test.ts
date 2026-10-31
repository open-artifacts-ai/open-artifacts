import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Design v7 2.4: every binding of oa-<p>-provisioning, per env.

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const cfg: any = JSON.parse(
  strip(readFileSync(join(app, "wrangler.jsonc"), "utf8")),
);
const ENVS = { staging: "oa-s-", prod: "oa-p-" } as const;
const APP = {
  staging: "open-artifacts-staging.app",
  prod: "open-artifacts.app",
} as const;
const RL = [
  ["RL_PV_PRE_IP", 600],
  ["RL_PV_SIGNIN_IP", 10],
  ["RL_PV_WRITE", 30],
  ["RL_PV_READ", 300],
  ["RL_PV_SLUG_IP", 30],
  ["RL_PV_OAUTH_IP", 20],
] as const;
const NS0 = { staging: 1141, prod: 1151 } as const;
const OIDC = [
  "OIDC_AUDIENCE",
  "OIDC_ENVIRONMENT",
  "OIDC_JOB_WORKFLOW_REFS",
  "OIDC_REPOSITORY",
  "OIDC_REPOSITORY_ID",
];

describe("wrangler.jsonc", () => {
  it("is env-only: no top-level name, main or routing", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    expect(cfg.name).toBeUndefined();
    expect(cfg.main).toBeUndefined();
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.preview_urls).toBe(false);
  });

  for (const [env, p] of Object.entries(ENVS) as [keyof typeof ENVS, string][])
    describe(env, () => {
      const e = cfg.env[env];

      it("names the Worker; no workers.dev, previews, logs or routes", () => {
        expect(e.name).toBe(`${p}provisioning`);
        expect(e.main).toBe("src/index.ts");
        expect(e.workers_dev).toBe(false);
        expect(e.preview_urls).toBe(false);
        expect(e.observability).toEqual({ enabled: false });
        for (const k of ["route", "routes", "custom_domain", "custom_domains"])
          expect(e[k]).toBeUndefined();
      });

      it("binds PLATFORM_DB to oa-<p>-platform", () => {
        expect(e.d1_databases).toEqual([
          {
            binding: "PLATFORM_DB",
            database_name: `${p}platform`,
            database_id: `{{PLATFORM_DB_ID_${env.toUpperCase()}}}`,
          },
        ]);
      });

      it("binds both Workflows on the provisioner script", () => {
        expect(e.workflows).toEqual([
          {
            binding: "PROVISION_INSTALL",
            name: `${p}provision-install`,
            class_name: "ProvisionInstall",
            script_name: `${p}provisioner`,
          },
          {
            binding: "MANAGE_INSTALL",
            name: `${p}manage-install`,
            class_name: "ManageInstall",
            script_name: `${p}provisioner`,
          },
        ]);
      });

      it("binds PROVISIONER (ProvisionerRpc) and AUTH_BROKER", () => {
        expect(e.services).toEqual([
          {
            binding: "PROVISIONER",
            service: `${p}provisioner`,
            entrypoint: "ProvisionerRpc",
          },
          { binding: "AUTH_BROKER", service: `${p}auth-broker` },
        ]);
      });

      it("produces to oa-<p>-signups and consumes nothing", () => {
        expect(e.queues).toEqual({
          producers: [{ binding: "SIGNUPS", queue: `${p}signups` }],
        });
      });

      it("serves the SPA with the Worker first", () => {
        expect(e.assets).toMatchObject({
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: true,
        });
      });

      it("binds the six rate limits with their namespace ids", () => {
        expect(e.ratelimits).toEqual(
          RL.map(([name, limit], i) => ({
            name,
            namespace_id: String(NS0[env] + i),
            simple: { limit, period: 60 },
          })),
        );
      });

      it("runs the MCP client sweep hourly (one cron)", () => {
        expect(cfg.env[env].triggers).toEqual({ crons: ["41 * * * *"] });
      });

      it("binds OAUTH_KV, the library's store", () => {
        expect(e.kv_namespaces).toEqual([
          {
            binding: "OAUTH_KV",
            id: `{{PROVISIONING_OAUTH_KV_ID_${env.toUpperCase()}}}`,
          },
        ]);
      });

      it("sets the 2.4 vars; OIDC_* on staging only", () => {
        expect(e.vars.OA_ENV).toBe(env);
        expect(e.vars.APP_DOMAIN).toBe(APP[env]);
        expect(typeof e.vars.ADMIN_IDENTITIES).toBe("string");
        expect(["false", "true", "test-users"]).toContain(
          e.vars.SIGNUPS_ENABLED,
        );
        if (env === "prod")
          expect(e.vars.SIGNUPS_ENABLED).not.toBe("test-users");
        expect(e.vars.SELF_SERVE_TIER).toBe("trial");
        // The provisioner's placeholder, one deploy value for both (9A.5).
        expect(e.vars.SIGNUP_DAILY_CAP).toBe(
          `{{SIGNUP_DAILY_CAP_${env.toUpperCase()}}}`,
        );
        expect(e.vars.MCP_REDIRECT_URIS.length).toBeGreaterThan(0);
        for (const k of OIDC)
          if (env === "staging") expect(e.vars[k]).toBeTruthy();
          else expect(e.vars[k]).toBeUndefined();
        if (env === "staging")
          expect(e.vars.OIDC_AUDIENCE).toBe(`https://api.${APP.staging}`);
      });

      it("every placeholder carries this env's suffix (the deploy leftover check)", () => {
        const ph = [...JSON.stringify(e).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map(
          (m) => m[1] as string,
        );
        expect(ph.length).toBeGreaterThan(0);
        for (const k of ph)
          expect(k).toMatch(new RegExp(`_${env.toUpperCase()}$`));
      });

      it("binds nothing else (no dispatcher, releases, email or token)", () => {
        expect(Object.keys(e).sort()).toEqual(
          [
            "assets",
            "d1_databases",
            "kv_namespaces",
            "main",
            "name",
            "observability",
            "preview_urls",
            "queues",
            "ratelimits",
            "services",
            "triggers",
            "vars",
            "workers_dev",
            "workflows",
          ].sort(),
        );
      });
    });
});

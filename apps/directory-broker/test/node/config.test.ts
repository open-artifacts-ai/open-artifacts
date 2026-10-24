import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTED_DOMAINS, platformNames } from "@oa/provision";
import { describe, expect, it } from "vitest";

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
const ENVS = ["staging", "prod"] as const;

/** Keys that would attach the Worker to a hostname from the repo config. */
const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

// TODO: platformNames has no `directory` or `directoryRegistry` yet (it comes
// with the registry provisioning PR #563); until then pin the literals and
// check the prefix against an existing name.
const P = { staging: "oa-s-", prod: "oa-p-" } as const;
const NS = {
  staging: { ip: "1121", install: "1122" },
  prod: { ip: "1131", install: "1132" },
};
const CLIENT_ID = {
  staging:
    "1032390278908-keuivn889b7c1rrisf4rbbgdtpu876vm.apps.googleusercontent.com",
  prod: "{{GOOGLE_DIRECTORY_CLIENT_ID_PROD}}",
};
/** Every key an env block may have: no D1, R2, service, dispatch or DO binding. */
const ENV_KEYS = [
  "kv_namespaces",
  "main",
  "name",
  "observability",
  "preview_urls",
  "ratelimits",
  "vars",
  "workers_dev",
];

describe("wrangler.jsonc", () => {
  it("names each env's Worker, directory registry KV, ratelimits and vars", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      // The prefix is the one provisioning uses for this env.
      expect(platformNames(env).broker).toBe(`${P[env]}auth-broker`);
      expect(e.name).toBe(`${P[env]}directory-broker`);
      expect(e.main).toBe("src/index.ts");
      // One placeholder per env, so filling one env can't bind the other's KV.
      expect(e.kv_namespaces).toEqual([
        {
          binding: "DIRECTORY_REGISTRY",
          id: `{{DIRECTORY_REGISTRY_ID_${env.toUpperCase()}}}`,
        },
      ]);
      expect(e.ratelimits).toEqual([
        {
          name: "RL_DIRECTORY_IP",
          namespace_id: NS[env].ip,
          simple: { limit: 60, period: 60 },
        },
        {
          name: "RL_DIRECTORY_INSTALL",
          namespace_id: NS[env].install,
          simple: { limit: 300, period: 60 },
        },
      ]);
      expect(e.vars).toEqual({
        GOOGLE_DIRECTORY_CLIENT_ID: CLIENT_ID[env],
        DIRECTORY_ORIGIN: `https://directory.${HOSTED_DOMAINS[env].app}`,
      });
      // Workers Logs would record callback URLs carrying the code and state.
      expect(e.observability).toEqual({ enabled: false });
    }
  });

  it("binds nothing but its own registry KV and ratelimits", () => {
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(Object.keys(e).sort()).toEqual(ENV_KEYS);
      // A compromised directory Worker must not reach the sign-in registry,
      // dispatch's HOSTS, the platform DB or any other resource.
      expect(e.kv_namespaces).toHaveLength(1);
      expect(JSON.stringify(e)).not.toMatch(
        /BROKER_REGISTRY|HOSTS|PLATFORM_DB|broker-registry|oa-[sp]-hosts|oa-[sp]-platform/,
      );
      for (const k of [
        "d1_databases",
        "r2_buckets",
        "services",
        "dispatch_namespaces",
        "durable_objects",
        "queues",
        "vectorize",
        "ai",
      ])
        expect(e).not.toHaveProperty(k);
    }
  });

  it("uses distinct ratelimit namespace ids across envs", () => {
    const ids = ENVS.flatMap((env) =>
      // biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
      cfg.env[env].ratelimits.map((r: any) => r.namespace_id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/custom_domain|"pattern"|zone_/);
  });

  it("has exactly these top-level keys: no name, main, vars or bindings (a deploy without --env can't run)", () => {
    expect(Object.keys(cfg).sort()).toEqual([
      "$schema",
      "compatibility_date",
      "env",
      "preview_urls",
      "workers_dev",
    ]);
  });
});

const wrangler = (args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", ...args], {
    cwd: app,
    stdio: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });

describe("bundle", () => {
  it("wrangler deploy without --env is refused", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-dirbroker-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
  });

  it("wrangler deploy --name without --env is refused too (no top-level main)", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-dirbroker-"));
    expect(() =>
      wrangler(["--name", `${P.prod}directory-broker`, "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run bundles per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-dirbroker-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      expect(bytes).toBeGreaterThan(0);
    }
  });
});

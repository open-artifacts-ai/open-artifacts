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

const NS = {
  staging: { ip: "1101", install: "1102" },
  prod: { ip: "1111", install: "1112" },
};
const CLIENT_ID = {
  staging:
    "1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com",
  prod: "{{GOOGLE_CLIENT_ID_PROD}}",
};

describe("wrangler.jsonc", () => {
  it("names each env's Worker, registry KV, ratelimits and vars", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).broker);
      expect(e.main).toBe("src/index.ts");
      // One placeholder per env, so filling one env can't bind the other's KV.
      expect(e.kv_namespaces).toEqual([
        {
          binding: "BROKER_REGISTRY",
          id: `{{BROKER_REGISTRY_ID_${env.toUpperCase()}}}`,
        },
      ]);
      expect(e.ratelimits).toEqual([
        {
          name: "RL_BROKER_IP",
          namespace_id: NS[env].ip,
          simple: { limit: 60, period: 60 },
        },
        {
          name: "RL_BROKER_INSTALL",
          namespace_id: NS[env].install,
          simple: { limit: 300, period: 60 },
        },
      ]);
      expect(e.vars).toEqual({
        GOOGLE_CLIENT_ID: CLIENT_ID[env],
        BROKER_ORIGIN: `https://auth.${HOSTED_DOMAINS[env].app}`,
      });
      // The broker never reads the Directory client, so it isn't on the broker.
      expect(Object.keys(e.vars).sort()).toEqual([
        "BROKER_ORIGIN",
        "GOOGLE_CLIENT_ID",
      ]);
      // Workers Logs would record callback URLs carrying the code and state.
      expect(e.observability).toEqual({ enabled: false });
    }
    expect(platformNames("staging").broker).toBe("oa-s-auth-broker");
    expect(platformNames("prod").broker).toBe("oa-p-auth-broker");
    expect(platformNames("staging").registry).toBe("oa-s-broker-registry");
    expect(platformNames("prod").registry).toBe("oa-p-broker-registry");
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
    const out = mkdtempSync(join(tmpdir(), "oa-broker-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
  });

  it("wrangler deploy --name without --env is refused too (no top-level main)", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-broker-"));
    expect(() =>
      wrangler(["--name", platformNames("prod").broker, "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run bundles per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-broker-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      expect(bytes).toBeGreaterThan(0);
    }
  });
});

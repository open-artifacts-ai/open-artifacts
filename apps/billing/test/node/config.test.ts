import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformNames } from "@oa/provision";
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
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const broker: any = JSON.parse(
  strip(readFileSync(join(app, "../auth-broker/wrangler.jsonc"), "utf8")),
);
const ENVS = ["staging", "prod"] as const;

const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

describe("wrangler.jsonc", () => {
  it("names each env's Worker and its own BILLING_DB, and nothing else", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).billing);
      expect(e.main).toBe("src/index.ts");
      // One placeholder per env, so filling one env can't bind the other's DB.
      expect(e.d1_databases).toEqual([
        {
          binding: "BILLING_DB",
          database_name: platformNames(env).billing,
          database_id: `{{BILLING_DB_ID_${env.toUpperCase()}}}`,
        },
      ]);
      // The install registry, for the POSTs' signatures: the same namespace
      // (the same placeholder) the auth broker binds in this env.
      expect(e.kv_namespaces).toEqual([
        {
          binding: "BROKER_REGISTRY",
          id: `{{BROKER_REGISTRY_ID_${env.toUpperCase()}}}`,
        },
      ]);
      expect(e.kv_namespaces).toEqual(
        broker.env[env].kv_namespaces.filter(
          (k: { binding: string }) => k.binding === "BROKER_REGISTRY",
        ),
      );
      // Workers Logs would record full URLs.
      expect(e.observability).toEqual({ enabled: false });
      // The env (the app domain the gate's app host must be on) and this
      // env's own price placeholders; the Stripe key is a secret, never here.
      const up = env.toUpperCase();
      expect(e.vars).toEqual({
        OA_ENV: env,
        STRIPE_PRICE_TEAM: `{{STRIPE_PRICE_TEAM_${up}}}`,
        STRIPE_PRICE_BUSINESS: `{{STRIPE_PRICE_BUSINESS_${up}}}`,
      });
      for (const k of [
        "services",
        "r2_buckets",
        "durable_objects",
        "queues",
        "dispatch_namespaces",
        "triggers",
      ])
        expect(e).not.toHaveProperty(k);
    }
    expect(platformNames("staging").billing).toBe("oa-s-billing");
    expect(platformNames("prod").billing).toBe("oa-p-billing");
  });

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/custom_domain|"pattern"|zone_/);
  });

  it("has no top-level name, main or bindings (a deploy without --env can't run)", () => {
    for (const k of [
      "name",
      "main",
      "vars",
      "d1_databases",
      "kv_namespaces",
      "services",
    ])
      expect(cfg).not.toHaveProperty(k);
  });
});

describe("migrations", () => {
  it("0001_init is the only migration and creates the three tables", () => {
    const dir = join(app, "migrations");
    expect(readdirSync(dir).sort()).toEqual(["0001_init.sql"]);
    const sql = readFileSync(join(dir, "0001_init.sql"), "utf8");
    for (const t of ["tiers", "stripe_events", "usage"])
      expect(sql).toMatch(new RegExp(`CREATE TABLE ${t} \\(`));
    // The webhook's event ordering (@oa/billing-core): nullable, NULL is 0.
    expect(sql).toMatch(/\n {2}last_event_created INTEGER\n\);/);
  });

  it("is the schema @oa/billing-core tests against, byte for byte", () => {
    expect(readFileSync(join(app, "migrations/0001_init.sql"), "utf8")).toBe(
      readFileSync(
        join(app, "../../packages/billing-core/test/migrations/0001_init.sql"),
        "utf8",
      ),
    );
  });
});

const wrangler = (args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", ...args], {
    cwd: app,
    stdio: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });

describe("bundle", () => {
  it("wrangler deploy without --env is refused, with or without --name", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-billing-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
    expect(() =>
      wrangler(["--name", platformNames("prod").billing, "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run is under 50 KB per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-billing-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(50 * 1024);
    }
  });
});

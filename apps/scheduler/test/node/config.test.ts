import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACES, platformNames } from "@oa/provision";
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

describe("wrangler.jsonc", () => {
  it("names each env's Worker, cron, namespace and PLATFORM_DB binding", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      expect(e.name).toBe(platformNames(env).scheduler);
      expect(e.main).toBe("src/index.ts");
      // The quota config is per env, filled at deploy like PLATFORM_DB. The
      // token is a secret (wrangler secret put), never a var.
      expect(e.vars).toEqual({
        OA_ENV: env,
        EMAIL_QUOTA_ZONES: `{{EMAIL_ZONE_TAG_${env.toUpperCase()}}}`,
        EMAIL_DAILY_LIMIT: `{{EMAIL_DAILY_LIMIT_${env.toUpperCase()}}}`,
      });
      expect(e.vars).not.toHaveProperty("EMAIL_QUOTA_TOKEN");
      // The nightly run, and H-DV's directory revoke tick every 2 minutes.
      expect(e.triggers).toEqual({ crons: ["17 3 * * *", "*/2 * * * *"] });
      expect(e.dispatch_namespaces).toEqual([
        { binding: "DISPATCHER", namespace: NAMESPACES[env] },
      ]);
      // One placeholder per env, so filling one env can't bind the other's DB.
      expect(e.d1_databases).toEqual([
        {
          binding: "PLATFORM_DB",
          database_name: platformNames(env).db,
          database_id: `{{PLATFORM_DB_ID_${env.toUpperCase()}}}`,
        },
      ]);
      // On for this Worker only: it serves no requests, and its logs carry
      // install ids, fixed categories and counts (pinned in scheduler.test.ts).
      expect(e.observability).toEqual({ enabled: true });
      // Only what the brief lists: no KV, services, R2 or other bindings.
      for (const k of [
        "kv_namespaces",
        "services",
        "r2_buckets",
        "durable_objects",
        "queues",
        "secrets",
      ])
        expect(e).not.toHaveProperty(k);
    }
    expect(platformNames("staging").scheduler).toBe("oa-s-scheduler");
    expect(platformNames("prod").scheduler).toBe("oa-p-scheduler");
    expect(NAMESPACES).toEqual({ staging: "oa-staging", prod: "oa-prod" });
  });

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/custom_domain|"pattern"|zone_/);
    // The quota token is a secret, never in the repo config.
    expect(JSON.stringify(cfg)).not.toContain("EMAIL_QUOTA_TOKEN");
  });

  it("has no top-level name, bindings, vars or cron (a deploy without --env can't run)", () => {
    for (const k of [
      "name",
      "main",
      "vars",
      "triggers",
      "d1_databases",
      "dispatch_namespaces",
      "services",
    ])
      expect(cfg).not.toHaveProperty(k);
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
    const out = mkdtempSync(join(tmpdir(), "oa-scheduler-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
  });

  it("wrangler deploy --name without --env is refused too (no top-level main)", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-scheduler-"));
    expect(() =>
      wrangler(["--name", platformNames("prod").scheduler, "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run is under 50 KB per env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-scheduler-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      console.log(`scheduler bundle (${env}): ${bytes} bytes`);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(50 * 1024);
    }
  });
});

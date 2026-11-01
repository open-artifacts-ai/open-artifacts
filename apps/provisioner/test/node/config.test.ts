import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACES, platformNames } from "@oa/provision";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apps = join(app, "..");
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const read = (path: string): any =>
  JSON.parse(strip(readFileSync(path, "utf8")));
const cfg = read(join(app, "wrangler.jsonc"));
const api = read(join(apps, "provisioning/wrangler.jsonc"));
const ENVS = ["staging", "prod"] as const;
const P = { staging: "s", prod: "p" } as const;
const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

describe("wrangler.jsonc", () => {
  it("each env has the queue, its DLQ, both workflows, the dispatcher and the token binding (design v7 2.4)", () => {
    expect(Object.keys(cfg.env).sort()).toEqual(["prod", "staging"]);
    for (const env of ENVS) {
      const e = cfg.env[env];
      const p = P[env];
      const E = env.toUpperCase();
      expect(e.name).toBe(`oa-${p}-provisioner`);
      expect(e.main).toBe("src/index.ts");
      expect(e.compatibility_flags).toEqual(["nodejs_compat"]);
      expect(e.limits).toEqual({ cpu_ms: 300000 });
      expect(e.queues).toEqual({
        consumers: [
          {
            queue: `oa-${p}-signups`,
            max_batch_size: 1,
            max_retries: 5,
            // Safe: a message carries { signupId } only.
            dead_letter_queue: `oa-${p}-signups-dlq`,
          },
        ],
      });
      // The API binds the same names with script_name oa-<p>-provisioner.
      expect(e.workflows).toEqual([
        {
          name: `oa-${p}-provision-install`,
          binding: "PROVISION_INSTALL",
          class_name: "ProvisionInstall",
        },
        {
          name: `oa-${p}-manage-install`,
          binding: "MANAGE_INSTALL",
          class_name: "ManageInstall",
        },
      ]);
      for (const w of api.env[env].workflows) {
        expect(w.script_name).toBe(e.name);
        expect(e.workflows).toContainEqual({
          name: w.name,
          binding: w.binding,
          class_name: w.class_name,
        });
      }
      // Pre-route /healthz and the MCP selftest (5.2 f), redline_creds.
      expect(e.dispatch_namespaces).toEqual([
        { binding: "DISPATCHER", namespace: NAMESPACES[env] },
      ]);
      expect(NAMESPACES[env]).toBe(`oa-${env}`);
      expect(e.secrets_store_secrets).toEqual([
        {
          binding: "PROVISION_TOKEN",
          store_id: `{{SECRETS_STORE_ID_${E}}}`,
          secret_name: `oa-${p}-provision-token`,
        },
      ]);
      expect(e.d1_databases).toEqual([
        {
          binding: "PLATFORM_DB",
          database_name: platformNames(env).db,
          database_id: `{{PLATFORM_DB_ID_${E}}}`,
        },
      ]);
      // provision reaches KV over REST: no KV bindings.
      expect(e).not.toHaveProperty("kv_namespaces");
      // A binding has no bucket name to check at runtime: this is the check.
      expect(e.r2_buckets).toEqual([
        { binding: "RELEASES", bucket_name: platformNames(env).releases },
      ]);
      expect(platformNames(env).releases).toBe(`oa-${p}-releases`);
      expect(e.send_email).toEqual([{ name: "WELCOME_EMAIL" }]);
      expect(e.vars).toEqual({
        SIGNUP_DAILY_CAP: `{{SIGNUP_DAILY_CAP_${E}}}`,
        SIGNUPS_ENABLED: `{{SIGNUPS_ENABLED_${E}}}`,
        WELCOME_FROM: `{{WELCOME_FROM_${E}}}`,
        ACCOUNT_ID: `{{ACCOUNT_ID_${E}}}`,
        // Literal, not filled: the Workflow refuses anything but these two.
        OA_ENV: env,
        // Literal: the recheck's tier for self-serve rows (2.5), the API's.
        SELF_SERVE_TIER: "trial",
      });
      // The release is a job argument now (2.4), never a var.
      expect(JSON.stringify(e)).not.toMatch(/RELEASE_VERSION/);
      expect(e.vars.SELF_SERVE_TIER).toBe(api.env[env].vars.SELF_SERVE_TIER);
      expect(e.vars.OA_ENV).toBe(api.env[env].vars.OA_ENV);
      // Workers Logs would record message bodies' context.
      expect(e.observability).toEqual({ enabled: false });
      for (const k of ["services", "durable_objects", "triggers", "assets"])
        expect(e).not.toHaveProperty(k);
    }
  });

  it("no other Worker's config binds the provision token", () => {
    const others = readdirSync(apps).filter(
      (a) =>
        a !== "provisioner" &&
        readdirSync(join(apps, a)).some((f) => /^wrangler.*\.jsonc?$/.test(f)),
    );
    expect(others).toContain("scheduler");
    for (const a of others)
      for (const f of readdirSync(join(apps, a)).filter((f) =>
        /^wrangler.*\.jsonc?$/.test(f),
      )) {
        const text = readFileSync(join(apps, a, f), "utf8");
        expect(text, `${a}/${f}`).not.toMatch(/provision-token/);
        expect(text, `${a}/${f}`).not.toMatch(/PROVISION_TOKEN/);
      }
  });

  it("the Provisioning API's sources never name the provision token (2.5)", () => {
    const dir = join(apps, "provisioning");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => !f.split(/[\\/]/).includes("node_modules"))
      .filter((f) => statSync(join(dir, f)).isFile());
    expect(files).toContain("wrangler.jsonc");
    for (const f of files)
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(
        /provision-token|PROVISION_TOKEN/,
      );
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
      "r2_buckets",
      "queues",
      "workflows",
      "secrets_store_secrets",
      "send_email",
      "dispatch_namespaces",
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
  it("wrangler deploy without --env is refused, with or without --name", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-provisioner-"));
    expect(() => wrangler(["--outdir", out])).toThrow(
      /name of your worker|entry-point/,
    );
    expect(() =>
      wrangler(["--name", "oa-p-provisioner", "--outdir", out]),
    ).toThrow(/entry-point/);
  });

  it("wrangler deploy --dry-run bundles each env", () => {
    for (const env of ENVS) {
      const out = mkdtempSync(join(tmpdir(), "oa-provisioner-"));
      wrangler(["--env", env, "--outdir", out]);
      const bytes = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .reduce((n, f) => n + statSync(join(out, f)).size, 0);
      expect(bytes).toBeGreaterThan(0);
    }
  });
});

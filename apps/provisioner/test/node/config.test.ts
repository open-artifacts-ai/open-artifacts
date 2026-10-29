import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platformNames } from "@oa/provision";
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
const ENVS = ["staging", "prod"] as const;
const P = { staging: "s", prod: "p" } as const;
const ROUTING = ["route", "routes", "custom_domain", "custom_domains"];

describe("wrangler.jsonc", () => {
  it("each env has the queue, its DLQ, the workflow and the token binding", () => {
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
          },
        ],
        // No runtime dead_letter_queue: it would receive the body (the email).
        // Bad shapes go to the DLQ as { signupId } only, written by us.
        producers: [{ binding: "SIGNUPS_DLQ", queue: `oa-${p}-signups-dlq` }],
      });
      expect(e.queues.consumers[0]).not.toHaveProperty("dead_letter_queue");
      expect(e.workflows).toEqual([
        {
          name: `oa-${p}-provision-install`,
          binding: "PROVISION_INSTALL",
          class_name: "ProvisionInstall",
        },
      ]);
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
      expect(e.kv_namespaces).toEqual([
        { binding: "HOSTS", id: `{{HOSTS_KV_ID_${E}}}` },
        { binding: "BROKER_REGISTRY", id: `{{BROKER_REGISTRY_ID_${E}}}` },
        { binding: "DIRECTORY_REGISTRY", id: `{{DIRECTORY_REGISTRY_ID_${E}}}` },
      ]);
      // A binding has no bucket name to check at runtime: this is the check.
      expect(e.r2_buckets).toEqual([
        { binding: "RELEASES", bucket_name: platformNames(env).releases },
      ]);
      expect(platformNames(env).releases).toBe(`oa-${p}-releases`);
      expect(e.send_email).toEqual([{ name: "WELCOME_EMAIL" }]);
      expect(e.vars).toEqual({
        SIGNUP_DAILY_CAP: `{{SIGNUP_DAILY_CAP_${E}}}`,
        WELCOME_FROM: `{{WELCOME_FROM_${E}}}`,
        ACCOUNT_ID: `{{ACCOUNT_ID_${E}}}`,
      });
      // Workers Logs would record message bodies' context.
      expect(e.observability).toEqual({ enabled: false });
      for (const k of ["services", "durable_objects", "triggers"])
        expect(e).not.toHaveProperty(k);
    }
  });

  it("the other platform Workers bind the same registries and HOSTS", () => {
    const kv = (a: string, env: string, binding: string) =>
      read(join(apps, a, "wrangler.jsonc")).env[env].kv_namespaces.filter(
        (k: { binding: string }) => k.binding === binding,
      );
    for (const env of ENVS) {
      const mine = (b: string) =>
        cfg.env[env].kv_namespaces.filter(
          (k: { binding: string }) => k.binding === b,
        );
      expect(mine("HOSTS")).toEqual(kv("dispatch", env, "HOSTS"));
      expect(mine("BROKER_REGISTRY")).toEqual(
        kv("auth-broker", env, "BROKER_REGISTRY"),
      );
      expect(mine("DIRECTORY_REGISTRY")).toEqual(
        kv("directory-broker", env, "DIRECTORY_REGISTRY"),
      );
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

  it("has no routes, custom domains or workers.dev, at the top or in any env", () => {
    for (const c of [cfg, ...ENVS.map((e) => cfg.env[e])]) {
      for (const k of ROUTING) expect(c).not.toHaveProperty(k);
      expect(c.workers_dev).toBe(false);
      expect(c.preview_urls).toBe(false);
    }
    expect(JSON.stringify(cfg)).not.toMatch(/dead_letter_queue/);
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

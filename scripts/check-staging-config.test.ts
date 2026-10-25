import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(
  join(root, "apps/server/wrangler.staging.jsonc"),
  "utf8",
);
// Strip // and /* */ comments outside strings.
const strip = (s: string) =>
  s.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str) => str ?? "",
  );
// biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
const cfg: any = JSON.parse(strip(raw));
const env = cfg.env.staging;

/*
 * Invariants instead of pinned values (what changed and why):
 * - D1 database_id / KV id / CF_ACCOUNT_ID / OWNER_EMAIL / team domain /
 *   ACCESS_CLIENT_ID: concrete ids change when resources are recreated ->
 *   matched by shape (uuid / 32 hex / email / hostname).
 * - Bindings (d1, r2, kv, durable objects, ratelimits, migrations): found by
 *   binding name instead of array index / exact list, so new bindings can be
 *   added. Binding names stay pinned.
 * - assets: toMatchObject; binding + run_worker_first:true pinned, directory
 *   and not_found_handling free to change.
 * - ratelimit namespace_id: shape only (digits).
 * - vars: exact object -> required keys + pinned ENVIRONMENT/hosts, plus an
 *   explicit "no secret-looking var names" check so the former
 *   exact-equality no-secrets guarantee is not weakened.
 * Kept as contracts: name, routes/hosts, workers_dev/preview_urls off,
 * nodejs_compat, binding names, ENVIRONMENT=production, run_worker_first,
 * the cron, RL_ANON limit 30 / period 60 (spec: 30 writes/min/anon IP).
 */
const by = <T>(xs: T[], key: string, v: string): T | undefined =>
  // biome-ignore lint/suspicious/noExplicitAny: untyped
  xs.find((x: any) => x[key] === v);

describe("wrangler.staging.jsonc env.staging", () => {
  it("keeps name and custom domains", () => {
    expect(env.name).toBe("open-artifacts-staging");
    expect(env.routes.map((r: { pattern: string }) => r.pattern)).toEqual(
      expect.arrayContaining([
        "staging.open-artifacts.com",
        "staging-content.open-artifacts.com",
      ]),
    );
  });
  it("keeps workers.dev and preview URLs off", () => {
    expect(env.workers_dev).toBe(false);
    expect(env.preview_urls).toBe(false);
  });
  it("enables nodejs_compat", () => {
    expect(env.compatibility_flags ?? cfg.compatibility_flags).toContain(
      "nodejs_compat",
    );
  });
  it("binds D1 DB, R2 FILES, KV OAUTH_KV", () => {
    expect(by(env.d1_databases, "binding", "DB")).toMatchObject({
      database_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(by(env.r2_buckets, "binding", "FILES")).toMatchObject({
      bucket_name: "open-artifacts-staging",
    });
    expect(by(env.kv_namespaces, "binding", "OAUTH_KV")).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
  it("binds the ArtifactRuntime durable object with sqlite migration", () => {
    expect(env.durable_objects.bindings).toEqual(
      expect.arrayContaining([
        { name: "ARTIFACT_RUNTIME", class_name: "ArtifactRuntime" },
      ]),
    );
    // biome-ignore lint/suspicious/noExplicitAny: untyped
    const sqlite = env.migrations.flatMap(
      (m: any) => m.new_sqlite_classes ?? [],
    );
    expect(sqlite).toContain("ArtifactRuntime");
  });
  it("binds ASSETS with run_worker_first true", () => {
    expect(env.assets).toMatchObject({
      binding: "ASSETS",
      run_worker_first: true,
    });
  });
  it("binds BROWSER (Browser Run) in staging and the setup template", () => {
    expect(env.browser).toEqual({ binding: "BROWSER" });
    const tpl = JSON.parse(
      strip(
        readFileSync(join(root, "apps/server/wrangler.template.jsonc"), "utf8"),
      ),
    );
    expect(tpl.browser).toEqual({ binding: "BROWSER" });
  });
  it("binds EMAIL (send_email) and sends from the onboarded staging domain", () => {
    expect(env.send_email).toEqual([{ name: "EMAIL" }]);
    expect(env.vars.EMAIL_FROM).toBe("noreply@mail.open-artifacts.com");
  });
  it("turns server-side thumbnails on (Paid only) with BROWSER", () => {
    expect(env.vars.SERVER_THUMBNAILS).toBe("on");
    expect(env.browser).toEqual({ binding: "BROWSER" });
    const tpl = JSON.parse(
      readFileSync(join(root, "apps/server/wrangler.template.jsonc"), "utf8"),
    );
    expect(tpl.vars.SERVER_THUMBNAILS).toBe("on");
  });
  it("logs every staging request to Workers Logs; the template logs too", () => {
    expect(env.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
    });
    const tpl = JSON.parse(
      readFileSync(join(root, "apps/server/wrangler.template.jsonc"), "utf8"),
    );
    expect(tpl.observability.enabled).toBe(true);
    expect(tpl.observability.head_sampling_rate ?? 1).toBe(1);
  });
  it("runs staging with PLAN=paid (the account is on Workers Paid)", () => {
    expect(env.vars.PLAN).toBe("paid");
  });
  it("keeps the setup template strict JSON (e2e fixtures JSON.parse it)", () => {
    const raw = readFileSync(
      join(root, "apps/server/wrangler.template.jsonc"),
      "utf8",
    );
    expect(() => JSON.parse(raw)).not.toThrow();
  });
  it("binds RL_ANON ratelimit", () => {
    const rl = by(env.ratelimits, "name", "RL_ANON") as {
      namespace_id: string;
      simple: { limit: number; period: number };
    };
    expect(rl).toBeDefined();
    expect(rl.namespace_id).toMatch(/^\d+$/);
    // Spec: 30 writes per minute per anonymous IP.
    expect(rl.simple).toEqual({ limit: 30, period: 60 });
  });
  it("has the daily cron", () => {
    expect(env.triggers.crons).toContain("17 3 * * *");
  });
  it("has the expected vars and no secrets", () => {
    const { ACCESS_CLIENT_ID, ...vars } = env.vars;
    expect(vars).toMatchObject({
      ENVIRONMENT: "production",
      APP_HOST: "staging.open-artifacts.com",
      CONTENT_HOST: "staging-content.open-artifacts.com",
      OWNER_EMAIL: expect.stringMatching(/^[^@\s]+@[^@\s]+$/),
      ACCESS_TEAM_DOMAIN: expect.stringMatching(/\.cloudflareaccess\.com$/),
      CF_ACCOUNT_ID: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    // Only ACCESS_CLIENT_ID (a public id) may look credential-like.
    expect(
      Object.keys(vars).filter((k) =>
        /SECRET|TOKEN|PASSWORD|PRIVATE|SIGNING/.test(k),
      ),
    ).toEqual([]);
    expect(ACCESS_CLIENT_ID).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("staging Durable Objects", () => {
  // A class must exist one release before anything binds it (the P1 rule):
  // every bound class is migrated, and every migrated class is exported by the
  // server entry (a migration for a class the server doesn't export fails the
  // staging deploy, so this config can't land before the class does).
  const entry = readFileSync(join(root, "apps/server", cfg.main), "utf8");
  // biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
  const bound: string[] = env.durable_objects.bindings.map(
    (b: any) => b.class_name,
  );
  // biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
  const migrated: string[] = env.migrations.flatMap((m: any) => [
    ...(m.new_sqlite_classes ?? []),
    ...(m.new_classes ?? []),
  ]);
  it("every bound class is migrated", () => {
    for (const c of bound) expect(migrated, c).toContain(c);
  });
  for (const name of migrated)
    it(`the server entry exports ${name}`, () => {
      expect(entry).toMatch(
        new RegExp(
          `export\\s+(?:class\\s+${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\})`,
        ),
      );
    });
});

describe("staging DirectorySync (P3 T13a #571 tag v3, bound with T13 #575)", () => {
  it("adds DirectorySync in migration v3, after v2 (UserPresence)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
    const tags = env.migrations.map((m: any) => m.tag);
    expect(tags.slice(0, 3)).toEqual(["v1", "v2", "v3"]);
    expect(env.migrations[2]).toEqual({
      tag: "v3",
      new_sqlite_classes: ["DirectorySync"],
    });
  });
  it("binds DIRECTORY_SYNC to DirectorySync with its first user (#575), one release after v3 (0.46.0)", () => {
    expect(env.durable_objects.bindings).toContainEqual({
      name: "DIRECTORY_SYNC",
      class_name: "DirectorySync",
    });
  });
  it("binds RL_DIRECTORY (30/60 s) on its own namespace (#575)", () => {
    const rl = by(env.ratelimits, "name", "RL_DIRECTORY") as {
      namespace_id: string;
      simple: unknown;
    };
    expect(rl).toBeDefined();
    expect(rl.namespace_id).toBe("1003");
    expect(rl.simple).toEqual({ limit: 30, period: 60 });
    const ids = (env.ratelimits as { namespace_id: string }[]).map(
      (r) => r.namespace_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("staging UserPresence (P3 T7a #502, T7b #503)", () => {
  it("adds UserPresence in migration v2, after v1 (ArtifactRuntime)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: untyped wrangler config
    const tags = env.migrations.map((m: any) => m.tag);
    expect(tags.slice(0, 2)).toEqual(["v1", "v2"]);
    expect(env.migrations[1]).toEqual({
      tag: "v2",
      new_sqlite_classes: ["UserPresence"],
    });
  });
  it("binds USER_PRESENCE to UserPresence (T7b, #503), one release after v2", () => {
    expect(env.durable_objects.bindings).toContainEqual({
      name: "USER_PRESENCE",
      class_name: "UserPresence",
    });
  });
});

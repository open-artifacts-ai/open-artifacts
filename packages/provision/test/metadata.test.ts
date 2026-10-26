import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Binding,
  buildBundle,
  epochBumpSql,
  googleNewlyEnabled,
  HOSTED_ADDED,
  type InstallMetaInput,
  KNOWN_SECRETS,
  names,
  parseTemplate,
  type ResourceMetaInput,
  scriptSubdomainSettings,
  TEMPLATE_BINDINGS_EXCLUDED,
  type Template,
  userWorkerMetadata,
} from "../src/index.js";
import { loadTemplate } from "../src/internal/template.js";

const TEMPLATE_PATH = new URL(
  "../../../apps/server/wrangler.template.jsonc",
  import.meta.url,
);
const tpl = parseTemplate(await readFile(TEMPLATE_PATH, "utf8"));

const inst = (o: Partial<InstallMetaInput> = {}): InstallMetaInput => ({
  id: "iabcdefghjk2",
  appHost: "a.app.test",
  contentHost: "a.content.test",
  ownerEmail: "o@x.test",
  vars: {},
  testHooks: false,
  ...o,
});
const res = (o: Partial<ResourceMetaInput> = {}): ResourceMetaInput => ({
  d1Id: "11111111-2222-4333-8444-555555555555",
  kvId: "0123456789abcdef0123456789abcdef",
  version: "1.2.3",
  rlNs: 2_000_000,
  doMigrationTag: null,
  env: "staging",
  target: "account",
  mode: "create",
  assetsJwt: "jwt",
  mainModule: "index.js",
  secrets: { SESSION_SECRET: "s", CONTENT_SIGNING_KEY: "c" },
  template: tpl,
  ...o,
});
const text = (b: Binding[], name: string) =>
  b.find((x) => x.name === name && x.type === "plain_text")?.text;

describe("userWorkerMetadata", () => {
  it("every template binding and var is mapped or explicitly excluded", () => {
    const m = userWorkerMetadata(inst(), res({ template: tpl }));
    const have = new Set(m.bindings.map((b) => b.name));
    const want = [
      ...(tpl.browser ? [tpl.browser.binding] : []),
      ...tpl.send_email.map((e: { name: string }) => e.name),
      tpl.assets.binding,
      ...tpl.d1_databases.map((e: { binding: string }) => e.binding),
      ...tpl.r2_buckets.map((e: { binding: string }) => e.binding),
      ...tpl.kv_namespaces.map((e: { binding: string }) => e.binding),
      ...tpl.durable_objects.bindings.map((e: { name: string }) => e.name),
      ...tpl.ratelimits.map((e: { name: string }) => e.name),
      ...Object.keys(tpl.vars),
    ];
    for (const n of want)
      expect(have.has(n) || n in TEMPLATE_BINDINGS_EXCLUDED, n).toBe(true);
    for (const n of Object.keys(TEMPLATE_BINDINGS_EXCLUDED)) {
      expect(have.has(n), `${n} must not be uploaded`).toBe(false);
      if (!["ANALYTICS_TOKEN", "ACCESS_CLIENT_SECRET"].includes(n))
        expect(Object.keys(tpl).includes(n) || n in tpl.vars, n).toBe(true);
    }
    // top-level template keys are all known
    const known = new Set([
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "browser",
      "send_email",
      "assets",
      "routes",
      "d1_databases",
      "r2_buckets",
      "kv_namespaces",
      "durable_objects",
      "migrations",
      "ratelimits",
      "triggers",
      "vars",
      "observability",
    ]);
    for (const k of Object.keys(tpl))
      expect(known.has(k) || k in TEMPLATE_BINDINGS_EXCLUDED, k).toBe(true);
    // every uploaded name is a template binding/var or a hosted addition
    const allowed = new Set<string>([...want, ...HOSTED_ADDED]);
    const full = userWorkerMetadata(
      inst({ testHooks: true }),
      res({
        template: tpl,
        secrets: {
          SESSION_SECRET: "s",
          CONTENT_SIGNING_KEY: "c",
          TEST_HOOK_KEY: "k".repeat(32),
        },
      }),
    );
    for (const b of full.bindings)
      expect(allowed.has(b.name), b.name).toBe(true);
    expect(HOSTED_ADDED).toContain("TEST_HOOKS");
    expect(HOSTED_ADDED).toContain("TEST_HOOK_KEY");
    for (const [, why] of Object.entries(TEMPLATE_BINDINGS_EXCLUDED))
      expect(why.length).toBeGreaterThan(5);
  });

  it("maps binding types exactly", () => {
    const m = userWorkerMetadata(inst(), res());
    const by = (n: string) => m.bindings.find((b) => b.name === n);
    expect(by("DB")).toMatchObject({
      type: "d1",
      id: "11111111-2222-4333-8444-555555555555",
    });
    expect(by("FILES")).toMatchObject({
      type: "r2_bucket",
      bucket_name: names("iabcdefghjk2", "staging").r2,
    });
    expect(by("OAUTH_KV")).toMatchObject({
      type: "kv_namespace",
      namespace_id: "0123456789abcdef0123456789abcdef",
    });
    expect(by("ARTIFACT_RUNTIME")).toMatchObject({
      type: "durable_object_namespace",
      class_name: "ArtifactRuntime",
    });
    expect(by("RL_ANON")).toMatchObject({
      type: "ratelimit",
      namespace_id: "2000000",
      simple: { limit: 30, period: 60 },
    });
    expect(by("EMAIL")?.type).toBe("send_email");
    expect(by("BROWSER")?.type).toBe("browser");
    expect(by("ASSETS")?.type).toBe("assets");
    expect(m.assets).toEqual({
      jwt: "jwt",
      config: {
        not_found_handling: "single-page-application",
        run_worker_first: true,
      },
    });
    expect(m.main_module).toBe("index.js");
    expect(m.compatibility_date).toBe(tpl.compatibility_date);
    expect(m.compatibility_flags).toEqual(tpl.compatibility_flags);
    expect(m.tags).toEqual(["iabcdefghjk2", "v1.2.3"]);
    expect("routes" in m || "triggers" in m).toBe(false);
  });

  it("hosted vars", () => {
    const m = userWorkerMetadata(
      inst({
        vars: {
          EMAIL_FROM: "noreply@a.mail.app.test",
          FEATURES: "spaces,directory_sync",
          EMAIL_DAILY_CAP: "50",
          CODE_EMAILS_PER_DAY: "200",
          AUTH_PROVIDERS: "google,email",
          AUTH_DOMAINS: "finqore.com",
          AUTH_BROKER_URL: "https://auth.example.com/x",
          INSTALL_ID: "iabcdefghjk2",
        },
      }),
      res(),
    );
    expect(text(m.bindings, "HOSTED")).toBe("1");
    expect(text(m.bindings, "INSTALL_ID")).toBe("iabcdefghjk2");
    expect(text(m.bindings, "FEATURES")).toBe(
      "spaces,directory_sync,usage_off",
    );
    expect(text(m.bindings, "EMAIL_DAILY_CAP")).toBe("50");
    expect(text(m.bindings, "AUTH_BROKER_URL")).toBe(
      "https://auth.example.com/x",
    );
  });

  // Manager ruling 2026-10-26: hosted M1 is the spaces product, so every
  // hosted install gets spaces, whatever the caller passes.
  it("FEATURES always gets spaces and usage_off", () => {
    expect(text(userWorkerMetadata(inst(), res()).bindings, "FEATURES")).toBe(
      "spaces,usage_off",
    );
    for (const f of ["x", "directory_sync", "usage_off"])
      expect(
        String(
          text(
            userWorkerMetadata(inst({ vars: { FEATURES: f } }), res()).bindings,
            "FEATURES",
          ),
        ).split(","),
      ).toEqual(expect.arrayContaining(["spaces", "usage_off", f]));
    const m = userWorkerMetadata(
      inst({
        vars: {
          EMAIL_FROM: "noreply@a.mail.app.test",
          FEATURES: "usage_off,x",
        },
      }),
      res(),
    );
    expect(text(m.bindings, "FEATURES")).toBe("usage_off,x,spaces");
  });

  it("unknown or invalid var throws", () => {
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "noreply@a.mail.app.test", NOPE: "1" } }),
        res(),
      ),
    ).toThrow(/unknown var/);
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "noreply@a.mail.app.test", HOSTED: "0" } }),
        res(),
      ),
    ).toThrow(/unknown var/);
    expect(() =>
      userWorkerMetadata(
        inst({
          vars: { EMAIL_FROM: "noreply@a.mail.app.test", EMAIL_DAILY_CAP: "x" },
        }),
        res(),
      ),
    ).toThrow(/invalid var/);
    expect(() =>
      userWorkerMetadata(
        inst({
          vars: {
            EMAIL_FROM: "noreply@a.mail.app.test",
            INSTALL_ID: "iaaaaaaaaaaa",
          },
        }),
        res(),
      ),
    ).toThrow(/INSTALL_ID/);
  });

  it("unfilled placeholder throws", () => {
    const bad = { ...tpl, vars: { ...tpl.vars, EXTRA: "{{NOPE}}" } };
    expect(() => userWorkerMetadata(inst(), res({ template: bad }))).toThrow(
      /unfilled/,
    );
  });

  it("vars carry the install's own hosts", () => {
    const m = userWorkerMetadata(inst(), res());
    expect(text(m.bindings, "APP_HOST")).toBe("a.app.test");
    expect(text(m.bindings, "CONTENT_HOST")).toBe("a.content.test");
    expect(text(m.bindings, "OWNER_EMAIL")).toBe("o@x.test");
    expect(text(m.bindings, "WORKER_NAME")).toBe(
      names("iabcdefghjk2", "staging").script,
    );
    expect(text(m.bindings, "PLAN")).toBe("paid");
    expect(text(m.bindings, "ENVIRONMENT")).toBe("production");
  });

  describe("Durable Object migrations", () => {
    const t2 = {
      ...tpl,
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] },
        { tag: "v2", new_sqlite_classes: ["DirectorySync"] },
        { tag: "v3", new_sqlite_classes: ["UserPresence"] },
      ],
    };
    it("null sends every tag", () => {
      const m = userWorkerMetadata(inst(), res({ template: t2 }));
      expect(m.migrations).toEqual({
        new_tag: "v3",
        steps: [
          { new_sqlite_classes: ["ArtifactRuntime"] },
          { new_sqlite_classes: ["DirectorySync"] },
          { new_sqlite_classes: ["UserPresence"] },
        ],
      });
    });
    it("a known tag sends only later ones", () => {
      const m = userWorkerMetadata(
        inst(),
        res({ template: t2, doMigrationTag: "v1" }),
      );
      expect(m.migrations).toEqual({
        old_tag: "v1",
        new_tag: "v3",
        steps: [
          { new_sqlite_classes: ["DirectorySync"] },
          { new_sqlite_classes: ["UserPresence"] },
        ],
      });
    });
    it("the latest tag sends none; unknown throws", () => {
      expect(
        userWorkerMetadata(inst(), res({ template: t2, doMigrationTag: "v3" }))
          .migrations,
      ).toBeUndefined();
      expect(() =>
        userWorkerMetadata(inst(), res({ template: t2, doMigrationTag: "v9" })),
      ).toThrow(/unknown/);
    });
  });

  it("each install gets its own ratelimit namespace_id", () => {
    const ids = (rlNs: number) =>
      userWorkerMetadata(inst(), res({ rlNs }))
        .bindings.filter((b) => b.type === "ratelimit")
        .map((b) => b.namespace_id);
    const a = ids(1_000_000);
    const b = ids(1_000_008);
    expect(a.some((x) => b.includes(x))).toBe(false);
    expect(tpl.ratelimits.length).toBeLessThanOrEqual(8);
    for (const e of tpl.ratelimits)
      expect(Number(e.namespace_id)).toBeLessThan(1_000_000);
    const nine = {
      ...tpl,
      ratelimits: Array.from({ length: 9 }, (_, k) => ({
        name: `R${k}`,
        namespace_id: "1",
        simple: { limit: 1, period: 60 },
      })),
    };
    expect(() => userWorkerMetadata(inst(), res({ template: nine }))).toThrow(
      /8/,
    );
    const big = {
      ...tpl,
      ratelimits: [
        {
          name: "R",
          namespace_id: "1000000",
          simple: { limit: 1, period: 60 },
        },
      ],
    };
    expect(() => userWorkerMetadata(inst(), res({ template: big }))).toThrow(
      /1000000/,
    );
  });

  it("test hooks", () => {
    const m = userWorkerMetadata(
      inst({ testHooks: true }),
      res({
        secrets: {
          SESSION_SECRET: "s",
          CONTENT_SIGNING_KEY: "c",
          TEST_HOOK_KEY: "k".repeat(32),
        },
      }),
    );
    expect(text(m.bindings, "TEST_HOOKS")).toBe("1");
    expect(m.bindings.find((b) => b.name === "TEST_HOOK_KEY")).toMatchObject({
      type: "secret_text",
      text: "k".repeat(32),
    });
    expect(m.keep_bindings).toBeUndefined();
    expect(() =>
      userWorkerMetadata(
        inst({ testHooks: true }),
        res({ env: "prod", target: "account" }),
      ),
    ).toThrow(/prod/);
    expect(() =>
      userWorkerMetadata(
        inst({ testHooks: true }),
        res({ env: "prod", target: "namespace" }),
      ),
    ).toThrow(/prod/);
    expect(() =>
      userWorkerMetadata(
        inst({ testHooks: true }),
        res({
          secrets: {
            SESSION_SECRET: "s",
            CONTENT_SIGNING_KEY: "c",
            TEST_HOOK_KEY: "short",
          },
        }),
      ),
    ).toThrow(/32/);
    expect(() => userWorkerMetadata(inst({ testHooks: true }), res())).toThrow(
      /create needs every secret/,
    );
    expect(() =>
      userWorkerMetadata(
        inst(),
        res({ secrets: { TEST_HOOK_KEY: "k".repeat(32) } }),
      ),
    ).toThrow(/unknown secret/);
  });

  it("later uploads send only missing secrets, with keep_bindings", () => {
    const full = userWorkerMetadata(inst(), res());
    expect(full.keep_bindings).toBeUndefined();
    expect(
      full.bindings
        .filter((b) => b.type === "secret_text")
        .map((b) => b.name)
        .sort(),
    ).toEqual(["CONTENT_SIGNING_KEY", "SESSION_SECRET"]);
    const part = userWorkerMetadata(
      inst(),
      res({ mode: "update", secrets: { CONTENT_SIGNING_KEY: "c" } }),
    );
    expect(
      part.bindings.filter((b) => b.type === "secret_text").map((b) => b.name),
    ).toEqual(["CONTENT_SIGNING_KEY"]);
    expect(part.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(
      userWorkerMetadata(inst(), res({ mode: "update", secrets: {} }))
        .keep_bindings,
    ).toEqual(["secret_text", "secret_key"]);
  });

  it("observability", () => {
    expect(userWorkerMetadata(inst(), res()).observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1 },
    });
  });

  it("no per-install cron: the central scheduler (apps/scheduler) is the only nightly caller", () => {
    // The template keeps its cron for self-hosted installs; a hosted upload
    // carrying it too would run the nightly job twice (or be ignored).
    expect(tpl.triggers?.crons).toEqual(["17 3 * * *"]);
    for (const m of [
      userWorkerMetadata(inst(), res()),
      userWorkerMetadata(inst(), res({ mode: "update", secrets: {} })),
    ])
      expect(JSON.stringify(m)).not.toMatch(/cron|trigger|schedul|17 3/i);
  });

  it("no secret names appear as plain bindings", () => {
    const m = userWorkerMetadata(inst(), res());
    for (const n of [
      "SESSION_SECRET",
      "CONTENT_SIGNING_KEY",
      "ACCESS_CLIENT_SECRET",
      "ANALYTICS_TOKEN",
    ])
      expect(
        m.bindings.some((b) => b.name === n && b.type !== "secret_text"),
        n,
      ).toBe(false);
    expect(
      m.bindings.some(
        (b) =>
          b.name === "ACCESS_CLIENT_SECRET" || b.name === "ANALYTICS_TOKEN",
      ),
    ).toBe(false);
  });
});

describe("round 1", () => {
  it("create requires every secret", () => {
    expect(() =>
      userWorkerMetadata(inst(), res({ secrets: { SESSION_SECRET: "s" } })),
    ).toThrow(/create needs every secret/);
  });

  it("rlNs is validated", () => {
    for (const rlNs of [0, 1001, -8, 1_000_001, 1_000_000.5, 3_000_000])
      expect(
        () => userWorkerMetadata(inst(), res({ rlNs })),
        String(rlNs),
      ).toThrow(/rlNs/);
  });

  it("a second D1, R2 or KV entry throws", () => {
    for (const k of ["d1_databases", "r2_buckets", "kv_namespaces"]) {
      const t = { ...tpl, [k]: [...tpl[k], ...tpl[k]] };
      expect(() => userWorkerMetadata(inst(), res({ template: t }))).toThrow(
        /more than one/,
      );
    }
  });

  it("setup tunables and NIGHTLY_PUBKEY are allowed and validated", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const m = userWorkerMetadata(
      inst({
        vars: {
          EMBED_ORIGINS: "https://Foo.test:443",
          DATA_DOC_BYTES: "1000",
          NIGHTLY_PUBKEY: key,
        },
      }),
      res(),
    );
    expect(text(m.bindings, "EMBED_ORIGINS")).toBe("https://foo.test");
    expect(text(m.bindings, "DATA_DOC_BYTES")).toBe("1000");
    expect(text(m.bindings, "NIGHTLY_PUBKEY")).toBe(key);
    const badVars: Record<string, string>[] = [
      { DATA_DOC_BYTES: "abc" },
      { EMBED_ORIGINS: "http://x.test" },
      { NIGHTLY_PUBKEY: "short" },
      { NIGHTLY_PUBKEY: Buffer.alloc(31).toString("base64url") },
    ];
    for (const vars of badVars)
      expect(() => userWorkerMetadata(inst({ vars }), res())).toThrow(
        /invalid var/,
      );
  });

  it("assets: exactly one of jwt and keepAssets; config from the template", () => {
    expect(() =>
      userWorkerMetadata(inst(), res({ assetsJwt: undefined })),
    ).toThrow(/exactly one/);
    expect(() => userWorkerMetadata(inst(), res({ keepAssets: true }))).toThrow(
      /exactly one/,
    );
    const k = userWorkerMetadata(
      inst(),
      res({ assetsJwt: undefined, keepAssets: true }),
    );
    expect(k.keep_assets).toBe(true);
    expect(k.assets.jwt).toBeUndefined();
    expect(userWorkerMetadata(inst(), res()).assets.jwt).toBe("jwt");
    const t = { ...tpl, assets: { ...tpl.assets, html_handling: "none" } };
    expect(
      userWorkerMetadata(inst(), res({ template: t })).assets.config,
    ).toMatchObject({ html_handling: "none" });
    const bad = { ...tpl, assets: { ...tpl.assets, surprise: 1 } };
    expect(() => userWorkerMetadata(inst(), res({ template: bad }))).toThrow(
      /unknown assets config key/,
    );
  });

  it("validates inputs", () => {
    const bad: Partial<InstallMetaInput>[] = [
      { id: "nope" },
      { appHost: "A.app.test" },
      { contentHost: "x" },
      { ownerEmail: "nope" },
    ];
    for (const b of bad)
      expect(() => userWorkerMetadata(inst(b), res())).toThrow();
    expect(() => userWorkerMetadata(inst(), res({ d1Id: "x" }))).toThrow(
      /UUID/,
    );
    expect(() => userWorkerMetadata(inst(), res({ kvId: "x" }))).toThrow(
      /32 hex/,
    );
  });

  it("EMAIL_FROM is tied to the install", () => {
    const m = userWorkerMetadata(inst(), res());
    expect(text(m.bindings, "EMAIL_FROM")).toBe("noreply@a.mail.app.test");
    expect(() =>
      userWorkerMetadata(
        inst({ vars: { EMAIL_FROM: "noreply@b.mail.app.test" } }),
        res(),
      ),
    ).toThrow(/EMAIL_FROM/);
  });

  it("asserts values for AUTH_* and CODE_EMAILS_PER_DAY", () => {
    const m = userWorkerMetadata(
      inst({
        vars: {
          CODE_EMAILS_PER_DAY: "250",
          AUTH_PROVIDERS: "google,email",
          AUTH_DOMAINS: "finqore.com",
        },
      }),
      res(),
    );
    expect(text(m.bindings, "CODE_EMAILS_PER_DAY")).toBe("250");
    expect(text(m.bindings, "AUTH_PROVIDERS")).toBe("google,email");
    expect(text(m.bindings, "AUTH_DOMAINS")).toBe("finqore.com");
  });

  // Manager ruling 2026-10-24 (#572): hosted AUTH_DOMAINS isn't verified as
  // owned, so a hosted install never admits by domain until it is.
  it("always renders AUTH_DOMAIN_JOIN=invite", () => {
    const cases: Record<string, string>[] = [
      {},
      { AUTH_DOMAIN_JOIN: "invite" },
    ];
    for (const vars of cases) {
      const m = userWorkerMetadata(inst({ vars }), res());
      expect(text(m.bindings, "AUTH_DOMAIN_JOIN")).toBe("invite");
    }
  });

  it.each(["member", "Member", "", " invite"])(
    "refuses AUTH_DOMAIN_JOIN=%j",
    (v) => {
      expect(() =>
        userWorkerMetadata(inst({ vars: { AUTH_DOMAIN_JOIN: v } }), res()),
      ).toThrow(/AUTH_DOMAIN_JOIN.*invite/);
    },
  );

  it("two installs share no resource, host or ratelimit id", () => {
    const a = userWorkerMetadata(inst(), res({ rlNs: 2_000_000 }));
    const b = userWorkerMetadata(
      inst({
        id: "ibcdefghjk2a",
        appHost: "b.app.test",
        contentHost: "b.content.test",
      }),
      res({
        rlNs: 2_000_008,
        d1Id: "aaaaaaaa-2222-4333-8444-555555555555",
        kvId: "fedcba9876543210fedcba9876543210",
      }),
    );
    const pick = (m: typeof a, type: string, key: string) =>
      m.bindings.filter((x) => x.type === type).map((x) => x[key]);
    expect(pick(a, "d1", "id")).not.toEqual(pick(b, "d1", "id"));
    expect(pick(a, "kv_namespace", "namespace_id")).not.toEqual(
      pick(b, "kv_namespace", "namespace_id"),
    );
    expect(pick(a, "r2_bucket", "bucket_name")).not.toEqual(
      pick(b, "r2_bucket", "bucket_name"),
    );
    for (const k of ["APP_HOST", "CONTENT_HOST", "WORKER_NAME"])
      expect(text(a.bindings, k)).not.toBe(text(b.bindings, k));
    const ra = pick(a, "ratelimit", "namespace_id");
    const rb = pick(b, "ratelimit", "namespace_id");
    expect(ra.some((x) => rb.includes(x))).toBe(false);
  });

  it("no plain_text value equals a secret value", () => {
    const secrets = {
      SESSION_SECRET: "sess-secret-value-1234567890abcdef",
      CONTENT_SIGNING_KEY: "sign-secret-value-1234567890abcdef",
    };
    const m = userWorkerMetadata(inst(), res({ secrets }));
    for (const b of m.bindings.filter((x) => x.type === "plain_text"))
      expect(Object.values(secrets)).not.toContain(b.text);
    expect(
      JSON.stringify(m.bindings.filter((x) => x.type !== "secret_text")),
    ).not.toContain("secret-value");
  });

  it("scriptSubdomainSettings disables workers.dev and previews", () => {
    expect(scriptSubdomainSettings()).toEqual({
      enabled: false,
      previews_enabled: false,
    });
  });

  it("every server secret in env.ts is known or excluded", async () => {
    const { requiredSecrets } = await import(
      "../../../scripts/ops/check-staging-secrets.ts"
    );
    const root = new URL("../../../", import.meta.url);
    const needed: string[] = requiredSecrets(
      await readFile(new URL("apps/server/src/env.ts", root), "utf8"),
      await readFile(
        new URL("apps/server/wrangler.staging.jsonc", root),
        "utf8",
      ),
    );
    const ok = new Set<string>([
      ...KNOWN_SECRETS,
      ...Object.keys(TEMPLATE_BINDINGS_EXCLUDED),
    ]);
    for (const n of needed) expect(ok.has(n), `server secret ${n}`).toBe(true);
  });
});

describe("buildBundle", () => {
  it("renders a dummy config, runs wrangler through exec and reads modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-root-"));
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "9.8.7" }),
    );
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      await readFile(TEMPLATE_PATH),
    );
    const calls: {
      cmd: string;
      args: string[];
      cwd: string;
      config: Record<string, unknown>;
    }[] = [];
    const b = await buildBundle(root, {
      exec: async (cmd, args, o) => {
        const outdir = args[args.indexOf("--outdir") + 1] as string;
        const cfg = args[args.indexOf("-c") + 1] as string;
        calls.push({
          cmd,
          args,
          cwd: o.cwd,
          config: JSON.parse(await readFile(cfg, "utf8")),
        });
        await mkdir(join(outdir, "chunks"), { recursive: true });
        await writeFile(join(outdir, "index.js"), "export default {}");
        await writeFile(join(outdir, "chunks/a.mjs"), "export {}");
        await writeFile(
          join(outdir, "x.wasm"),
          new Uint8Array([0, 97, 115, 109]),
        );
        await writeFile(join(outdir, "README.md"), "no");
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("pnpm");
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "--dir",
      "apps/server",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
    ]);
    expect(JSON.stringify(calls[0]?.config)).not.toContain("{{");
    expect(calls[0]?.config.routes).toBeUndefined();
    // dummy values must pass wrangler's validation (found by a real dry run)
    const cfg = calls[0]?.config as {
      r2_buckets: { bucket_name: string }[];
      d1_databases: { database_id: string }[];
    };
    expect(cfg.r2_buckets[0]?.bucket_name).toMatch(
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
    );
    expect(cfg.d1_databases[0]?.database_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.mainModule).toBe("index.js");
    expect(b.version).toBe("9.8.7");
    expect(b.assetsDir).toBe("apps/server/dist-assets");
    expect(b.modules.map((m) => [m.name, m.type]).sort()).toEqual([
      ["chunks/a.mjs", "esm"],
      ["index.js", "esm"],
      ["x.wasm", "wasm"],
    ]);
    expect(b.modules.find((m) => m.name === "x.wasm")?.bytes).toEqual(
      new Uint8Array([0, 97, 115, 109]),
    );
  });

  it("skips .map and README.md, throws on other unexpected modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-root-"));
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      await readFile(TEMPLATE_PATH),
    );
    const run = (extra: string) =>
      buildBundle(root, {
        exec: async (_c, args) => {
          const outdir = args[args.indexOf("--outdir") + 1] as string;
          await writeFile(join(outdir, "index.js"), "export default {}");
          await writeFile(join(outdir, "index.js.map"), "{}");
          await writeFile(join(outdir, "README.md"), "x");
          await writeFile(join(outdir, extra), "x");
        },
      });
    await expect(run("data.bin")).rejects.toThrow(/unexpected wrangler output/);
    await expect(run("a.txt")).rejects.toThrow(/unexpected/);
  });

  it("throws when wrangler produced no main module", async () => {
    const root = await mkdtemp(join(tmpdir(), "oa-root-"));
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      await readFile(TEMPLATE_PATH),
    );
    await expect(buildBundle(root, { exec: async () => {} })).rejects.toThrow(
      /no index.js/,
    );
  });
});

describe("env-prefixed names in metadata", () => {
  it("staging and prod emit their own prefixes", () => {
    const st = userWorkerMetadata(inst(), res({ env: "staging" }));
    const pr = userWorkerMetadata(inst(), res({ env: "prod" }));
    expect(text(st.bindings, "WORKER_NAME")).toBe("oa-s-iabcdefghjk2");
    expect(text(pr.bindings, "WORKER_NAME")).toBe("oa-p-iabcdefghjk2");
    const bucket = (m: typeof st) =>
      (m.bindings.find((b) => b.type === "r2_bucket") as Binding).bucket_name;
    expect(bucket(st)).toBe("oa-s-iabcdefghjk2");
    expect(bucket(pr)).toBe("oa-p-iabcdefghjk2");
  });
  it("a forged env cannot produce a foreign name", () => {
    for (const env of ["dev", "", "oa-s-", undefined, "Prod"])
      expect(() =>
        userWorkerMetadata(inst(), res({ env: env as never })),
      ).toThrow();
  });
  it("a foreign name from the template is refused", () => {
    const base = loadTemplate();
    const forge = (mut: (t: Template) => void) => {
      const tpl = structuredClone(base);
      mut(tpl);
      return () => userWorkerMetadata(inst(), res({ template: tpl }));
    };
    expect(forge((t) => (t.vars.WORKER_NAME = "open-artifacts"))).toThrow(
      /ForeignResource|refusing/,
    );
    expect(
      forge((t) => (t.d1_databases[0].database_name = "open-artifacts")),
    ).toThrow(/refusing/);
    expect(
      forge((t) => (t.r2_buckets[0].bucket_name = "terrazul-api")),
    ).toThrow(/refusing/);
    expect(forge(() => {})).not.toThrow();
  });
});

describe("EMAIL_CODE_DOMAIN var (H-ECD)", () => {
  const val = (v: string) => () =>
    userWorkerMetadata(inst({ vars: { EMAIL_CODE_DOMAIN: v } }), res());
  it("accepts on and off only", () => {
    expect(val("on")).not.toThrow();
    expect(val("off")).not.toThrow();
    for (const v of ["ON", "true", "1", "", " on", "yes"])
      expect(val(v)).toThrow(/EMAIL_CODE_DOMAIN/);
  });
  it("on is a plain_text binding; off and absent are not bound", () => {
    const text = (vars: Record<string, string>) =>
      userWorkerMetadata(inst({ vars }), res()).bindings.find(
        (b) => b.name === "EMAIL_CODE_DOMAIN",
      );
    expect(text({ EMAIL_CODE_DOMAIN: "on" })).toEqual({
      type: "plain_text",
      name: "EMAIL_CODE_DOMAIN",
      text: "on",
    });
    expect(text({ EMAIL_CODE_DOMAIN: "off" })).toBeUndefined();
    expect(text({})).toBeUndefined();
  });
});

describe("googleNewlyEnabled and epochBumpSql (H-ECD)", () => {
  it.each([
    [{}, { AUTH_PROVIDERS: "google" }, true],
    [{ AUTH_PROVIDERS: "email" }, { AUTH_PROVIDERS: "email, google" }, true],
    [{ AUTH_PROVIDERS: "google" }, { AUTH_PROVIDERS: "google,email" }, false],
    [{ AUTH_PROVIDERS: "google" }, { AUTH_PROVIDERS: "google" }, false],
    [{ AUTH_PROVIDERS: "google" }, { AUTH_PROVIDERS: "email" }, false],
    [{ AUTH_PROVIDERS: "email" }, { AUTH_PROVIDERS: "email" }, false],
    [{}, {}, false],
    [{ AUTH_PROVIDERS: "email" }, {}, false],
    [{}, { AUTH_PROVIDERS: "googler" }, false],
  ])("%j -> %j is %s", (prev, next, want) => {
    expect(googleNewlyEnabled(prev, next)).toBe(want);
  });
  it("epochBumpSql is the exact statement", () => {
    expect(epochBumpSql()).toBe(
      "UPDATE users SET session_epoch = session_epoch + 1",
    );
  });
});

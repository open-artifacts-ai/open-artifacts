// P1 Task 5: upgrade, rollback, updateVars, rotateTurnstileSecret and delete,
// against the in-memory Cloudflare (fake-cf.ts). Harness pieces mirror
// wfp-create.test.ts (gates mocked, every generated secret captured).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cfClient, type Target } from "../src/cf.js";
import { epochBumpSql, type Template } from "../src/metadata.js";
import {
  ENV_PREFIX,
  type Env,
  isPurgedEmail,
  ownerEmailOf,
  PURGED_EMAIL,
  platformNames,
  registryKey,
} from "../src/names.js";
import { canonicalJson } from "../src/platform.js";
import {
  assetEntries,
  bundleSha256,
  migrationsSha256,
  type ReleaseAsset,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "../src/release.js";
import { REVOKE_MIN_VERSION } from "../src/versions.js";
import {
  BROKER_GOOGLE_CLIENT_ID,
  DIRECTORY_REVOKE_SKIPPED_NOTE,
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  ProdLocked,
  ProvisionRefused,
  ProvisionRetry,
  TURNSTILE_TEST_KEYS,
  type WfpOptions,
  WfpProvisioner,
} from "../src/wfp.js";
import { type FakeCf as Fake, FakeCf } from "./fake-cf.js";

const H = vi.hoisted(() => ({ SENSITIVE: new Set<string>() }));
const G = vi.hoisted(() => ({
  PROD_UNLOCKED: true,
  ALLOW_ACCOUNT_TARGET: true,
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
  FLOOR_MIN_SEQ: { staging: 1, prod: 1 } as Record<string, number>,
}));
// Every node:fs call that writes, with its path: a run with no patDir must make none.
const FSW = vi.hoisted(() => {
  const WRITES: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: wraps overloaded fs functions
  const recordWrites = (m: any) => {
    // biome-ignore lint/suspicious/noExplicitAny: overloaded
    const out: Record<string, any> = {};
    for (const f of [
      "mkdirSync",
      "openSync",
      "writeFileSync",
      "writeSync",
      "rmSync",
    ])
      out[f] = (p: unknown, ...a: unknown[]) => {
        WRITES.push(`${f} ${String(p)}`);
        return m[f](p, ...a);
      };
    return { ...m, ...out, default: { ...m, ...out } };
  };
  return { WRITES, recordWrites };
});
vi.mock("node:fs", async (orig) => FSW.recordWrites(await orig()));
vi.mock("../src/internal/gates.js", async (orig) => {
  const m = await orig<typeof import("../src/internal/gates.js")>();
  return {
    ...m,
    get PROD_UNLOCKED() {
      return G.PROD_UNLOCKED;
    },
    get ALLOW_ACCOUNT_TARGET() {
      return G.ALLOW_ACCOUNT_TARGET;
    },
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
    get FLOOR_MIN_SEQ() {
      return G.FLOOR_MIN_SEQ;
    },
  };
});
vi.mock("@oa/shared", async (orig) => {
  const m = await orig<typeof import("@oa/shared")>();
  return {
    ...m,
    newPat: () => {
      const v = m.newPat();
      H.SENSITIVE.add(v);
      return v;
    },
  };
});
const SENSITIVE = H.SENSITIVE;
beforeAll(() => {
  const real = crypto.getRandomValues.bind(crypto);
  vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(a: T): T => {
      const r = real(a as unknown as Uint8Array) as unknown as T;
      const v = a as unknown as Uint8Array;
      if (v && v.byteLength === 48)
        SENSITIVE.add(
          Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString(
            "base64url",
          ),
        );
      return r;
    },
  );
});

const NOW = Date.parse("2026-10-23T00:00:00Z");
const ROOT = new URL("../../../", import.meta.url);
const PLATFORM_SQL = readdirSync(new URL("apps/platform-db/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) =>
    readFileSync(new URL(`apps/platform-db/migrations/${f}`, ROOT), "utf8"),
  )
  .join("\n");
const SERVER_MIGRATIONS = readdirSync(new URL("apps/server/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const OWNER = "owner@finqore.test";
const EMAILS = new Set([OWNER]);

const THROWN: string[] = [];
const PRINTABLE: string[] = [];
const FAKES: Fake[] = [];
const PROVS: WfpProvisioner[] = [];

/** The rejection; `code` is a ProvisionRefused's job error code. */
async function fails(p: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await p;
  } catch (e) {
    THROWN.push(String((e as Error).message), String(e), JSON.stringify(e));
    return e as Error & { code?: unknown };
  }
  throw new Error("expected a failure");
}
const keep = <T>(v: T): T => {
  PRINTABLE.push(JSON.stringify(v));
  return v;
};

const enc = (s: string) => new TextEncoder().encode(s);

const bundleOf = (variant: "release" | "redline", version: string) => ({
  modules: [
    {
      name: "index.js",
      type: "esm" as const,
      bytes: enc(
        `const hooksAllowed = ${variant === "redline"};\n// ${version}\nexport default { fetch() { return new Response(String(hooksAllowed)); } };\n`,
      ),
    },
  ],
  mainModule: "index.js",
  version,
});

const TEMPLATE_BYTES = new Uint8Array(
  readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
);
const BASE_TEMPLATE: Template = JSON.parse(
  new TextDecoder()
    .decode(TEMPLATE_BYTES)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,(\s*[}\]])/g, "$1"),
);
// The fixture tags derive from the live template, so a new server DO tag
// (P3 T7a's UserPresence v2) doesn't collide with them: BASE_TAG is the
// release's own latest tag, LEDGER_TAG the fixture's added class, and
// FOREIGN_TAG a live tag that is in no release.
const BASE_TAG = String(
  (BASE_TEMPLATE.migrations as { tag: string }[]).at(-1)?.tag,
);
const LEDGER_TAG = `${BASE_TAG}-ledger`;
const FOREIGN_TAG = "foreign-tag";
const MIGRATION_FILES: ReleaseFile[] = SERVER_MIGRATIONS.map((name) => ({
  name,
  bytes: new Uint8Array(
    readFileSync(new URL(`apps/server/migrations/${name}`, ROOT)),
  ),
}));
const NEW_MIGRATION: ReleaseFile = {
  name: "9001_t5_lifecycle.sql",
  bytes: enc("CREATE TABLE t5_probe (id INTEGER PRIMARY KEY);"),
};
const ASSETS: ReleaseAsset[] = [
  { path: "index.html", bytes: enc("<!doctype html><p>hi</p>") },
  { path: "app.js", bytes: enc("console.log(1)") },
];
const ASSETS_24: ReleaseAsset[] = [
  { path: "index.html", bytes: enc("<!doctype html><p>hi v24</p>") },
  { path: "app.js", bytes: enc("console.log(24)") },
];
const WELCOME = enc("# Welcome to Open Artifacts\n\nFrom the release.\n");

/** Release content of one version; a Template object is serialized. */
type Spec = {
  template?: Template;
  migrations?: ReleaseFile[];
  assets?: ReleaseAsset[];
};
const tplBytes = (t?: Template) =>
  t === undefined ? TEMPLATE_BYTES : enc(JSON.stringify(t, null, 2));

const SIGNER = generateKeyPairSync("ed25519");
SENSITIVE.add(
  SIGNER.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url"),
);
const PUB = SIGNER.publicKey.export({ format: "jwk" }).x as string;
G.RELEASE_PUBKEY = { staging: PUB, prod: PUB };

const signed = (domain: string, env: string, v: unknown) => {
  const s = canonicalJson(v);
  return {
    record: s,
    signature: sign(
      null,
      Buffer.from(`${domain}\n${env}\n${s}`),
      SIGNER.privateKey,
    ).toString("base64url"),
  };
};
type Floor = { seq: number; minVersion: string; revoked: string[] };
const signFloor = (env: Env, f: Partial<Floor> = {}) =>
  signed("oa-release-floor-v1", env, {
    env,
    seq: 1,
    minVersion: "0.1.0",
    revoked: [],
    ...f,
  });

const recordOf = (
  env: Env,
  variant: "release" | "redline",
  version: string,
  spec: Spec,
): ReleaseRecord => ({
  env,
  version,
  variant,
  sha256: bundleSha256(bundleOf(variant, version)),
  defines: { [TEST_HOOKS_DEFINE]: variant === "redline" },
  assets: assetEntries(spec.assets ?? ASSETS),
  templateSha256: createHash("sha256")
    .update(tplBytes(spec.template))
    .digest("hex"),
  migrationsSha256: migrationsSha256(spec.migrations ?? MIGRATION_FILES),
  welcomeSha256: createHash("sha256").update(WELCOME).digest("hex"),
});

/** A signed, multi-version release store; `floor` is mutable per test. */
function makeReleases(env: Env, specs: Record<string, Spec> = {}) {
  const st = {
    floor: signFloor(env) as unknown,
    specs: { ...specs } as Record<string, Spec>,
    records: [] as { version: string; variant: string }[],
  };
  const spec = (v: string) => st.specs[v] ?? {};
  const reader: ReleaseReader = {
    record: async (version, variant) => {
      st.records.push({ version, variant });
      return signed(
        "oa-release-v1",
        env,
        recordOf(env, variant, version, spec(version)),
      );
    },
    modules: async (version, variant) => {
      const b = bundleOf(variant, version);
      return { mainModule: b.mainModule, modules: b.modules };
    },
    assets: async (version) => assetEntries(spec(version).assets ?? ASSETS),
    assetBytes: async (version, _variant, path) => {
      const a = (spec(version).assets ?? ASSETS).find((x) => x.path === path);
      if (!a) throw new Error(`no asset ${path}`);
      return a.bytes.slice();
    },
    template: async (version) => tplBytes(spec(version).template).slice(),
    migrations: async (version) =>
      (spec(version).migrations ?? MIGRATION_FILES).map((f) => ({
        ...f,
        bytes: f.bytes.slice(),
      })),
    welcome: async () => WELCOME.slice(),
    floor: async () => st.floor,
  };
  return { st, reader };
}

/** 0.24.0 adds one D1 migration and new assets; same DO tag as 0.23.0. */
const V24: Spec = {
  migrations: [...MIGRATION_FILES, NEW_MIGRATION],
  assets: ASSETS_24,
};
/** 0.25.0 adds a DO class (LEDGER_TAG) without binding it: allowed. */
const V25_TAG: Spec = {
  template: {
    ...BASE_TEMPLATE,
    migrations: [
      ...BASE_TEMPLATE.migrations,
      { tag: LEDGER_TAG, new_sqlite_classes: ["Ledger"] },
    ],
  },
};
/** 0.21.0 has a binding named AUTH_DOMAINS: that var cannot render on it. */
const V21_NAME_CLASH: Spec = {
  template: {
    ...BASE_TEMPLATE,
    durable_objects: {
      bindings: [
        ...BASE_TEMPLATE.durable_objects.bindings,
        { name: "AUTH_DOMAINS", class_name: "ArtifactRuntime" },
      ],
    },
  },
};
/** 0.26.0 adds a DO class and binds it in the same release: refused. */
const V26_BOUND: Spec = {
  template: {
    ...BASE_TEMPLATE,
    durable_objects: {
      bindings: [
        ...BASE_TEMPLATE.durable_objects.bindings,
        { name: "LEDGER", class_name: "Ledger" },
      ],
    },
    migrations: [
      ...BASE_TEMPLATE.migrations,
      { tag: LEDGER_TAG, new_sqlite_classes: ["Ledger"] },
    ],
  },
};

const TS = {
  sitekey: "0x4AAAAAAAstagingSITEKEY",
  secret: `0x4AAAAAAAts-secret-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`,
};
const TS_NEXT = `0x4AAAAAAAts-rotated-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
SENSITIVE.add(TS.secret);
SENSITIVE.add(TS_NEXT);
const CODES = { AUTH_PROVIDERS: "email" };
const HOOK_VARS = { TEST_DOMAIN: "redline.test" };

function setup(o: { env?: Env; specs?: Record<string, Spec> } = {}) {
  const fake = new FakeCf({ now: NOW });
  FAKES.push(fake);
  SENSITIVE.add(fake.token);
  const env = o.env ?? "staging";
  const pdb = fake.seedD1(platformNames(env).db, PLATFORM_SQL);
  const hostsId = fake.seedKv(hostsKvTitle(env));
  const regId = fake.seedKv(platformNames(env).registry);
  const dirId = fake.seedKv(platformNames(env).directoryRegistry);
  fake.turnstile.set(TS.sitekey, {
    sitekey: TS.sitekey,
    name: platformNames(env).turnstile,
    domains: [HOSTED_DOMAINS[env].app],
    mode: "managed",
  });
  const target: Target = { kind: "namespace", ns: NAMESPACES[env] };
  fake.dispatch = { hostsKvId: hostsId, ns: target.ns };
  const patDir = mkdtempSync(join(tmpdir(), "oa-t5-pat-"));
  let t = NOW;
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  const rel = makeReleases(env, {
    "0.24.0": V24,
    "0.25.0": V25_TAG,
    "0.26.0": V26_BOUND,
    "0.21.0": V21_NAME_CLASH,
    // 0.25.0's DO step on top of 0.24.0's migrations.
    "0.28.0": { ...V25_TAG, migrations: V24.migrations },
    "0.27.0": {
      migrations: [
        ...MIGRATION_FILES,
        { name: "0002_zz_out_of_order.sql", bytes: enc("SELECT 1;") },
      ],
    },
    ...o.specs,
  });
  const cfWith = (f: typeof fetch = fake.fetch) =>
    cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: f,
      sleep: async () => {},
    });
  const opts = (over: Partial<WfpOptions> = {}): WfpOptions => ({
    cf: cfWith(),
    env,
    target,
    domains: HOSTED_DOMAINS[env],
    release: rel.reader,
    patDir,
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
    healthTimeoutMs: 10_000,
    turnstile: TS,
    // T8 M1: google needs the broker, so the lifecycle suite runs with it on
    // (staging only: prod has no broker Google client yet).
    brokerEnabled: env === "staging",
    ...over,
  });
  const mk = (over: Partial<WfpOptions> = {}) => {
    const p = new WfpProvisioner(opts(over));
    PROVS.push(p);
    return p;
  };
  const db = () => (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  const row = (id: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: test rows
    db().prepare("SELECT * FROM installs WHERE id = ?").get(id) as any;
  const audit = (id: string) =>
    db()
      .prepare(
        "SELECT action FROM hosted_audit WHERE install_id = ? ORDER BY id",
      )
      .all(id)
      .map((r) => (r as { action: string }).action);
  const stored = (id: string, version: string) =>
    db()
      .prepare(
        "SELECT * FROM install_versions WHERE install_id = ? AND version = ?",
      )
      .get(id, version) as
      | {
          metadata: string;
          vars: string;
          do_migration_tag: string | null;
        }
      | undefined;
  const scriptOf = (id: string) =>
    fake.script(target.ns, `${ENV_PREFIX[env]}${id}`);
  const installDb = (id: string) =>
    (fake.d1.get(row(id).d1_id) as { db: DatabaseSync }).db;
  return {
    fake,
    env,
    p: mk(),
    mk,
    cfWith,
    opts,
    patDir,
    pdb,
    hostsId,
    regId,
    dirId,
    rel,
    target,
    db,
    row,
    audit,
    stored,
    scriptOf,
    installDb,
    clock,
  };
}
type S = ReturnType<typeof setup>;

const input = (
  slug = "finqore",
  o: Partial<Parameters<WfpProvisioner["create"]>[0]> = {},
): Parameters<WfpProvisioner["create"]>[0] => ({
  slug,
  ownerEmail: OWNER,
  plan: "paid",
  vars: {},
  bundle: "release",
  version: "0.23.0",
  ...o,
});

const uploads = (fake: Fake, from = 0) =>
  fake.log
    .map((e, i) => ({ ...e, i, body: fake.raw[i]?.body ?? "" }))
    .slice(from)
    .filter(
      (e) =>
        e.method === "PUT" &&
        /\/scripts\/[^/?]+$/.test(e.path) &&
        e.status !== 412,
    );
/** Tag probes (L5): uploads no script accepts; the 412 names the live tag. */
const probes = (fake: Fake, from = 0) =>
  fake.log
    .slice(from)
    .filter(
      (e) =>
        e.method === "PUT" &&
        /\/scripts\/[^/?]+$/.test(e.path) &&
        e.status === 412,
    );

function metaOf(body: string) {
  const m = body.match(
    /name="metadata"[^\n]*\r?\n(?:[^\n]*\r?\n)*?\r?\n(\{.*\})\r?\n/,
  );
  if (!m) throw new Error("no metadata part");
  return JSON.parse(m[1] as string);
}

/** Index of every call (from `from`) whose path matches. */
const callsTo = (fake: Fake, re: RegExp, from = 0) =>
  fake.log
    .map((e, i) => ({ e, i }))
    .slice(from)
    .filter(({ e }) => re.test(`${e.method} ${e.path}`))
    .map(({ i }) => i);

const unhealthyAt = (s: S, version: string) => {
  s.fake.health = (sc) =>
    (sc.metadata.tags as string[]).includes(`v${version}`)
      ? { ok: false }
      : undefined;
};

const epochOf = (s: S, id: string) => () =>
  (
    s
      .installDb(id)
      .prepare("SELECT session_epoch FROM users WHERE email = ?")
      .get(OWNER) as { session_epoch: number }
  ).session_epoch;

const modulesText = (s: S, id: string) =>
  new TextDecoder().decode(s.scriptOf(id)?.modules.get("index.js")?.bytes);

describe("create stores per-version metadata", () => {
  it("each successful upload stores the rendered metadata (no secret values) keyed by install and version", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const st = s.stored(inst.id, "0.23.0");
    expect(st).toBeDefined();
    expect(st?.do_migration_tag).toBe(BASE_TAG);
    const m = JSON.parse(st?.metadata as string);
    expect(m.main_module).toBe("index.js");
    expect(m.compatibility_date).toBe(BASE_TEMPLATE.compatibility_date);
    expect(m.tags).toEqual([inst.id, "v0.23.0"]);
    expect(m.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(m.assets.jwt).toBeUndefined();
    expect(m.migrations).toBeUndefined();
    expect(
      m.bindings.filter((b: { type: string }) => b.type.startsWith("secret")),
    ).toEqual([]);
    expect(JSON.parse(st?.vars as string)).toEqual({});
  });
});

describe("fix round 1: create writes install_versions and vars for every new install", () => {
  it("every create (fresh, hooks, codes on, resumed after a failed upload) leaves an install_versions row and installs.vars", async () => {
    const s = setup();
    const made = [
      keep(await s.p.create(input("one"))),
      keep(await s.p.create(input("two", { vars: CODES }))),
      keep(
        await s.p.create(
          input("red", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
        ),
      ),
    ];
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-[^/]+$/.test(p));
    await fails(s.p.create(input("resumed")));
    made.push(keep(await s.p.create(input("resumed"))));
    const varsOf = [{}, CODES, HOOK_VARS, {}];
    made.forEach((inst, k) => {
      const st = s.stored(inst.id, "0.23.0");
      expect(st, inst.slug).toBeDefined();
      expect(JSON.parse(st?.vars as string)).toEqual(varsOf[k]);
      expect(JSON.parse(s.row(inst.id).vars)).toEqual(varsOf[k]);
    });
    expect(
      s.db().prepare("SELECT count(*) AS n FROM install_versions").get(),
    ).toEqual({ n: 4 });
  });

  it("an upgrade of a row without its install_versions row is refused with a clear message, before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.db().prepare("DELETE FROM install_versions").run();
    const w = s.fake.writes().length;
    const e = await fails(s.p.upgrade(inst.id, "0.24.0"));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(
      /no stored metadata for 0\.23\.0.*created before per-version metadata/,
    );
    expect(s.fake.writes().length).toBe(w);
  });
});

describe("upgrade", () => {
  it("upgrade applies only new migrations and keeps bindings", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const before = s.scriptOf(inst.id);
    const secretsBefore = new Map(before?.secrets);
    const from = s.fake.log.length;
    const r = keep(await s.p.upgrade(inst.id, "0.24.0"));
    expect(r).toEqual({
      id: inst.id,
      from: "0.23.0",
      to: "0.24.0",
      ok: true,
      rolledBack: false,
    });
    // Only the new migration file ran against the install's D1.
    const applied = s
      .installDb(inst.id)
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((x) => (x as { name: string }).name);
    expect(applied).toEqual([...SERVER_MIGRATIONS, NEW_MIGRATION.name]);
    const migCalls = s.fake.raw
      .slice(from)
      .filter((x) => x.body.includes("INSERT INTO d1_migrations"));
    expect(migCalls).toHaveLength(1);
    expect(migCalls[0]?.body).toContain(NEW_MIGRATION.name);
    // One upload: keep_bindings, no secret value, no migrations (same tag).
    const up = uploads(s.fake, from);
    expect(up).toHaveLength(1);
    const meta = metaOf(up[0]?.body as string);
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(
      meta.bindings.filter((b: { type: string }) => b.type === "secret_text"),
    ).toEqual([]);
    expect(meta.migrations).toBeUndefined();
    expect(meta.tags).toEqual([inst.id, "v0.24.0"]);
    expect(s.scriptOf(inst.id)?.secrets).toEqual(secretsBefore);
    expect(modulesText(s, inst.id)).toContain("0.24.0");
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.24.0",
      previous_version: "0.23.0",
      do_migration_tag: BASE_TAG,
      lease: null,
    });
    expect(s.stored(inst.id, "0.24.0")).toBeDefined();
    expect(s.audit(inst.id)).toEqual(
      expect.arrayContaining(["upgrade.start", "upgrade.done"]),
    );
  });

  it("a failed healthcheck after upgrade rolls back to the previous bundle and reports it, leaving other installs alone", async () => {
    const s = setup();
    const a = keep(await s.p.create(input("alpha")));
    const b = keep(await s.p.create(input("beta")));
    const bUploads = s.scriptOf(b.id)?.uploads;
    unhealthyAt(s, "0.24.0");
    const r = keep(await s.p.upgrade(a.id, "0.24.0"));
    expect(r).toMatchObject({
      id: a.id,
      from: "0.23.0",
      to: "0.24.0",
      ok: false,
      rolledBack: true,
    });
    expect(r.reason).toMatch(/healthz/);
    expect(modulesText(s, a.id)).toContain("0.23.0");
    expect(s.scriptOf(a.id)?.metadata.tags).toEqual([a.id, "v0.23.0"]);
    expect(s.row(a.id)).toMatchObject({
      state: "active",
      version: "0.23.0",
      previous_version: "0.24.0",
      do_migration_tag: BASE_TAG,
    });
    expect(s.audit(a.id)).toEqual(
      expect.arrayContaining(["upgrade.failed", "rollback.done"]),
    );
    expect(s.scriptOf(b.id)?.uploads).toBe(bUploads);
    expect(s.row(b.id)).toMatchObject({ version: "0.23.0", state: "active" });
  });

  it("H-DR: upgrade and rollback keep the broker and directory registry entries equal", async () => {
    const s = setup();
    const p = s.mk({ brokerEnabled: true });
    const inst = keep(await p.create(input()));
    const raw = s.fake.kvValues(s.regId).get(registryKey(inst.id)) as string;
    expect(raw).toBeTruthy();
    const up = keep(
      await s.mk({ brokerEnabled: true }).upgrade(inst.id, "0.24.0"),
    );
    expect(up).toMatchObject({ ok: true });
    expect(s.fake.kvValues(s.regId).get(registryKey(inst.id))).toBe(raw);
    expect(s.fake.kvValues(s.dirId).get(registryKey(inst.id))).toBe(raw);
    keep(await s.mk({ brokerEnabled: true }).rollback(inst.id));
    expect(s.fake.kvValues(s.dirId).get(registryKey(inst.id))).toBe(
      s.fake.kvValues(s.regId).get(registryKey(inst.id)),
    );
    expect((await s.p.status(inst.id)).registryDrift).toBeNull();
  });

  it("upgrade to an older version, or to the installed one, is refused before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    const older = await fails(s.p.upgrade(inst.id, "0.22.0"));
    expect(older).toBeInstanceOf(ProvisionRefused);
    expect(older.message).toMatch(/downgrade/);
    const same = await fails(s.p.upgrade(inst.id, "0.23.0"));
    expect(same.message).toMatch(/already at 0\.23\.0/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("an upgrade whose release adds a DO class and first uses it in the same version is refused", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    const e = await fails(s.p.upgrade(inst.id, "0.26.0"));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/Ledger/);
    expect(e.message).toMatch(/one release before/);
    expect(s.fake.writes().length).toBe(w);
    // The same class, added unbound one release earlier, is fine.
    const r = keep(await s.p.upgrade(inst.id, "0.25.0"));
    expect(r.ok).toBe(true);
    expect(s.row(inst.id).do_migration_tag).toBe(LEDGER_TAG);
  });

  it("sends migrations only when the target tag differs from the live one", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const from = s.fake.log.length;
    await s.p.upgrade(inst.id, "0.25.0");
    const meta = metaOf(uploads(s.fake, from)[0]?.body as string);
    expect(meta.migrations).toEqual({
      old_tag: BASE_TAG,
      new_tag: LEDGER_TAG,
      steps: [{ new_sqlite_classes: ["Ledger"] }],
    });
    expect(s.scriptOf(inst.id)?.migrationTag).toBe(LEDGER_TAG);
    expect(s.stored(inst.id, "0.25.0")?.do_migration_tag).toBe(LEDGER_TAG);
  });

  it("a release below the floor's minVersion, or revoked, is refused on upgrade", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    s.rel.st.floor = signFloor("staging", { seq: 2, minVersion: "0.25.0" });
    const low = await fails(s.p.upgrade(inst.id, "0.24.0"));
    expect(low.message).toMatch(/below the release floor/);
    s.rel.st.floor = signFloor("staging", { seq: 2, revoked: ["0.24.0"] });
    const rev = await fails(s.p.upgrade(inst.id, "0.24.0"));
    expect(rev.message).toMatch(/revoked/);
    expect(s.fake.writes().length).toBe(w);
  });

  it("upgrade runs checkFloorSeq: a floor below the env's cached seq is refused, a higher one raises it", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.db().prepare("UPDATE release_floor SET floor_seq = 5").run();
    const e = await fails(s.p.upgrade(inst.id, "0.24.0"));
    expect(e.message).toMatch(/below 5/);
    s.rel.st.floor = signFloor("staging", { seq: 7 });
    await s.p.upgrade(inst.id, "0.24.0");
    expect(s.db().prepare("SELECT floor_seq FROM release_floor").get()).toEqual(
      { floor_seq: 7 },
    );
  });

  it("a test-hook install gets only redline and a release install only release", async () => {
    const s = setup();
    const red = keep(
      await s.p.create(
        input("redqa", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
      ),
    );
    const rel = keep(await s.p.create(input("plain")));
    s.rel.st.records.length = 0;
    expect((await s.p.upgrade(red.id, "0.24.0")).ok).toBe(true);
    expect(new Set(s.rel.st.records.map((x) => x.variant))).toEqual(
      new Set(["redline"]),
    );
    expect(modulesText(s, red.id)).toContain("hooksAllowed = true");
    s.rel.st.records.length = 0;
    expect((await s.p.upgrade(rel.id, "0.24.0")).ok).toBe(true);
    expect(new Set(s.rel.st.records.map((x) => x.variant))).toEqual(
      new Set(["release"]),
    );
    expect(modulesText(s, rel.id)).toContain("hooksAllowed = false");
  });

  it("every operation keeps ProdLocked", async () => {
    const s = setup({ env: "prod" });
    const inst = keep(await s.p.create(input()));
    await withGate(false, async () => {
      for (const op of [
        () => s.p.upgrade(inst.id, "0.24.0"),
        () => s.p.rollback(inst.id),
        () => s.p.updateVars(inst.id, {}),
        () => s.p.rotateTurnstileSecret("prod"),
        () => s.p.delete(inst.id, inst.id),
      ])
        expect(await fails(op())).toBeInstanceOf(ProdLocked);
    });
    expect(s.row(inst.id).state).toBe("active");
  });
});

async function withGate(v: boolean, fn: () => Promise<void>) {
  const before = G.PROD_UNLOCKED;
  G.PROD_UNLOCKED = v;
  try {
    await fn();
  } finally {
    G.PROD_UNLOCKED = before;
  }
}

describe("rollback", () => {
  it("rollback with no previous version is a clear error, not a re-upload", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/no previous version/);
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("rollback across a Durable Object migration tag is refused, and a failed upgrade across one reports forward-fix instead of rolling back", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    unhealthyAt(s, "0.25.0");
    const r = keep(await s.p.upgrade(inst.id, "0.25.0"));
    expect(r).toMatchObject({
      ok: false,
      rolledBack: false,
      forwardFix: true,
    });
    expect(r.reason).toMatch(/healthz/);
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.25.0",
      previous_version: "0.23.0",
      do_migration_tag: LEDGER_TAG,
    });
    expect(s.audit(inst.id)).toContain("upgrade.forward_fix");
    s.fake.health = undefined;
    const from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/forward-fix only/);
    expect(uploads(s.fake, from)).toHaveLength(0);
  });

  it("rollback uploads exactly the stored metadata of the previous version", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    await s.p.upgrade(inst.id, "0.24.0");
    const stored = JSON.parse(s.stored(inst.id, "0.23.0")?.metadata as string);
    const from = s.fake.log.length;
    const r = keep(await s.p.rollback(inst.id));
    expect(r).toEqual({
      id: inst.id,
      from: "0.24.0",
      to: "0.23.0",
      ok: true,
      rolledBack: true,
    });
    const up = uploads(s.fake, from);
    expect(up).toHaveLength(1);
    const sent = metaOf(up[0]?.body as string);
    const { jwt, ...assets } = sent.assets;
    expect(typeof jwt).toBe("string");
    // N4: the email is not stored; it is re-injected from installs.owner_email.
    const email = sent.bindings.find(
      (b: { name: string }) => b.name === "OWNER_EMAIL",
    );
    expect(email?.text).toBe(OWNER);
    expect(
      stored.bindings.some((b: { name: string }) => b.name === "OWNER_EMAIL"),
    ).toBe(false);
    expect({
      ...sent,
      assets,
      bindings: sent.bindings.filter(
        (b: { name: string }) => b.name !== "OWNER_EMAIL",
      ),
    }).toEqual(stored);
    // The previous release's verified bytes, and no D1 rollback.
    expect(modulesText(s, inst.id)).toContain("0.23.0");
    expect(
      s
        .installDb(inst.id)
        .prepare("SELECT name FROM d1_migrations WHERE name = ?")
        .get(NEW_MIGRATION.name),
    ).toBeDefined();
    expect(
      s.fake.raw
        .slice(from)
        .some((x) => /DROP|DELETE FROM d1_migrations/i.test(x.body)),
    ).toBe(false);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.23.0",
      previous_version: "0.24.0",
      state: "active",
    });
  });

  it("rollback refuses an asset changed between plan and apply before any probe or upload", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    const good = s.rel.reader.assetBytes;
    let reads = 0;
    // The plan's pre-flight read is good; the apply's read is not.
    s.rel.reader.assetBytes = async (version, variant, path) =>
      path === "app.js" && ++reads >= 2
        ? enc("console.log(2)")
        : good(version, variant, path);
    const from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/assets do not match the signed record/);
    expect(reads).toBe(2);
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(probes(s.fake, from)).toHaveLength(0);
    expect(s.audit(inst.id)).not.toContain("rollback.incomplete");
  });

  it("rollback refuses a previous version below the floor or revoked", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    const from = s.fake.log.length;
    s.rel.st.floor = signFloor("staging", { seq: 2, revoked: ["0.23.0"] });
    expect((await fails(s.p.rollback(inst.id))).message).toMatch(/revoked/);
    s.rel.st.floor = signFloor("staging", { seq: 3, minVersion: "0.24.0" });
    expect((await fails(s.p.rollback(inst.id))).message).toMatch(
      /below the release floor/,
    );
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.24.0",
      state: "active",
    });
  });

  it("a failed upgrade whose previous version is revoked stays on the new version and reports forward-fix", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.rel.st.floor = signFloor("staging", { seq: 2, revoked: ["0.23.0"] });
    unhealthyAt(s, "0.24.0");
    const r = keep(await s.p.upgrade(inst.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: false, forwardFix: true });
    expect(r.reason).toMatch(/revoked/);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.24.0",
      state: "active",
    });
  });
});

describe("fix round 1: rollback keeps the current vars", () => {
  it("a var change after an upgrade survives a rollback, with no epoch bump", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    await s.p.upgrade(inst.id, "0.24.0");
    const next = {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
      EMAIL_DAILY_CAP: "50",
    };
    await s.p.updateVars(inst.id, next);
    const epoch = () =>
      (
        s
          .installDb(inst.id)
          .prepare("SELECT session_epoch FROM users WHERE email = ?")
          .get(OWNER) as { session_epoch: number }
      ).session_epoch;
    expect(epoch()).toBe(1);
    const stored = JSON.parse(s.stored(inst.id, "0.23.0")?.metadata as string);
    const from = s.fake.log.length;
    const r = keep(await s.p.rollback(inst.id));
    expect(r).toMatchObject({ ok: true, rolledBack: true, to: "0.23.0" });
    const meta = metaOf(uploads(s.fake, from)[0]?.body as string);
    const plain = (n: string) =>
      meta.bindings.find((b: { name: string }) => b.name === n)?.text;
    expect(plain("AUTH_PROVIDERS")).toBe("email,google");
    expect(plain("EMAIL_DAILY_CAP")).toBe("50");
    expect(modulesText(s, inst.id)).toContain("0.23.0");
    // Everything not rendered from vars is the previous version's metadata.
    const notVars = (m: typeof meta) => ({
      ...m,
      assets: { config: m.assets.config },
      bindings: m.bindings.filter(
        (b: { name: string }) =>
          ![
            "AUTH_PROVIDERS",
            "AUTH_DOMAINS",
            "EMAIL_DAILY_CAP",
            "OWNER_EMAIL",
          ].includes(b.name),
      ),
    });
    expect(notVars(meta)).toEqual(notVars(stored));
    expect(JSON.parse(s.row(inst.id).vars)).toEqual(next);
    expect(epoch()).toBe(1);
    expect(
      s.fake.raw.slice(from).some((x) => x.body.includes(epochBumpSql())),
    ).toBe(false);
  });

  it("current vars that do not validate against the previous version refuse the rollback, before any write", async () => {
    const s = setup();
    const inst = keep(
      await s.p.create(input("finqore", { version: "0.21.0" })),
    );
    await s.p.upgrade(inst.id, "0.24.0");
    await s.p.updateVars(inst.id, { AUTH_DOMAINS: "finqore.test" });
    const w = s.fake.writes().length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/current vars do not fit 0\.21\.0/);
    expect(e.message).toMatch(/duplicate binding name "AUTH_DOMAINS"/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.24.0",
      state: "active",
      lease: null,
    });
  });

  it("current vars whose conditions fail (codes on, no Turnstile pair) refuse the rollback", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    await s.p.upgrade(inst.id, "0.24.0");
    const e = await fails(s.mk({ turnstile: undefined }).rollback(inst.id));
    expect(e.message).toMatch(/Turnstile sitekey and secret are missing/);
    expect(s.row(inst.id).version).toBe("0.24.0");
  });
});

describe("fix round 1: releaseLease", () => {
  const hold = (s: S, id: string, until: number) =>
    s
      .db()
      .prepare(
        "UPDATE installs SET state = 'upgrading', lease = 'dead', lease_until = ? WHERE id = ?",
      )
      .run(until, id);

  it("needs confirm === id", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    hold(s, inst.id, NOW - 1);
    const n = s.fake.log.length;
    expect((await fails(s.p.releaseLease(inst.id, "nope"))).message).toMatch(
      /confirm/,
    );
    expect(s.fake.log.length).toBe(n);
    expect(s.row(inst.id).lease).toBe("dead");
  });

  it("a held, unexpired lease is refused without force; with force it is released and audited", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    hold(s, inst.id, s.clock.now() + 60_000);
    const e = await fails(s.p.releaseLease(inst.id, inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/has not expired.*force/);
    expect(s.row(inst.id)).toMatchObject({ lease: "dead", state: "upgrading" });
    expect(s.audit(inst.id)).toContain("lease.release_refused");
    const r = keep(await s.p.releaseLease(inst.id, inst.id, { force: true }));
    expect(r).toEqual({
      id: inst.id,
      released: true,
      forced: true,
      state: "active",
    });
    expect(s.row(inst.id)).toMatchObject({
      lease: null,
      lease_until: null,
      state: "active",
    });
    expect(s.audit(inst.id)).toContain("lease.force_release");
    // The install works again.
    expect((await s.p.upgrade(inst.id, "0.24.0")).ok).toBe(true);
  });

  it("an expired lease is released without force (a deleting row stays deleting)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    hold(s, inst.id, s.clock.now() - 1);
    const r = keep(await s.p.releaseLease(inst.id, inst.id));
    expect(r).toEqual({
      id: inst.id,
      released: true,
      forced: false,
      state: "active",
    });
    expect(s.audit(inst.id)).toContain("lease.release");
    s.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', lease = 'dead', lease_until = ? WHERE id = ?",
      )
      .run(s.clock.now() - 1, inst.id);
    const d = keep(await s.p.releaseLease(inst.id, inst.id));
    expect(d.state).toBe("deleting");
    expect(s.row(inst.id)).toMatchObject({ state: "deleting", lease: null });
    // No lease at all: nothing to release.
    expect((await fails(s.p.releaseLease(inst.id, inst.id))).message).toMatch(
      /holds no lease/,
    );
  });
});

describe("concurrency", () => {
  it("a second concurrent upgrade or delete is refused (compare-and-swap on the row state)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const second: Error[] = [];
    let fired = false;
    const p2 = s.mk();
    const p1 = s.mk({
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        if (!fired && String(u).endsWith("/healthz")) {
          fired = true;
          second.push(await fails(p2.upgrade(inst.id, "0.24.0")));
          second.push(await fails(p2.delete(inst.id, inst.id)));
          second.push(await fails(p2.rollback(inst.id)));
          second.push(await fails(p2.updateVars(inst.id, {})));
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch,
    });
    const r = keep(await p1.upgrade(inst.id, "0.24.0"));
    expect(r.ok).toBe(true);
    expect(second).toHaveLength(4);
    for (const e of second) {
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(/upgrading|busy/);
    }
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("a second delete while one is running is refused; a delete left by a crash resumes once its lease is cleared", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const second: Error[] = [];
    let fired = false;
    const p2 = s.mk();
    const p1 = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        if (
          !fired &&
          req.method === "DELETE" &&
          /\/scripts\/oa-s-/.test(req.url)
        ) {
          fired = true;
          second.push(await fails(p2.delete(inst.id, inst.id)));
          second.push(await fails(p2.upgrade(inst.id, "0.24.0")));
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    keep(await p1.delete(inst.id, inst.id));
    expect(second).toHaveLength(2);
    for (const e of second) expect(e).toBeInstanceOf(ProvisionRefused);
    expect(second[0]?.message).toMatch(/busy/);
    expect((second[0] as ProvisionRefused).code).toBe("lease_held");
    expect(s.row(inst.id).state).toBe("deleted");
  });
});

describe("updateVars and the session cut", () => {
  it("re-validates vars exactly as create does", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    expect(
      (await fails(s.p.updateVars(inst.id, { NOPE: "1" }))).message,
    ).toMatch(/unknown var/);
    expect(
      (
        await fails(
          s.p.updateVars(inst.id, {
            AUTH_PROVIDERS: "email,google",
            EMAIL_CODE_DOMAIN: "on",
            AUTH_DOMAINS: "finqore.test",
          }),
        )
      ).message,
    ).toMatch(/google out of AUTH_PROVIDERS/);
    expect(
      (
        await fails(
          s.p.updateVars(inst.id, {
            AUTH_PROVIDERS: "email",
            EMAIL_CODE_DOMAIN: "on",
          }),
        )
      ).message,
    ).toMatch(/needs AUTH_DOMAINS/);
    const noTs = s.mk({ turnstile: undefined });
    expect((await fails(noTs.updateVars(inst.id, CODES))).message).toMatch(
      /Turnstile sitekey and secret are missing/,
    );
    expect(
      (await fails(s.p.updateVars(inst.id, { TEST_DOMAIN: "x.test" }))).message,
    ).toMatch(/TEST_DOMAIN/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  describe("H-RD: the registry copies follow AUTH_DOMAINS and google on/off", () => {
    const entries = (s: S, id: string) => {
      const reg = s.fake.kvValues(s.regId).get(registryKey(id)) as string;
      const dir = s.fake.kvValues(s.dirId).get(registryKey(id)) as string;
      return { reg, dir, entry: JSON.parse(reg) };
    };
    const brokered = async () => {
      const s = setup();
      const p = s.mk({ brokerEnabled: true });
      const inst = keep(
        await p.create(
          input("finqore", { vars: { AUTH_DOMAINS: "a.example" } }),
        ),
      );
      return { s, p, inst };
    };

    it("updateVars rewrites both copies with the new domains, same keys, in the op's lease", async () => {
      const { s, p, inst } = await brokered();
      const keys = entries(s, inst.id).entry.keys;
      const r = await p.updateVars(inst.id, {
        AUTH_DOMAINS: "c.example,B.example",
      });
      expect(r).toMatchObject({ ok: true });
      const { reg, dir, entry } = entries(s, inst.id);
      expect(entry.domains).toEqual(["b.example", "c.example"]);
      expect(entry.keys).toEqual(keys);
      expect(dir).toBe(reg);
      expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
      expect((await p.status(inst.id)).registryDrift).toBeNull();
    });

    it("google on, then off: both copies follow the domains each time", async () => {
      const { s, p, inst } = await brokered();
      await p.updateVars(inst.id, {
        AUTH_PROVIDERS: "email,google",
        AUTH_DOMAINS: "g.example",
      });
      let e = entries(s, inst.id);
      expect(e.entry.domains).toEqual(["g.example"]);
      expect(e.dir).toBe(e.reg);
      await p.updateVars(inst.id, { AUTH_PROVIDERS: "email" });
      e = entries(s, inst.id);
      expect(e.entry.domains).toEqual([]);
      expect(e.dir).toBe(e.reg);
    });

    it("updateVars refuses more than 50 domains before any write", async () => {
      const { s, p, inst } = await brokered();
      const w = s.fake.writes().length;
      const e = await fails(
        p.updateVars(inst.id, {
          AUTH_DOMAINS: Array.from(
            { length: 51 },
            (_, i) => `d${i}.example`,
          ).join(","),
        }),
      );
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(/more than 50 domains/);
      expect(s.fake.writes().length).toBe(w);
    });

    it("a failed directory write in updateVars is reported, and a rerun makes both equal", async () => {
      const { s, p, inst } = await brokered();
      s.fake.inject(
        (m, q) => m === "PUT" && q.includes(`/namespaces/${s.dirId}/values/`),
        { status: 400 },
      );
      const next = { AUTH_DOMAINS: "n.example" };
      const r = await p.updateVars(inst.id, next);
      expect(r).toMatchObject({ ok: false });
      expect((await p.status(inst.id)).registryDrift).toEqual({
        id: inst.id,
        kind: "mismatch",
      });
      expect(await p.updateVars(inst.id, next)).toMatchObject({ ok: true });
      const e = entries(s, inst.id);
      expect(e.entry.domains).toEqual(["n.example"]);
      expect(e.dir).toBe(e.reg);
    });

    it("upgrade and rollback never refuse on the registry domain check (they never write the registry)", async () => {
      const { s, p, inst } = await brokered();
      const before = entries(s, inst.id).reg;
      // Passes HOSTED_VARS, fails the registry check (more than 50).
      const bad = {
        AUTH_DOMAINS: Array.from(
          { length: 51 },
          (_, i) => `d${i}.example`,
        ).join(","),
      };
      s.db()
        .prepare("UPDATE installs SET vars = ? WHERE id = ?")
        .run(canonicalJson(bad), inst.id);
      expect(keep(await p.upgrade(inst.id, "0.24.0"))).toMatchObject({
        ok: true,
      });
      expect(keep(await p.rollback(inst.id))).toMatchObject({
        ok: true,
        rolledBack: true,
      });
      expect(entries(s, inst.id).reg).toBe(before);
      expect(entries(s, inst.id).dir).toBe(before);
      // updateVars does write the registry, so it still refuses.
      expect((await fails(p.updateVars(inst.id, bad))).message).toMatch(
        /more than 50 domains/,
      );
    });

    it("upgrade and rollback keep the domains (they reuse the current vars)", async () => {
      const { s, p, inst } = await brokered();
      const before = entries(s, inst.id).reg;
      keep(await p.upgrade(inst.id, "0.24.0"));
      keep(await p.rollback(inst.id));
      const e = entries(s, inst.id);
      expect(e.reg).toBe(before);
      expect(e.dir).toBe(before);
    });
  });

  it("turning google on bumps the epoch in the install's own D1 after the new vars are live, once per enablement", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const idb = s.installDb(inst.id);
    const epoch = () =>
      (
        idb
          .prepare("SELECT session_epoch FROM users WHERE email = ?")
          .get(OWNER) as { session_epoch: number }
      ).session_epoch;
    expect(epoch()).toBe(0);
    const next = {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    };
    const from = s.fake.log.length;
    keep(await s.p.updateVars(inst.id, next));
    expect(epoch()).toBe(1);
    // Ordering (M1): the bump runs as soon as the upload is accepted, before /healthz.
    const d1 = s.row(inst.id).d1_id as string;
    const bump = s.fake.raw
      .map((x, i) => ({ x, i }))
      .slice(from)
      .filter(
        ({ x }) =>
          x.path.includes(`/d1/database/${d1}/`) &&
          x.body.includes(epochBumpSql()),
      )
      .map(({ i }) => i);
    expect(bump).toHaveLength(1);
    const up = uploads(s.fake, from).map((x) => x.i);
    const health = callsTo(s.fake, /GET .*\/healthz$/, from);
    expect(up).toHaveLength(1);
    expect(up[0]).toBeLessThan(bump[0] as number);
    const after = health.filter((h) => h > (up[0] as number));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((h) => h > (bump[0] as number))).toBe(true);
    const plain = metaOf(
      uploads(s.fake, from)[0]?.body as string,
    ).bindings.find((b: { name: string }) => b.name === "AUTH_PROVIDERS");
    expect(plain.text).toBe("email,google");
    expect(s.audit(inst.id)).toContain("vars.session_cut");
    expect(JSON.parse(s.stored(inst.id, "0.23.0")?.vars as string)).toEqual(
      next,
    );
    // A rerun with google already on does not bump again.
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(1);
    // A crash after the bump but before the platform cleared its marker:
    // the rerun finds the marker in the install's D1 and does not bump twice.
    const cut = (
      idb.prepare("SELECT id FROM oa_session_cuts").get() as { id: string }
    ).id;
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ? WHERE id = ?",
      )
      .run(cut, canonicalJson(CODES), inst.id);
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(1);
    expect(s.row(inst.id).session_cut).toBeNull();
    // Off, then on again: a second enablement, a second bump.
    await s.p.updateVars(inst.id, CODES);
    expect(epoch()).toBe(1);
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(2);
  });

  it("M1: a failed check after the upload still bumps (the vars are live), audited, and a rerun does not bump again", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    const next = {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    };
    s.fake.health = () => ({ ok: false });
    const r = keep(await s.p.updateVars(inst.id, next));
    expect(r).toMatchObject({ ok: false, sessionCut: true });
    expect(r.reason).toMatch(/healthz/);
    expect(epoch()).toBe(1);
    expect(s.audit(inst.id)).toEqual(
      expect.arrayContaining(["vars.session_cut", "vars.failed"]),
    );
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      lease: null,
      session_cut: null,
    });
    s.fake.health = undefined;
    expect((await s.p.updateVars(inst.id, next)).ok).toBe(true);
    expect(epoch()).toBe(1);
  });

  it("M1: a var change that fails before the upload keeps the cut pending with its base; the rerun bumps exactly once", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    const next = {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    };
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-/.test(p));
    await fails(s.p.updateVars(inst.id, next));
    expect(epoch()).toBe(0);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
    expect(s.row(inst.id).session_cut).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(s.row(inst.id).session_cut_base)).toEqual(CODES);
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(1);
    expect(s.row(inst.id).session_cut).toBeNull();
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(1);
  });

  it("L10: a cut from an abandoned enable is dropped, not run, when the live vars do not have google newly on", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-/.test(p));
    await fails(
      s.p.updateVars(inst.id, {
        AUTH_PROVIDERS: "email,google",
        AUTH_DOMAINS: "finqore.test",
      }),
    );
    expect(s.row(inst.id).session_cut).not.toBeNull();
    const r = keep(
      await s.p.updateVars(inst.id, { ...CODES, FEATURES: "beta" }),
    );
    expect(r).toMatchObject({ ok: true, sessionCut: false });
    expect(epoch()).toBe(0);
    expect(s.row(inst.id).session_cut).toBeNull();
    expect(s.audit(inst.id)).toContain("vars.session_cut_dropped");
  });

  it("M1: the next upgrade applies a pending cut right after its upload; rotation refuses while one is pending", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    const next = {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    };
    await s.p.updateVars(inst.id, next);
    expect(epoch()).toBe(1);
    // A cut owed for vars that are live (a crash after the upload).
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ? WHERE id = ?",
      )
      .run("ab".repeat(16), canonicalJson(CODES), inst.id);
    const rot = keep(await s.p.rotateTurnstileSecret("staging"));
    expect(rot[0]).toMatchObject({ ok: false });
    expect(rot[0]?.reason).toMatch(/pending session cut: re-run updateVars/);
    const from = s.fake.log.length;
    expect((await s.p.upgrade(inst.id, "0.24.0")).ok).toBe(true);
    expect(epoch()).toBe(2);
    expect(s.row(inst.id).session_cut).toBeNull();
    const up = uploads(s.fake, from).map((x) => x.i);
    const bump = s.fake.raw.findIndex(
      (x, i) => i >= from && x.body.includes(epochBumpSql()),
    );
    expect(bump).toBeGreaterThan(up[0] as number);
  });

  it("N1: a non-object is refused before anything", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const n = s.fake.writes().length;
    for (const v of [null, undefined, [], "x"])
      expect(await fails(s.p.updateVars(inst.id, v as never))).toBeInstanceOf(
        ProvisionRefused,
      );
    expect(s.fake.writes().length).toBe(n);
  });

  it("codes newly on sends only TURNSTILE_SECRET, with keep_bindings", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const from = s.fake.log.length;
    await s.p.updateVars(inst.id, CODES);
    const meta = metaOf(uploads(s.fake, from)[0]?.body as string);
    expect(
      meta.bindings
        .filter((b: { type: string }) => b.type === "secret_text")
        .map((b: { name: string }) => b.name),
    ).toEqual(["TURNSTILE_SECRET"]);
    expect(meta.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(s.scriptOf(inst.id)?.secrets.get("TURNSTILE_SECRET")).toBe(
      TS.secret,
    );
  });
});

describe("rotateTurnstileSecret", () => {
  it("re-uploads TURNSTILE_SECRET to every active codes-on install of the env and reports per install", async () => {
    const s = setup();
    const a = keep(await s.p.create(input("alpha", { vars: CODES })));
    const b = keep(await s.p.create(input("beta", { vars: CODES })));
    const off = keep(await s.p.create(input("gamma")));
    const c = keep(await s.p.create(input("delta", { vars: CODES })));
    s.db()
      .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
      .run(c.id);
    const p = s.mk({ turnstile: { sitekey: TS.sitekey, secret: TS_NEXT } });
    const out = keep(await p.rotateTurnstileSecret("staging"));
    const byId = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(byId[a.id]).toMatchObject({ ok: true, rotated: true });
    expect(byId[b.id]).toMatchObject({ ok: true, rotated: true });
    expect(byId[off.id]).toMatchObject({ ok: true, rotated: false });
    expect(byId[c.id]?.ok).toBe(false);
    expect(byId[c.id]?.reason).toMatch(/upgrading/);
    expect(s.scriptOf(a.id)?.secrets.get("TURNSTILE_SECRET")).toBe(TS_NEXT);
    expect(s.scriptOf(b.id)?.secrets.get("TURNSTILE_SECRET")).toBe(TS_NEXT);
    expect(s.scriptOf(off.id)?.secrets.has("TURNSTILE_SECRET")).toBe(false);
    expect(s.scriptOf(c.id)?.secrets.get("TURNSTILE_SECRET")).toBe(TS.secret);
    expect(s.audit(a.id)).toContain("turnstile.rotate");
    expect(JSON.stringify(out)).not.toContain(TS_NEXT);
    expect(JSON.stringify(p.notes)).not.toContain(TS_NEXT);
    expect(
      JSON.stringify(s.db().prepare("SELECT * FROM hosted_audit").all()),
    ).not.toContain(TS_NEXT);
    expect(s.row(a.id).lease).toBeNull();
  });

  it("refuses another env", async () => {
    const s = setup();
    expect(
      await fails(s.p.rotateTurnstileSecret("prod" as Env)),
    ).toBeInstanceOf(ProvisionRefused);
  });
});

describe("delete", () => {
  it("delete requires confirm === id and unmaps hosts before anything else", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.log.length;
    for (const bad of ["", "finqore", `${inst.id} `, inst.id.toUpperCase()])
      expect((await fails(s.p.delete(inst.id, bad))).message).toMatch(
        /confirm/,
      );
    expect(s.fake.log.length).toBe(w);
    // Objects in the install's bucket, more than one list page.
    const bucket = `oa-s-${inst.id}`;
    for (let k = 0; k < 5; k++) s.fake.r2Seed(bucket, `files/${k}`, enc("x"));
    s.fake.r2PerPage = 2;
    const from = s.fake.log.length;
    const r = keep(await s.p.delete(inst.id, inst.id));
    expect(r).toEqual({ id: inst.id, ok: true, state: "deleted" });
    const order = s.fake.log
      .slice(from)
      .filter((e) => e.method === "DELETE")
      .map((e) => e.path);
    const hostsDel = order.findIndex((p) =>
      p.includes(`/storage/kv/namespaces/${s.hostsId}/values/`),
    );
    expect(hostsDel).toBe(0);
    expect(order[1]).toContain(`/storage/kv/namespaces/${s.hostsId}/values/`);
    // The platform hosts rows go before any resource delete too.
    const hostsRows = s.fake.raw
      .map((x, i) => ({ x, i }))
      .slice(from)
      .find(({ x }) => x.body.includes("DELETE FROM hosts"))?.i as number;
    const firstResource = s.fake.log.findIndex(
      (e, i) =>
        i >= from &&
        e.method === "DELETE" &&
        !e.path.includes(`/storage/kv/namespaces/${s.hostsId}/values/`),
    );
    expect(hostsRows).toBeLessThan(firstResource);
    const seq = order
      .slice(2)
      .map((p) =>
        p.includes(`/namespaces/${s.regId}/values/`)
          ? "registry"
          : p.includes(`/namespaces/${s.dirId}/values/`)
            ? "directory"
            : /\/scripts\//.test(p)
              ? "script"
              : /\/storage\/kv\/namespaces\/[^/]+$/.test(p)
                ? "kv"
                : /\/r2\/buckets\/[^/]+\/objects\//.test(p)
                  ? "r2-object"
                  : /\/r2\/buckets\/[^/]+$/.test(p)
                    ? "r2"
                    : /\/d1\/database\/[^/]+$/.test(p)
                      ? "d1"
                      : p,
      );
    expect(seq).toEqual([
      "directory",
      "registry",
      "script",
      "kv",
      ...Array(5).fill("r2-object"),
      "r2",
      "d1",
    ]);
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
    expect(s.scriptOf(inst.id)).toBeUndefined();
    expect(s.fake.r2.has(bucket)).toBe(false);
    expect([...s.fake.d1.values()].some((d) => d.name === bucket)).toBe(false);
    expect(
      [...s.fake.kv.values()].some((k) => k.title === `${bucket}-oauth`),
    ).toBe(false);
    // The row stays, terminal, and keeps the slug held.
    expect(s.row(inst.id)).toMatchObject({ state: "deleted", lease: null });
    expect(
      s.db().prepare("SELECT * FROM hosts WHERE install_id = ?").all(inst.id),
    ).toEqual([]);
    expect(s.audit(inst.id)).toEqual(
      expect.arrayContaining(["delete.start", "delete.done"]),
    );
    const again = await fails(s.p.create(input()));
    expect(again.message).toMatch(/deleted|taken/);
  });

  it("delete is idempotent after a partial failure at any step", async () => {
    const steps: [string, (m: string, p: string) => boolean][] = [
      ["hosts", (m, p) => m === "DELETE" && p.includes("/values/")],
      ["script", (m, p) => m === "DELETE" && /\/scripts\/oa-s-/.test(p)],
      [
        "kv",
        (m, p) => m === "DELETE" && /\/storage\/kv\/namespaces\/[^/]+$/.test(p),
      ],
      ["r2-object", (m, p) => m === "DELETE" && /\/objects\//.test(p)],
      ["r2", (m, p) => m === "DELETE" && /\/r2\/buckets\/[^/]+$/.test(p)],
      ["d1", (m, p) => m === "DELETE" && /\/d1\/database\/[^/]+$/.test(p)],
    ];
    for (const [name, when] of steps) {
      const s = setup();
      const inst = keep(await s.p.create(input()));
      s.fake.r2Seed(`oa-s-${inst.id}`, "files/a", enc("x"));
      s.fake.inject(when, { status: 400, message: `boom ${name}` });
      const e = await fails(s.p.delete(inst.id, inst.id));
      expect(e.message, name).toMatch(/boom/);
      expect(s.row(inst.id), name).toMatchObject({
        state: "deleting",
        lease: null,
      });
      const r = keep(await s.p.delete(inst.id, inst.id));
      expect(r, name).toEqual({ id: inst.id, ok: true, state: "deleted" });
      expect(s.fake.kvValues(s.hostsId).size, name).toBe(0);
      expect(s.scriptOf(inst.id), name).toBeUndefined();
      expect(s.fake.r2.has(`oa-s-${inst.id}`), name).toBe(false);
      // A third call is a no-op.
      const n = s.fake.writes().length;
      const r3 = keep(await s.p.delete(inst.id, inst.id));
      expect(r3, name).toEqual({ id: inst.id, ok: true, state: "deleted" });
      expect(s.fake.writes().length, name).toBe(n);
    }
  });

  it("H-DR: delete removes the directory copy, then the broker entry, and resumes after a failure between them", async () => {
    const s = setup();
    const p = s.mk({ brokerEnabled: true });
    const inst = keep(await p.create(input()));
    const key = registryKey(inst.id);
    expect(s.fake.kvValues(s.regId).has(key)).toBe(true);
    expect(s.fake.kvValues(s.dirId).get(key)).toBe(
      s.fake.kvValues(s.regId).get(key),
    );
    s.fake.inject(
      (m, q) => m === "DELETE" && q.includes(`/namespaces/${s.regId}/values/`),
      { status: 400, message: "boom broker" },
    );
    const e = await fails(
      s.mk({ brokerEnabled: true }).delete(inst.id, inst.id),
    );
    expect(e.message).toMatch(/boom broker/);
    expect(s.row(inst.id)).toMatchObject({ state: "deleting", lease: null });
    // L1: the directory is never ahead of sign-in.
    expect(s.fake.kvValues(s.dirId).has(key)).toBe(false);
    expect(s.fake.kvValues(s.regId).has(key)).toBe(true);
    expect(await s.p.status(inst.id)).toMatchObject({
      registryDrift: { id: inst.id, kind: "missing_directory" },
    });
    const r = keep(
      await s.mk({ brokerEnabled: true }).delete(inst.id, inst.id),
    );
    expect(r).toEqual({ id: inst.id, ok: true, state: "deleted" });
    expect(s.fake.kvValues(s.regId).has(key)).toBe(false);
    expect(s.fake.kvValues(s.dirId).has(key)).toBe(false);
    expect((await s.p.status(inst.id)).registryDrift).toBeNull();
  });

  it("delete removes the registry entry under install:<id>, the key the broker reads", async () => {
    const s = setup();
    const inst = keep(await s.mk({ brokerEnabled: true }).create(input()));
    expect([...s.fake.kvValues(s.regId).keys()]).toEqual([
      registryKey(inst.id),
    ]);
    keep(await s.mk({ brokerEnabled: true }).delete(inst.id, inst.id));
    expect(s.fake.kvValues(s.regId).size).toBe(0);
  });

  it("refuses to delete anything whose name isn't names(id)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    // The row's kv_id points at the platform HOSTS namespace.
    s.db()
      .prepare("UPDATE installs SET kv_id = ? WHERE id = ?")
      .run(s.hostsId, inst.id);
    const w = s.fake.writes().length;
    const e = await fails(s.p.delete(inst.id, inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/refusing to touch another/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.fake.kvValues(s.hostsId).size).toBe(2);
    expect(s.row(inst.id).state).toBe("active");
    // An id that is not an install id never reaches Cloudflare.
    const n = s.fake.log.length;
    expect(await fails(s.p.delete("platform", "platform"))).toBeInstanceOf(
      ProvisionRefused,
    );
    expect(s.fake.log.length).toBe(n);
  });
});

function versionRows(): string {
  return FAKES.flatMap((f) =>
    [...f.d1.values()]
      .filter((d) => d.name.endsWith("platform"))
      .map((d) =>
        JSON.stringify(d.db.prepare("SELECT * FROM install_versions").all()),
      ),
  ).join("\n");
}

function haystacks(): { all: string; rows: string } {
  const parts = [...THROWN, ...PRINTABLE];
  const rows: string[] = [];
  for (const f of FAKES) {
    parts.push(JSON.stringify(f.log));
    for (const [, d] of f.d1) {
      if (!d.name.endsWith("platform")) continue;
      parts.push(
        JSON.stringify(d.db.prepare("SELECT * FROM hosted_audit").all()),
      );
      for (const t of ["installs", "hosts", "install_versions"])
        rows.push(JSON.stringify(d.db.prepare(`SELECT * FROM ${t}`).all()));
    }
  }
  for (const p of PROVS) parts.push(JSON.stringify(p.notes));
  return { all: parts.join("\n"), rows: rows.join("\n") };
}

const LEASE = 30 * 60_000;

describe("fix round 2", () => {
  it("H1/L9: two callers both pass pre-flight; exactly one wins the claim and the other is refused before any upload", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const p2 = s.mk();
    let hooked = false;
    let second: Awaited<ReturnType<WfpProvisioner["updateVars"]>> | undefined;
    const p1 = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        const body = req.method === "POST" ? await req.clone().text() : "";
        // p1's claim is about to run: p2 passes pre-flight, claims and finishes first.
        if (!hooked && body.includes("UPDATE installs SET state = ?1, lease")) {
          hooked = true;
          second = await p2.updateVars(inst.id, {
            ...CODES,
            AUTH_DOMAINS: "finqore.test",
          });
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    const from = s.fake.log.length;
    const e = await fails(p1.upgrade(inst.id, "0.24.0"));
    expect(hooked).toBe(true);
    expect(second?.ok).toBe(true);
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/changed since pre-flight/);
    // Only p2's one upload; p1 uploaded nothing and the install keeps p2's vars.
    expect(uploads(s.fake, from)).toHaveLength(1);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.23.0",
      state: "active",
      lease: null,
    });
    expect(JSON.parse(s.row(inst.id).vars).AUTH_DOMAINS).toBe("finqore.test");
    expect(s.row(inst.id).row_version).toBeGreaterThan(0);
  });

  it("M2: no lifecycle operation calls publish_artifact; the selftest is read-only against the recorded welcome artifact", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const from = s.fake.raw.length;
    await s.p.upgrade(inst.id, "0.24.0");
    await s.p.rollback(inst.id);
    await s.p.updateVars(inst.id, { ...CODES, FEATURES: "beta" });
    unhealthyAt(s, "0.24.0");
    await s.p.upgrade(inst.id, "0.24.0").catch(() => undefined);
    s.fake.health = undefined;
    expect(s.fake.artifacts.size).toBe(1);
    const mcp = s.fake.raw
      .slice(from)
      .filter((x) => x.path.endsWith("/mcp"))
      .map((x) => x.body);
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.some((b) => b.includes("publish_artifact"))).toBe(false);
    expect(mcp.some((b) => b.includes('"list_artifacts"'))).toBe(true);
    expect(mcp.some((b) => b.includes('"get_artifact"'))).toBe(false);
  });

  it("M2: a revoked owner PAT is refused in pre-flight with zero writes", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.installDb(inst.id).prepare("UPDATE tokens SET revoked_at = 1").run();
    const w = s.fake.writes().length;
    for (const op of [
      () => s.p.upgrade(inst.id, "0.24.0"),
      () => s.p.updateVars(inst.id, {}),
    ]) {
      const e = await fails(op());
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(/owner token .* was refused/);
    }
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("M3: a lease that expires mid-delete and is taken by a second claimant stops the first with 'lost the lease'", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const bucket = `oa-s-${inst.id}`;
    for (let k = 0; k < 3; k++) s.fake.r2Seed(bucket, `files/${k}`, enc("x"));
    s.fake.r2PerPage = 1;
    const p2 = s.mk();
    let second: unknown;
    let hooked = false;
    const p1 = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        if (
          !hooked &&
          req.method === "DELETE" &&
          req.url.includes("/objects/")
        ) {
          hooked = true;
          await s.clock.sleep(LEASE + 1);
          second = await p2.delete(inst.id, inst.id);
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    const e = await fails(p1.delete(inst.id, inst.id));
    expect(e.message).toMatch(/lost the lease/);
    expect(second).toEqual({ id: inst.id, ok: true, state: "deleted" });
    expect(s.row(inst.id)).toMatchObject({ state: "deleted", lease: null });
    expect(s.audit(inst.id)).toContain("delete.lost_lease");
  });

  it("M3: finish() that finds the lease gone is an error, audited, not a success", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const p1 = s.mk({
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(u).endsWith("/mcp") &&
          String(init?.body).includes("list_artifacts")
        )
          s.db()
            .prepare("UPDATE installs SET lease = 'other' WHERE id = ?")
            .run(inst.id);
        return s.fake.fetch(u, init);
      }) as typeof fetch,
    });
    const e = await fails(p1.updateVars(inst.id, { FEATURES: "beta" }));
    expect(e.message).toMatch(/lost the lease/);
    expect(s.audit(inst.id)).toContain("vars.lost_lease");
  });

  it("L1: the D1 actually deleted is resolved by id and must be names(id)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const d1 = s.row(inst.id).d1_id as string;
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        if (req.method === "GET" && req.url.endsWith(`/d1/database/${d1}`))
          return Response.json({
            success: true,
            errors: [],
            messages: [],
            result: { uuid: d1, name: "oa-s-platform" },
          });
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    const e = await fails(p.delete(inst.id, inst.id));
    expect(e.name).toBe("ForeignResource");
    expect(s.fake.d1.has(d1)).toBe(true);
    expect(s.row(inst.id).state).toBe("deleting");
  });

  it("L2: a creating install whose create ended can be deleted, unmapping first", async () => {
    const s = setup();
    s.fake.health = () => ({ ok: false });
    await fails(s.p.create(input()));
    s.fake.health = undefined;
    const id = (
      s.db().prepare("SELECT id FROM installs").get() as { id: string }
    ).id;
    expect(s.row(id)).toMatchObject({ state: "creating", lease: null });
    const from = s.fake.log.length;
    expect(await s.p.delete(id, id)).toEqual({
      id,
      ok: true,
      state: "deleted",
    });
    const dels = s.fake.log.slice(from).filter((e) => e.method === "DELETE");
    expect(dels[0]?.path).toContain(`/namespaces/${s.hostsId}/values/`);
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
  });

  it("L3: a rollback that would move forward is refused (use upgrade)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    unhealthyAt(s, "0.24.0");
    expect((await s.p.upgrade(inst.id, "0.24.0")).rolledBack).toBe(true);
    s.fake.health = undefined;
    const from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e.message).toMatch(/newer than 0\.23\.0; use upgrade/);
    expect(uploads(s.fake, from)).toHaveLength(0);
  });

  it("L4: an unapplied migration that sorts before an applied one is refused before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    const e = await fails(s.p.upgrade(inst.id, "0.27.0"));
    expect(e.message).toMatch(/0002_zz_out_of_order\.sql sorts before/);
    expect(s.fake.writes().length).toBe(w);
  });

  it("L5: the live tag is probed; a rollback whose live tag differs from the journal is refused, and an upgrade re-runs the DO rule on the live tag", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    const sc = s.scriptOf(inst.id);
    if (!sc) throw new Error("no script");
    sc.migrationTag = FOREIGN_TAG;
    let from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e.message).toMatch(
      new RegExp(`live Durable Object migration tag is ${FOREIGN_TAG}`),
    );
    expect(probes(s.fake, from)).toHaveLength(1);
    expect(uploads(s.fake, from)).toHaveLength(0);
    sc.migrationTag = "v9";
    from = s.fake.log.length;
    const u = await fails(s.p.upgrade(inst.id, "0.28.0"));
    expect(u.message).toMatch(/v9 is not in this release/);
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(s.row(inst.id)).toMatchObject({
      version: "0.24.0",
      state: "active",
      lease: null,
    });
  });

  it("L7: a failure after the upload gives a structured result and an audit row", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    let armed = true;
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        const body = req.method === "POST" ? await req.clone().text() : "";
        if (armed && body.includes("INSERT INTO install_versions")) {
          armed = false;
          return Response.json(
            { success: false, errors: [{ code: 7500, message: "boom" }] },
            { status: 400 },
          );
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    const r = keep(await p.upgrade(inst.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: false, forwardFix: true });
    expect(r.reason).toMatch(/boom/);
    expect(s.audit(inst.id)).toContain("upgrade.incomplete");
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("L8: delete removes the PAT and hook-key files", async () => {
    const s = setup();
    const inst = keep(
      await s.p.create(
        input("redqa", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
      ),
    );
    const dir = s.patDir;
    const files = [`${inst.appHost}-pat-token`, `${inst.appHost}-hook-key`];
    for (const f of files) expect(existsSync(join(dir, f))).toBe(true);
    await s.p.delete(inst.id, inst.id);
    for (const f of files) expect(existsSync(join(dir, f))).toBe(false);
  });

  it("N2: rotation reports a codes-off install that is not active as nothing to rotate", async () => {
    const s = setup();
    const off = keep(await s.p.create(input("gamma")));
    s.db()
      .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
      .run(off.id);
    const out = keep(await s.p.rotateTurnstileSecret("staging"));
    expect(out).toEqual([{ id: off.id, ok: true, rotated: false }]);
  });

  it("N3: rollback runs checkFloorSeq, and so does the auto-rollback", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    s.db().prepare("UPDATE release_floor SET floor_seq = 5").run();
    expect((await fails(s.p.rollback(inst.id))).message).toMatch(/below 5/);
    // Auto-rollback: the floor read for the rollback is below the cache the
    // upgrade raised, so it is refused and the upgrade reports forward-fix.
    const t = setup();
    const b = keep(await t.p.create(input()));
    t.rel.st.floor = signFloor("staging", { seq: 3 });
    t.fake.health = (sc) => {
      if ((sc.metadata.tags as string[]).includes("v0.24.0")) {
        t.rel.st.floor = signFloor("staging", { seq: 2 });
        return { ok: false };
      }
      return undefined;
    };
    const r = keep(await t.p.upgrade(b.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: false, forwardFix: true });
    expect(r.reason).toMatch(/below 3/);
  });

  it("N4: stored metadata holds no email", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    expect(s.stored(inst.id, "0.23.0")?.metadata).not.toContain(OWNER);
  });
});

describe("fix round 3", () => {
  /** A create that fails at /healthz leaves a creating row with its lease released. */
  const halfCreate = async (s: S) => {
    s.fake.health = () => ({ ok: false });
    await fails(s.p.create(input()));
    s.fake.health = undefined;
    return (s.db().prepare("SELECT id FROM installs").get() as { id: string })
      .id;
  };
  const hostsPuts = (s: S, from: number) =>
    s.fake.log
      .slice(from)
      .filter(
        (e) =>
          e.method === "PUT" &&
          e.path.includes(`/namespaces/${s.hostsId}/values/`),
      );
  const claimHook = (s: S, run: () => Promise<unknown>) =>
    (() => {
      let hooked = false;
      return (async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        const body = req.method === "POST" ? await req.clone().text() : "";
        if (!hooked && body.includes("UPDATE installs SET state = ?1, lease")) {
          hooked = true;
          await run();
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch;
    })();

  it("R-M1: a create resume racing a delete of the same row: the delete wins the claim, the resume does no HOSTS put and no state write", async () => {
    const s = setup();
    const id = await halfCreate(s);
    let del: unknown;
    const resumer = s.mk({
      cf: s.cfWith(
        claimHook(s, async () => {
          del = await s.mk().delete(id, id);
        }),
      ),
    });
    const from = s.fake.log.length;
    const e = await fails(resumer.create(input()));
    expect(del).toEqual({ id, ok: true, state: "deleted" });
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/is deleting|is deleted|another operation/);
    expect(hostsPuts(s, from)).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ state: "deleted", lease: null });
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
  });

  it("R-M1: ... and when the resume wins the claim, the delete is refused and the create completes", async () => {
    const s = setup();
    const id = await halfCreate(s);
    const errs: Error[] = [];
    const deleter = s.mk({
      cf: s.cfWith(
        claimHook(s, async () => {
          keep(await s.mk().create(input()));
        }),
      ),
    });
    errs.push(await fails(deleter.delete(id, id)));
    expect(errs[0]).toBeInstanceOf(ProvisionRefused);
    expect(s.row(id)).toMatchObject({ state: "active", lease: null });
    expect(s.fake.kvValues(s.hostsId).size).toBe(2);
  });

  it("R-M1: a delete of a creating row whose create lease is live is refused", async () => {
    const s = setup();
    const id = await halfCreate(s);
    s.db()
      .prepare("UPDATE installs SET lease = 'c', lease_until = ? WHERE id = ?")
      .run(s.clock.now() + 60_000, id);
    const held = await fails(s.p.delete(id, id));
    expect(held.message).toMatch(/create still holds the lease/);
    expect(held.code).toBe("lease_held");
    s.db()
      .prepare("UPDATE installs SET lease_until = ? WHERE id = ?")
      .run(s.clock.now() - 1, id);
    expect((await s.p.delete(id, id)).state).toBe("deleted");
  });

  it("R-M1: a create that loses its lease mid-way stops before HOSTS", async () => {
    const s = setup();
    let armed = true;
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const r = await s.fake.fetch(u, init);
        const req = new Request(u, init);
        if (
          armed &&
          req.method === "PUT" &&
          /\/scripts\/oa-s-[^/]+$/.test(req.url) &&
          r.status === 200
        ) {
          armed = false;
          s.db().prepare("UPDATE installs SET lease = 'other'").run();
        }
        return r;
      }) as typeof fetch),
    });
    const e = await fails(p.create(input()));
    expect(e.message).toMatch(/lost the lease/);
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
    expect(
      (s.db().prepare("SELECT state FROM installs").get() as { state: string })
        .state,
    ).toBe("creating");
    expect(
      s
        .db()
        .prepare("SELECT action FROM hosted_audit")
        .all()
        .map((r) => (r as { action: string }).action),
    ).toContain("create.lost_lease");
  });

  it("R-M2: an install whose owner deleted every artifact still passes the selftest", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.artifacts.clear();
    expect((await s.p.upgrade(inst.id, "0.24.0")).ok).toBe(true);
    expect((await s.p.updateVars(inst.id, { FEATURES: "beta" })).ok).toBe(true);
  });

  it("R-L1: a manual rollback on a refused PAT proceeds with /healthz only, noted and audited", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    s.installDb(inst.id).prepare("UPDATE tokens SET revoked_at = 1").run();
    const r = keep(await s.p.rollback(inst.id));
    expect(r).toMatchObject({ ok: true, rolledBack: true, to: "0.23.0" });
    expect(r.note).toMatch(/was refused .*selftest was skipped/);
    expect(s.audit(inst.id)).toContain("rollback.selftest_skipped");
    expect(modulesText(s, inst.id)).toContain("0.23.0");
  });

  it("R-L2: a transient bump failure keeps the cut pending, audited, and the upgrade goes on to health", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    await s.p.updateVars(inst.id, {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    });
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ? WHERE id = ?",
      )
      .run("cd".repeat(16), canonicalJson(CODES), inst.id);
    let armed = true;
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(u, init);
        const body = req.method === "POST" ? await req.clone().text() : "";
        if (armed && body.includes(epochBumpSql())) {
          armed = false;
          return Response.json(
            { success: false, errors: [{ code: 7500, message: "busy" }] },
            { status: 400 },
          );
        }
        return s.fake.fetch(u, init);
      }) as typeof fetch),
    });
    const from = s.fake.log.length;
    const r = keep(await p.upgrade(inst.id, "0.24.0"));
    expect(r.ok).toBe(true);
    expect(callsTo(s.fake, /GET .*\/healthz$/, from).length).toBeGreaterThan(0);
    expect(epoch()).toBe(1);
    expect(s.row(inst.id).session_cut).toBe("cd".repeat(16));
    expect(s.audit(inst.id)).toContain("vars.session_cut_failed");
    expect((await s.p.status(inst.id)).sessionCut).toEqual({
      pending: true,
      armed: false,
      owedRelativeToRecordedVars: true,
    });
    await s.p.updateVars(inst.id, {
      AUTH_PROVIDERS: "email,google",
      AUTH_DOMAINS: "finqore.test",
    });
    expect(epoch()).toBe(2);
  });

  it("R-L3: an accepted probe is treated as an upload: structured result and audit", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.ignoreMigrationTag = true;
    const r = keep(await s.p.upgrade(inst.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: false, forwardFix: true });
    expect(r.reason).toMatch(/probe was accepted/);
    expect(s.audit(inst.id)).toContain("upgrade.incomplete");
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("R-N1: status reads state, versions, the lease and a pending cut without taking a lease", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const w = s.fake.writes().length;
    expect(await s.p.status(inst.id)).toEqual({
      id: inst.id,
      state: "active",
      version: "0.23.0",
      previous_version: null,
      lease_until: null,
      leaseLive: false,
      sessionCut: null,
      registryDrift: null,
      directoryRevoke: { state: null, attempts: 0, revokedAt: null },
      owner: "(set)",
    });
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ?, lease = 'x', lease_until = ? WHERE id = ?",
      )
      .run("ef".repeat(16), canonicalJson(CODES), s.clock.now() + 5, inst.id);
    expect(await s.p.status(inst.id)).toMatchObject({
      leaseLive: true,
      sessionCut: { pending: true, owedRelativeToRecordedVars: false },
    });
    expect(s.fake.writes().length).toBe(w);
    expect(await fails(s.p.status("nope"))).toBeInstanceOf(ProvisionRefused);
  });
});

describe("fix round 4", () => {
  const patOf = (s: S, appHost: string) =>
    readFileSync(join(s.patDir, `${appHost}-pat-token`), "utf8").trim();

  it("R2-L1: status() during a running op leaves its lease and redaction intact; a later error from the op is still scrubbed", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const token = patOf(s, inst.appHost);
    let p: WfpProvisioner | undefined;
    let mid: Awaited<ReturnType<WfpProvisioner["status"]>> | undefined;
    p = s.mk({
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        const url = String(u);
        if (url.endsWith("/healthz") && !mid)
          mid = await (p as WfpProvisioner).status(inst.id);
        // After status() ran: the selftest fails with an error that echoes the PAT.
        if (mid && url.endsWith("/mcp"))
          throw new Error(`socket closed after Bearer ${token}`);
        return s.fake.fetch(u, init);
      }) as typeof fetch,
    });
    const r = keep(await p.updateVars(inst.id, { FEATURES: "beta" }));
    expect(mid).toMatchObject({ state: "upgrading", leaseLive: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("[redacted]");
    expect(r.reason).not.toContain(token);
    expect(s.audit(inst.id)).toContain("vars.failed");
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("R2-L1: a second operation started on the same instance while one is in flight is refused", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    let second: Error | undefined;
    let p: WfpProvisioner | undefined;
    p = s.mk({
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        if (String(u).endsWith("/healthz") && !second)
          second = await fails(
            (p as WfpProvisioner).updateVars(inst.id, { FEATURES: "x" }),
          );
        return s.fake.fetch(u, init);
      }) as typeof fetch,
    });
    const r = keep(await p.upgrade(inst.id, "0.24.0"));
    expect(second).toBeInstanceOf(ProvisionRefused);
    expect(second?.message).toMatch(/already running an operation/);
    expect(r.ok).toBe(true);
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.24.0",
      lease: null,
    });
  });

  it("R2-N2: re-running delete on a deleted install removes a HOSTS entry a stalled create put back", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.delete(inst.id, inst.id);
    // The TOCTOU window: a stalled create's HOSTS put lands after the delete.
    s.fake.kvValues(s.hostsId).set(inst.appHost, inst.id);
    s.fake.kvValues(s.hostsId).set(inst.contentHost, "iother0000000");
    const r = keep(await s.p.delete(inst.id, inst.id));
    expect(r).toEqual({ id: inst.id, ok: true, state: "deleted" });
    expect(s.fake.kvValues(s.hostsId).has(inst.appHost)).toBe(false);
    // Another install's entry is never touched.
    expect(s.fake.kvValues(s.hostsId).get(inst.contentHost)).toBe(
      "iother0000000",
    );
    expect(s.audit(inst.id)).toContain("delete.unmap_stale");
  });

  it("R2-N1: status reports a pending cut as the alarm, with owed relative to the recorded vars", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    // A crash between the upload and write(vars): google is live, the
    // recorded vars do not show it, so only `pending` tells the truth.
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ? WHERE id = ?",
      )
      .run("aa".repeat(16), canonicalJson(CODES), inst.id);
    expect((await s.p.status(inst.id)).sessionCut).toEqual({
      pending: true,
      armed: false,
      owedRelativeToRecordedVars: false,
    });
  });
});

describe("fix round 5 (security review)", () => {
  const failOnce = (s: S, match: (body: string, req: Request) => boolean) => {
    let armed = true;
    return s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(u, init);
      const body =
        req.method === "POST" || req.method === "PUT"
          ? await req.clone().text()
          : "";
      if (armed && match(body, req)) {
        armed = false;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: "boom" }] },
          { status: 400 },
        );
      }
      return s.fake.fetch(u, init);
    }) as typeof fetch);
  };

  it("1: tampered install_versions.metadata refuses the rollback with zero uploads", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    const m = JSON.parse(s.stored(inst.id, "0.23.0")?.metadata as string);
    m.compatibility_date = "2020-01-01";
    s.db()
      .prepare(
        "UPDATE install_versions SET metadata = ? WHERE install_id = ? AND version = ?",
      )
      .run(canonicalJson(m), inst.id, "0.23.0");
    const from = s.fake.log.length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/no longer renders the metadata stored/);
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(probes(s.fake, from)).toHaveLength(0);
  });

  it("1: tampered installs.vars refuses upgrade and rollback with zero uploads", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    const from = s.fake.log.length;
    for (const bad of [canonicalJson({ NOPE: "1" }), "{not json", "[]"]) {
      s.db()
        .prepare("UPDATE installs SET vars = ? WHERE id = ?")
        .run(bad, inst.id);
      for (const op of [
        () => s.p.upgrade(inst.id, "0.25.0"),
        () => s.p.rollback(inst.id),
      ])
        expect(await fails(op())).toBeInstanceOf(ProvisionRefused);
    }
    expect(uploads(s.fake, from)).toHaveLength(0);
    expect(probes(s.fake, from)).toHaveLength(0);
    expect(s.row(inst.id)).toMatchObject({ version: "0.24.0", lease: null });
  });

  it("2: every early exit after the claim leaves an <op>.aborted audit row", async () => {
    // Manual rollback failing after rollback.start (live tag differs).
    const s = setup();
    const a = keep(await s.p.create(input("alpha")));
    await s.p.upgrade(a.id, "0.24.0");
    (s.scriptOf(a.id) as { migrationTag: string | null }).migrationTag =
      FOREIGN_TAG;
    await fails(s.p.rollback(a.id));
    expect(s.audit(a.id)).toEqual(
      expect.arrayContaining(["rollback.start", "rollback.aborted"]),
    );
    // Upgrade failing before the upload (the probe finds a tag not in the release).
    (s.scriptOf(a.id) as { migrationTag: string | null }).migrationTag = "v9";
    await fails(s.p.upgrade(a.id, "0.28.0"));
    expect(s.audit(a.id)).toContain("upgrade.aborted");
    // updateVars failing before the upload.
    const b = keep(await s.p.create(input("beta")));
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-/.test(p));
    await fails(s.p.updateVars(b.id, { FEATURES: "x" }));
    expect(s.audit(b.id)).toContain("vars.aborted");
    // delete failing mid-way.
    s.fake.inject((m, p) => m === "DELETE" && /\/scripts\/oa-s-/.test(p));
    await fails(s.p.delete(b.id, b.id));
    expect(s.audit(b.id)).toContain("delete.aborted");
    // create failing after its claim.
    s.fake.health = () => ({ ok: false });
    await fails(s.p.create(input("gamma")));
    const g = (
      s.db().prepare("SELECT id FROM installs WHERE slug = 'gamma'").get() as {
        id: string;
      }
    ).id;
    expect(s.audit(g)).toContain("create.aborted");
  });

  it("3: the DO tag actually reached is stored in installs and install_versions", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const from = s.fake.log.length;
    await s.p.upgrade(inst.id, "0.25.0");
    const sent = metaOf(uploads(s.fake, from)[0]?.body as string);
    expect(sent.migrations?.new_tag).toBe(LEDGER_TAG);
    expect(s.scriptOf(inst.id)?.migrationTag).toBe(LEDGER_TAG);
    expect(s.row(inst.id).do_migration_tag).toBe(LEDGER_TAG);
    expect(s.stored(inst.id, "0.25.0")?.do_migration_tag).toBe(LEDGER_TAG);
    await s.p.updateVars(inst.id, { FEATURES: "beta" });
    expect(s.row(inst.id).do_migration_tag).toBe(LEDGER_TAG);
    expect(s.stored(inst.id, "0.25.0")?.do_migration_tag).toBe(LEDGER_TAG);
  });

  it("4: a google-on upload accepted before a crash: the next op applies the cut even when it renders google off, exactly once", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    // The upload lands, then the vars write fails (stands in for a crash).
    const p = s.mk({
      cf: failOnce(s, (body) => body.includes("UPDATE installs SET vars")),
    });
    const r = keep(
      await p.updateVars(inst.id, {
        AUTH_PROVIDERS: "email,google",
        AUTH_DOMAINS: "finqore.test",
      }),
    );
    expect(r.ok).toBe(false);
    expect(s.row(inst.id).session_cut).not.toBeNull();
    expect(s.row(inst.id).session_cut_armed).toBe(1);
    expect(JSON.parse(s.row(inst.id).vars)).toEqual(CODES);
    expect(epoch()).toBe(0);
    // The next op renders google off: it still cuts the sessions minted while google was live.
    const r2 = keep(
      await s.p.updateVars(inst.id, { ...CODES, FEATURES: "beta" }),
    );
    expect(r2).toMatchObject({ ok: true, sessionCut: true });
    expect(epoch()).toBe(1);
    expect(s.row(inst.id)).toMatchObject({
      session_cut: null,
      session_cut_armed: 0,
    });
    await s.p.updateVars(inst.id, { ...CODES, FEATURES: "gamma" });
    expect(epoch()).toBe(1);
  });

  it("4: no google-on upload ever accepted: the cut is dropped", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const epoch = epochOf(s, inst.id);
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-/.test(p));
    await fails(
      s.p.updateVars(inst.id, {
        AUTH_PROVIDERS: "email,google",
        AUTH_DOMAINS: "finqore.test",
      }),
    );
    expect(s.row(inst.id)).toMatchObject({ session_cut_armed: 0 });
    expect(s.row(inst.id).session_cut).not.toBeNull();
    const r = keep(
      await s.p.updateVars(inst.id, { ...CODES, FEATURES: "beta" }),
    );
    expect(r).toMatchObject({ ok: true, sessionCut: false });
    expect(epoch()).toBe(0);
    expect(s.audit(inst.id)).toContain("vars.session_cut_dropped");
  });
});

describe("no secret in any error, result, audit row or platform row", () => {
  it("collected values", () => {
    expect(SENSITIVE.size).toBeGreaterThan(20);
    const { all, rows } = haystacks();
    for (const v of [...SENSITIVE, ...EMAILS])
      if (v.length >= 8)
        expect(all.includes(v), "a sensitive value leaked").toBe(false);
    for (const v of SENSITIVE)
      if (v.length >= 8)
        expect(rows.includes(v), "a secret is in a platform row").toBe(false);
    // N4: install_versions holds no email either (installs.owner_email does, by design).
    for (const v of EMAILS) expect(versionRows().includes(v)).toBe(false);
  });
});

afterAll(() => {
  const { all, rows } = haystacks();
  const leaks = [...SENSITIVE, ...EMAILS].filter(
    (v) => v.length >= 8 && all.includes(v),
  );
  const rowLeaks = [...SENSITIVE].filter(
    (v) => v.length >= 8 && rows.includes(v),
  );
  if (leaks.length + rowLeaks.length > 0)
    throw new Error(
      `${leaks.length + rowLeaks.length} sensitive value(s) leaked into errors, logs, notes or platform rows`,
    );
});

describe("no per-install cron (T7: the central scheduler is the only nightly caller)", () => {
  it("create, upgrade and rollback upload no triggers and never call a schedules API", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore")));
    await s.p.upgrade(inst.id, "0.24.0");
    keep(await s.p.rollback(inst.id));
    const up = uploads(s.fake);
    // create, upgrade and rollback each upload once.
    expect(up.length).toBeGreaterThanOrEqual(3);
    for (const u of up) {
      const m = metaOf(u.body);
      expect(m).not.toHaveProperty("triggers");
      expect(m).not.toHaveProperty("schedules");
      expect(JSON.stringify(m)).not.toMatch(/cron|trigger|schedul|17 3/i);
    }
    expect(s.fake.log.some((e) => /schedules/i.test(e.path))).toBe(false);
  });
});

// Manager ruling 2026-10-24: within 5 days of expiry, forward changes are
// refused, but an incident rollback (or a delete) never waits on a token
// roll: it runs with a loud note naming the date. An expired token still fails.
describe("token within 5 days of expiry", () => {
  const soon = () => new Date(NOW + 2 * 86_400_000).toISOString();

  it("refuses upgrade and var changes before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.tokenInfo.expires_on = soon();
    const from = s.fake.log.length;
    for (const op of [
      () => s.p.upgrade(inst.id, "0.24.0"),
      () => s.p.updateVars(inst.id, { EMAIL_DAILY_CAP: "50" }),
    ]) {
      const e = await fails(op());
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toContain(soon().slice(0, 10));
      expect(e.message).toMatch(/roll it/);
    }
    expect(s.fake.log.slice(from).filter((e) => e.method !== "GET")).toEqual(
      [],
    );
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.23.0",
    });
  });

  it("lets a rollback run, with a warning that names the date", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    s.fake.tokenInfo.expires_on = soon();
    const r = keep(await s.p.rollback(inst.id));
    expect(r).toMatchObject({ ok: true, rolledBack: true, to: "0.23.0" });
    expect(s.p.notes.join("\n")).toContain(
      `WARNING: the Cloudflare token expires on ${soon().slice(0, 10)}`,
    );
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.23.0",
    });
  });

  it("lets a delete run, with the same warning", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.tokenInfo.expires_on = soon();
    const r = keep(await s.p.delete(inst.id, inst.id));
    expect(r).toMatchObject({ ok: true, state: "deleted" });
    expect(s.p.notes.join("\n")).toContain(soon().slice(0, 10));
  });

  it("an expired token still refuses a rollback", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    s.fake.tokenInfo.expires_on = new Date(NOW - 1000).toISOString();
    const e = await fails(s.p.rollback(inst.id));
    expect(e.message).toMatch(/expired/);
    expect(e).toBeInstanceOf(ProvisionRetry);
    expect(e.code).toBe("token_invalid");
    expect(s.row(inst.id)).toMatchObject({ version: "0.24.0" });
  });
});

describe("P1 Task 8 follow-ups", () => {
  it("status reports sessionCut.armed as well as pending", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    s.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = ?, session_cut_armed = 1 WHERE id = ?",
      )
      .run("ab".repeat(16), canonicalJson(CODES), inst.id);
    expect((await s.p.status(inst.id)).sessionCut).toEqual({
      pending: true,
      armed: true,
      owedRelativeToRecordedVars: false,
    });
    s.db()
      .prepare("UPDATE installs SET session_cut_armed = 0 WHERE id = ?")
      .run(inst.id);
    expect((await s.p.status(inst.id)).sessionCut).toMatchObject({
      pending: true,
      armed: false,
    });
  });

  it("refuses a rollback whose stored metadata is not a render of that release, before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    // The stored 0.23.0 render names a bundle the signed 0.23.0 release does not have.
    const st = s.stored(inst.id, "0.23.0");
    const meta = JSON.parse(st?.metadata as string);
    s.db()
      .prepare(
        "UPDATE install_versions SET metadata = ? WHERE install_id = ? AND version = ?",
      )
      .run(
        JSON.stringify({ ...meta, main_module: "other.js" }),
        inst.id,
        "0.23.0",
      );
    const w = s.fake.writes().length;
    const e = await fails(s.p.rollback(inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/is not a render of that release/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.24.0",
      lease: null,
    });
  });

  it("an upgrade whose auto-rollback meets a render that does not match the release stays forward, with the refusal", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const st = s.stored(inst.id, "0.23.0");
    const meta = JSON.parse(st?.metadata as string);
    s.db()
      .prepare(
        "UPDATE install_versions SET metadata = ? WHERE install_id = ? AND version = ?",
      )
      .run(
        JSON.stringify({ ...meta, tags: [inst.id, "v0.22.0"] }),
        inst.id,
        "0.23.0",
      );
    unhealthyAt(s, "0.24.0");
    const r = keep(await s.p.upgrade(inst.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: false, forwardFix: true });
    expect(r.reason).toMatch(/is not a render of that release/);
    expect(s.row(inst.id)).toMatchObject({
      state: "active",
      version: "0.24.0",
    });
  });

  it("verifyToken runs the token checks with no write; near expiry refuses or warns", async () => {
    const s = setup();
    const w = s.fake.writes().length;
    await s.p.verifyToken("refuse");
    expect(s.fake.writes().length).toBe(w);
    s.fake.tokenInfo.expires_on = new Date(NOW + 2 * 86_400_000).toISOString();
    const p = s.mk();
    await expect(p.verifyToken("refuse")).rejects.toThrow(/within 5 days/);
    const q = s.mk();
    await q.verifyToken("warn");
    expect(q.notes.join("\n")).toMatch(/WARNING/);
    s.fake.tokenInfo.status = "disabled";
    const inactive = await fails(s.mk().verifyToken("warn"));
    expect(inactive.message).toMatch(/not active/);
    expect(inactive).toBeInstanceOf(ProvisionRetry);
    expect(inactive.code).toBe("token_invalid");
  });

  it("an actor audit row lands in hosted_audit.actor, and the table refuses UPDATE and DELETE", async () => {
    const s = setup();
    const { PlatformDb } = await import("../src/platform.js");
    const pdb = new PlatformDb(
      s.cfWith(),
      { id: s.pdb, name: platformNames("staging").db },
      "staging",
      () => NOW,
    );
    await pdb.auditAs("ops@example.com", "-", "cli.status.start", {
      cmd: "status",
    });
    const rows = s
      .db()
      .prepare("SELECT actor, install_id, action FROM hosted_audit")
      .all();
    expect(rows).toEqual([
      { actor: "ops@example.com", install_id: "-", action: "cli.status.start" },
    ]);
    expect(() =>
      s.db().prepare("UPDATE hosted_audit SET action = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() => s.db().prepare("DELETE FROM hosted_audit").run()).toThrow(
      /append-only/,
    );
  });
});

describe("P1 Task 8: domains", () => {
  it("DOMAINS[env] equals the decided suffixes", () => {
    expect(HOSTED_DOMAINS).toEqual({
      staging: {
        app: "open-artifacts-staging.app",
        content: "open-artifacts-staging.page",
      },
      prod: { app: "open-artifacts.app", content: "open-artifacts.page" },
    });
  });
});

describe("fix round 2 (T8 review M1, M2): the broker URL and google", () => {
  const GOOGLE = { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "finqore.test" };
  const brokerUrlOf = (s: S, id: string) =>
    (
      (s.scriptOf(id)?.metadata.bindings ?? []) as {
        name: string;
        text?: string;
      }[]
    ).find((b) => b.name === "AUTH_BROKER_URL")?.text;

  it.each([["staging", "https://auth.open-artifacts-staging.app"]] as const)(
    "with the broker on, %s create renders AUTH_BROKER_URL as %s",
    async (env, want) => {
      const s = setup({ env });
      const p = s.mk({ brokerEnabled: true });
      const inst = keep(await p.create(input("finqore", { vars: GOOGLE })));
      expect(brokerUrlOf(s, inst.id)).toBe(want);
      // The same value from the caller is accepted.
      const q = s.mk({ brokerEnabled: true });
      const b = keep(
        await q.create(
          input("acme", { vars: { ...GOOGLE, AUTH_BROKER_URL: want } }),
        ),
      );
      expect(brokerUrlOf(s, b.id)).toBe(want);
    },
  );

  it.each([
    ["the other env's broker", "https://auth.open-artifacts.app"],
    ["a lookalike host", "https://auth.open-artifacts-staging.app.evil.test"],
    ["a path", "https://auth.open-artifacts-staging.app/x"],
  ])(
    "a caller AUTH_BROKER_URL of %s is refused before any write, naming the expected value",
    async (_n, url) => {
      const s = setup();
      const w = s.fake.writes().length;
      const e = await fails(
        s
          .mk({ brokerEnabled: true })
          .create(
            input("finqore", { vars: { ...GOOGLE, AUTH_BROKER_URL: url } }),
          ),
      );
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toContain("https://auth.open-artifacts-staging.app");
      expect(s.fake.writes().length).toBe(w);
    },
  );

  it("a google create with the broker off is refused before any write", async () => {
    const s = setup();
    const w = s.fake.writes().length;
    const e = await fails(
      s.mk({ brokerEnabled: false }).create(input("finqore", { vars: GOOGLE })),
    );
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/broker/);
    expect(s.fake.writes().length).toBe(w);
  });

  it("update-vars refuses a mismatching AUTH_BROKER_URL before any write", async () => {
    const s = setup();
    const p = s.mk({ brokerEnabled: true });
    const inst = keep(await p.create(input("finqore", { vars: GOOGLE })));
    const w = s.fake.writes().length;
    const e = await fails(
      s.mk({ brokerEnabled: true }).updateVars(inst.id, {
        ...GOOGLE,
        AUTH_BROKER_URL: "https://auth.open-artifacts.app",
      }),
    );
    expect(e.message).toContain("https://auth.open-artifacts-staging.app");
    expect(s.fake.writes().length).toBe(w);
  });

  it("turning google on for an install with no broker key is refused before any write, and no session is cut", async () => {
    const s = setup();
    const inst = keep(
      await s
        .mk({ brokerEnabled: false })
        .create(input("finqore", { vars: CODES })),
    );
    expect(s.row(inst.id).broker_kid).toBeNull();
    const epoch = epochOf(s, inst.id);
    const w = s.fake.writes().length;
    const e = await fails(
      s.mk({ brokerEnabled: true }).updateVars(inst.id, {
        ...CODES,
        AUTH_PROVIDERS: "email,google",
        AUTH_DOMAINS: "finqore.test",
      }),
    );
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/broker key is only issued at create/);
    expect(s.fake.writes().length).toBe(w);
    expect(epoch()).toBe(0);
    expect(s.row(inst.id)).toMatchObject({ session_cut: null, lease: null });
  });
});

describe("fix round 3 (T8): the env's broker Google client id", () => {
  const GOOGLE = { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "finqore.test" };
  const BROKER_WRANGLER = readFileSync(
    new URL("apps/auth-broker/wrangler.jsonc", ROOT),
    "utf8",
  );
  // The broker's own staging client, read from its config so the two can't drift.
  const STAGING_CLIENT = JSON.parse(
    BROKER_WRANGLER.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"),
  ).env.staging.vars.GOOGLE_CLIENT_ID as string;
  const plainOf = (s: S, id: string, name: string) =>
    (
      (s.scriptOf(id)?.metadata.bindings ?? []) as {
        name: string;
        type: string;
        text?: string;
      }[]
    ).find((b) => b.name === name);

  it("the pinned staging client is the broker's", () => {
    expect(STAGING_CLIENT).toBe(
      "1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com",
    );
    expect(BROKER_GOOGLE_CLIENT_ID.staging).toBe(STAGING_CLIENT);
    expect(BROKER_GOOGLE_CLIENT_ID.prod).toBe(
      "206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
    );
  });

  it("with the broker on, a staging create renders GOOGLE_CLIENT_ID as the broker's client; the same caller value is accepted", async () => {
    const s = setup();
    const a = keep(
      await s
        .mk({ brokerEnabled: true })
        .create(input("finqore", { vars: GOOGLE })),
    );
    expect(plainOf(s, a.id, "GOOGLE_CLIENT_ID")).toMatchObject({
      type: "plain_text",
      text: STAGING_CLIENT,
    });
    const b = keep(
      await s.mk({ brokerEnabled: true }).create(
        input("acme", {
          vars: { ...GOOGLE, GOOGLE_CLIENT_ID: STAGING_CLIENT },
        }),
      ),
    );
    expect(plainOf(s, b.id, "GOOGLE_CLIENT_ID")?.text).toBe(STAGING_CLIENT);
  });

  it("a caller GOOGLE_CLIENT_ID that differs is refused before any write, at create and updateVars", async () => {
    const s = setup();
    const other = "999-other.apps.googleusercontent.com";
    let w = s.fake.writes().length;
    const e = await fails(
      s
        .mk({ brokerEnabled: true })
        .create(
          input("finqore", { vars: { ...GOOGLE, GOOGLE_CLIENT_ID: other } }),
        ),
    );
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toContain(STAGING_CLIENT);
    expect(s.fake.writes().length).toBe(w);
    const inst = keep(
      await s
        .mk({ brokerEnabled: true })
        .create(input("acme", { vars: GOOGLE })),
    );
    w = s.fake.writes().length;
    const u = await fails(
      s
        .mk({ brokerEnabled: true })
        .updateVars(inst.id, { ...GOOGLE, GOOGLE_CLIENT_ID: other }),
    );
    expect(u.message).toContain(STAGING_CLIENT);
    expect(s.fake.writes().length).toBe(w);
  });

  it("with the broker on, a prod create renders GOOGLE_CLIENT_ID as prod's broker client, never staging's", async () => {
    const s = setup({ env: "prod" });
    const inst = keep(
      await s
        .mk({ brokerEnabled: true })
        .create(input("leo", { vars: GOOGLE })),
    );
    expect(plainOf(s, inst.id, "GOOGLE_CLIENT_ID")).toMatchObject({
      type: "plain_text",
      text: BROKER_GOOGLE_CLIENT_ID.prod,
    });
    expect(plainOf(s, inst.id, "AUTH_BROKER_URL")?.text).toBe(
      "https://auth.open-artifacts.app",
    );
    const w = s.fake.writes().length;
    const e = await fails(
      s.mk({ brokerEnabled: true }).create(
        input("acme", {
          vars: { ...GOOGLE, GOOGLE_CLIENT_ID: STAGING_CLIENT },
        }),
      ),
    );
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toContain(BROKER_GOOGLE_CLIENT_ID.prod as string);
    expect(s.fake.writes().length).toBe(w);
  });

  it("GOOGLE_CLIENT_SECRET is never rendered, and a caller one is refused before any write", async () => {
    const s = setup();
    const inst = keep(
      await s
        .mk({ brokerEnabled: true })
        .create(input("finqore", { vars: GOOGLE })),
    );
    expect(plainOf(s, inst.id, "GOOGLE_CLIENT_SECRET")).toBeUndefined();
    expect(s.scriptOf(inst.id)?.secrets.has("GOOGLE_CLIENT_SECRET")).toBe(
      false,
    );
    for (const p of [
      s.mk({ brokerEnabled: true }),
      s.mk({ brokerEnabled: false }),
    ]) {
      const w = s.fake.writes().length;
      const e = await fails(
        p.create(
          input("acme", { vars: { GOOGLE_CLIENT_SECRET: "GOCSPX-shh" } }),
        ),
      );
      expect(e.message).toMatch(/GOOGLE_CLIENT_SECRET/);
      expect(s.fake.writes().length).toBe(w);
    }
  });
});

describe("fix round 4 (T8): every server precondition for hosted google", () => {
  const GOOGLE = { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "finqore.test" };
  const STAGING_CLIENT = BROKER_GOOGLE_CLIENT_ID.staging as string;
  const regEntry = (s: S, id: string) =>
    s.fake.kvValues(s.regId).get(registryKey(id));

  // An empty or separator-only AUTH_DOMAINS was already refused by its
  // HOSTED_VARS list check; an absent one reached the server until M3.
  it.each([
    [
      "no AUTH_DOMAINS",
      { AUTH_PROVIDERS: "google" },
      /google needs AUTH_DOMAINS/,
    ],
    [
      "no AUTH_DOMAINS (email, google)",
      { AUTH_PROVIDERS: "email, google" },
      /google needs AUTH_DOMAINS/,
    ],
    [
      "an empty AUTH_DOMAINS",
      { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "" },
      /AUTH_DOMAINS/,
    ],
    [
      "only separators",
      { AUTH_PROVIDERS: "google", AUTH_DOMAINS: " , ," },
      /AUTH_DOMAINS/,
    ],
  ])(
    "M3: a google create with %s is refused before any write (no entry, no key)",
    async (_n, vars, why) => {
      const s = setup();
      const w = s.fake.writes().length;
      const e = await fails(s.p.create(input("finqore", { vars })));
      expect(e.message).toMatch(why);
      expect(s.fake.writes().length).toBe(w);
      expect([...s.fake.kvValues(s.regId).keys()]).toEqual([]);
      expect(s.fake.scripts.size).toBe(0);
    },
  );

  it.each([
    [
      "keeps google and drops AUTH_DOMAINS",
      { AUTH_PROVIDERS: "google" },
      /google needs AUTH_DOMAINS/,
    ],
    [
      "keeps google and empties AUTH_DOMAINS",
      { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "" },
      /AUTH_DOMAINS/,
    ],
  ])(
    "M3: an update-vars that %s is refused before any write, with no session cut",
    async (_n, next, why) => {
      const s = setup();
      const inst = keep(await s.p.create(input("finqore", { vars: GOOGLE })));
      const before = regEntry(s, inst.id);
      const epoch = epochOf(s, inst.id);
      const w = s.fake.writes().length;
      const e = await fails(s.p.updateVars(inst.id, next));
      expect(e.message).toMatch(why);
      expect(s.fake.writes().length).toBe(w);
      expect(regEntry(s, inst.id)).toBe(before);
      expect(epoch()).toBe(0);
      expect(s.row(inst.id)).toMatchObject({ session_cut: null, lease: null });
    },
  );

  it("M3: an update-vars that adds google with no AUTH_DOMAINS is refused before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: CODES })));
    const w = s.fake.writes().length;
    const e = await fails(
      s.p.updateVars(inst.id, { ...CODES, AUTH_PROVIDERS: "email,google" }),
    );
    expect(e.message).toMatch(/google needs AUTH_DOMAINS/);
    expect(s.fake.writes().length).toBe(w);
    expect(s.row(inst.id).session_cut).toBeNull();
  });

  // apps/server/src/auth/config.ts googleConfig, precondition by precondition:
  // each is either rendered by provision (removing it from the rendered env
  // makes the server refuse google) or refused by provision before any write.
  type Server = {
    authConfig(env: Record<string, unknown>): {
      google: {
        clientId: string;
        transport: { kind: string; url?: string };
      } | null;
      problems: string[];
    };
  };
  const server = async (): Promise<Server> =>
    (await import(
      /* @vite-ignore */ new URL("apps/server/src/auth/config.ts", ROOT).href
    )) as Server;
  const renderedEnv = (s: S, id: string) => {
    const sc = s.scriptOf(id);
    const env: Record<string, unknown> = {};
    for (const b of (sc?.metadata.bindings ?? []) as {
      name: string;
      type: string;
      text?: string;
    }[])
      if (b.type === "plain_text") env[b.name] = b.text;
    for (const [k, v] of sc?.secrets ?? []) env[k] = v;
    return env;
  };

  const RENDERED: [string, string, RegExp][] = [
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID", /GOOGLE_CLIENT_ID isn't set/],
    [
      "HOSTED=1 needs the broker transport",
      "AUTH_BROKER_URL",
      /needs the broker transport/,
    ],
    ["INSTALL_ID", "INSTALL_ID", /INSTALL_ID isn't set/],
    [
      "BROKER_SIGNING_KEY (PKCS#8 Ed25519)",
      "BROKER_SIGNING_KEY",
      /BROKER_SIGNING_KEY isn't/,
    ],
    ["AUTH_DOMAINS non-empty", "AUTH_DOMAINS", /AUTH_DOMAINS is empty/],
  ];
  it.each(RENDERED)(
    "rendered by provision: %s (without %s the server refuses google)",
    async (_n, key, why) => {
      const s = setup();
      const inst = keep(await s.p.create(input("finqore", { vars: GOOGLE })));
      const { authConfig } = await server();
      const env = renderedEnv(s, inst.id);
      const ok = authConfig({ ...env });
      expect(ok.problems).toEqual([]);
      expect(ok.google).toEqual({
        clientId: STAGING_CLIENT,
        transport: expect.objectContaining({
          kind: "broker",
          url: "https://auth.open-artifacts-staging.app",
        }),
      });
      expect(env.HOSTED).toBe("1");
      expect(env.GOOGLE_CLIENT_SECRET).toBeUndefined();
      const { [key]: _gone, ...without } = env;
      const bad = authConfig(without);
      expect(bad.google).toBeNull();
      expect(bad.problems.join("\n")).toMatch(why);
    },
  );

  // Review item 6: on HOSTED=1 the server's directory transport is "none"
  // unless DIRECTORY_BROKER_URL is set. Provision renders it with the broker,
  // so a hosted google install resolves to the broker transport.
  it("the rendered env resolves the server's directory transport to the env's directory broker", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: GOOGLE })));
    const env = renderedEnv(s, inst.id);
    expect(env.DIRECTORY_BROKER_URL).toBe(
      "https://directory.open-artifacts-staging.app",
    );
    const { directoryTransport, HOSTED_NEEDS_BROKER } = (await import(
      /* @vite-ignore */ new URL("apps/server/src/directory/transport.ts", ROOT)
        .href
    )) as {
      directoryTransport(env: Record<string, unknown>): {
        kind: string;
        brokerUrl?: string;
        installId?: string;
        problem?: string;
      };
      HOSTED_NEEDS_BROKER: string;
    };
    expect(directoryTransport({ ...env })).toMatchObject({
      kind: "broker",
      brokerUrl: "https://directory.open-artifacts-staging.app",
      installId: inst.id,
    });
    // Without it (every hosted install before this fix): none, by design.
    const { DIRECTORY_BROKER_URL: _gone, ...without } = env;
    expect(directoryTransport(without)).toEqual({
      kind: "none",
      problem: HOSTED_NEEDS_BROKER,
    });
  });

  it.each([
    [
      "the other env's directory broker",
      "https://directory.open-artifacts.app",
    ],
    ["the sign-in broker", "https://auth.open-artifacts-staging.app"],
    [
      "a lookalike host",
      "https://directory.open-artifacts-staging.app.evil.test",
    ],
  ])(
    "a caller DIRECTORY_BROKER_URL of %s is refused before any write, naming the expected value",
    async (_n, url) => {
      const s = setup();
      const w = s.fake.writes().length;
      const e = await fails(
        s.mk({ brokerEnabled: true }).create(
          input("finqore", {
            vars: { ...GOOGLE, DIRECTORY_BROKER_URL: url },
          }),
        ),
      );
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toContain(
        "https://directory.open-artifacts-staging.app",
      );
      expect(s.fake.writes().length).toBe(w);
    },
  );

  it("upgrade adds DIRECTORY_BROKER_URL to an install created before it (re-render, no refusal)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: GOOGLE })));
    s.db()
      .prepare("UPDATE installs SET vars = ? WHERE id = ?")
      .run(canonicalJson(GOOGLE), inst.id);
    const up = keep(await s.mk().upgrade(inst.id, "0.24.0"));
    expect(up.ok).toBe(true);
    expect(renderedEnv(s, inst.id).DIRECTORY_BROKER_URL).toBe(
      "https://directory.open-artifacts-staging.app",
    );
  });

  const REFUSED: [string, Record<string, string>, RegExp][] = [
    [
      "AUTH_DOMAINS empty",
      { AUTH_PROVIDERS: "google" },
      /google needs AUTH_DOMAINS/,
    ],
    [
      "an invalid AUTH_DOMAINS entry",
      { ...GOOGLE, AUTH_DOMAINS: "finqore.test,not a domain" },
      /AUTH_DOMAINS/,
    ],
    [
      "AUTH_BROKER_URL not the env's broker",
      { ...GOOGLE, AUTH_BROKER_URL: "http://auth.open-artifacts-staging.app" },
      /AUTH_BROKER_URL/,
    ],
    [
      "GOOGLE_CLIENT_ID not the broker's",
      { ...GOOGLE, GOOGLE_CLIENT_ID: "1-x.apps.googleusercontent.com" },
      /GOOGLE_CLIENT_ID must be/,
    ],
    [
      "the direct transport (GOOGLE_CLIENT_SECRET)",
      { ...GOOGLE, GOOGLE_CLIENT_SECRET: "GOCSPX-x" },
      /GOOGLE_CLIENT_SECRET/,
    ],
    [
      "AUTH_DOMAIN_JOIN=member",
      { ...GOOGLE, AUTH_DOMAIN_JOIN: "member" },
      /invite/,
    ],
  ];
  it.each(REFUSED)(
    "refused by provision before any write: %s",
    async (_n, vars, why) => {
      const s = setup();
      const w = s.fake.writes().length;
      const e = await fails(s.p.create(input("finqore", { vars })));
      expect(e.message).toMatch(why);
      expect(s.fake.writes().length).toBe(w);
    },
  );

  it("L7: upgrade and rollback re-render a stale stored broker URL or client id, never refuse on it", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input("finqore", { vars: GOOGLE })));
    const stale = {
      ...GOOGLE,
      AUTH_BROKER_URL: "https://auth.old.example",
      GOOGLE_CLIENT_ID: "1-old.apps.googleusercontent.com",
    };
    s.db()
      .prepare("UPDATE installs SET vars = ? WHERE id = ?")
      .run(canonicalJson(stale), inst.id);
    const up = keep(await s.mk().upgrade(inst.id, "0.24.0"));
    expect(up.ok).toBe(true);
    const env = renderedEnv(s, inst.id);
    expect(env.AUTH_BROKER_URL).toBe("https://auth.open-artifacts-staging.app");
    expect(env.GOOGLE_CLIENT_ID).toBe(STAGING_CLIENT);
    const p = s.mk();
    const rb = keep(await p.rollback(inst.id));
    expect(rb).toMatchObject({ ok: true, rolledBack: true });
    expect(renderedEnv(s, inst.id).GOOGLE_CLIENT_ID).toBe(STAGING_CLIENT);
  });
});

// A done is fresh: confirmed at this attempt's start (M1b).
const setRevoke = (s: S, id: string, v: string) =>
  s
    .db()
    .prepare(
      "UPDATE installs SET directory_revoke = ?1, directory_revoked_at = CASE WHEN ?1 = 'done' THEN directory_revoke_requested_at ELSE directory_revoked_at END WHERE id = ?2",
    )
    .run(v, id);

describe("H-DV: delete revokes the directory grant first", () => {
  const POLL_MS = 15_000;
  const revokeRow = (s: S, id: string) =>
    s
      .db()
      .prepare(
        "SELECT state, directory_revoke, directory_revoked_at, directory_revoke_attempts, directory_revoke_requested_at, lease FROM installs WHERE id = ?",
      )
      .get(id) as {
      state: string;
      directory_revoke: string | null;
      directory_revoked_at: number | null;
      directory_revoke_attempts: number;
      directory_revoke_requested_at: number | null;
      lease: string | null;
    };

  it("phase 1 marks the row deleting + pending, unmaps the hosts and drops the lease; phase 2 waits, then tears down", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const seen: unknown[] = [];
    s.fake.revoker = (_db, id) => {
      seen.push({
        ...revokeRow(s, id),
        mapped: [inst.appHost, inst.contentHost].filter((h) =>
          s.fake.kvValues(s.hostsId).has(h),
        ),
        script: s.scriptOf(id) !== undefined,
      });
      if (seen.length === 3) setRevoke(s, id, "done");
    };
    const t0 = s.clock.now();
    const r = keep(await s.p.delete(inst.id, inst.id));
    expect(r).toEqual({ id: inst.id, ok: true, state: "deleted" });
    expect(seen[0]).toEqual({
      state: "deleting",
      directory_revoke: "pending",
      directory_revoked_at: null,
      directory_revoke_attempts: 0,
      directory_revoke_requested_at: expect.any(Number),
      lease: null,
      // M1a: unmapped before any revoke resolves (the job needs no HOSTS).
      mapped: [],
      script: true,
    });
    expect(seen).toHaveLength(3);
    // Polled every 15 s on the injected clock.
    expect(s.clock.now() - t0).toBeGreaterThanOrEqual(2 * POLL_MS);
    expect(s.fake.kvValues(s.hostsId).has(inst.appHost)).toBe(false);
    expect(s.scriptOf(inst.id)).toBeUndefined();
    const a = s.audit(inst.id);
    expect(a.indexOf("delete.revoke_pending")).toBeLessThan(
      a.indexOf("delete.done"),
    );
  });

  it("M2: an unsupported revoke refuses (it never tears down) and names the skip flag", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = (_db, id) => setRevoke(s, id, "unsupported");
    const e = await fails(s.p.delete(inst.id, inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toBe(
      `install ${inst.id} is below ${REVOKE_MIN_VERSION} and can't confirm the Google revoke; upgrade it or pass --skip-directory-revoke <reason>`,
    );
    expect(revokeRow(s, inst.id).state).toBe("deleting");
    expect(s.scriptOf(inst.id)).toBeDefined();
    expect(s.audit(inst.id)).not.toContain("delete.done");
  });

  it("times out after 10 minutes with the row left deleting, then a rerun resumes at phase 2", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    let polls = 0;
    s.fake.revoker = () => {
      polls++;
    };
    const t0 = s.clock.now();
    const e = await fails(s.p.delete(inst.id, inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(
      /still pending after 10 minutes; rerun delete to resume/,
    );
    expect(e).toBeInstanceOf(ProvisionRetry);
    expect(e.code).toBe("revoke_pending");
    expect(s.clock.now() - t0).toBeGreaterThanOrEqual(10 * 60_000);
    expect(polls).toBe(41);
    expect(revokeRow(s, inst.id)).toMatchObject({
      state: "deleting",
      directory_revoke: "pending",
      lease: null,
    });
    expect(s.scriptOf(inst.id)).toBeDefined();
    expect(s.fake.kvValues(s.hostsId).has(inst.appHost)).toBe(false);
    s.fake.revoker = (_db, id) => setRevoke(s, id, "done");
    expect(keep(await s.mk().delete(inst.id, inst.id)).state).toBe("deleted");
    // M1b: each attempt records its own start.
    expect(
      s.audit(inst.id).filter((x) => x === "delete.revoke_pending"),
    ).toHaveLength(2);
  });

  it("a failed revoke refuses, leaving the row deleting and everything in place", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = (_db, id) => setRevoke(s, id, "failed");
    const e = await fails(s.p.delete(inst.id, inst.id));
    expect(e.message).toMatch(/directory revoke failed/);
    expect(e.message).toMatch(/--skip-directory-revoke/);
    expect(revokeRow(s, inst.id).state).toBe("deleting");
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("skipDirectoryRevoke needs a reason, records it, says the grant stays live, and tears down without waiting", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    let polls = 0;
    s.fake.revoker = () => {
      polls++;
    };
    for (const bad of ["", "   ", "mail ops@example.com", "x".repeat(201)]) {
      const w = s.fake.writes().length;
      const e = await fails(
        s.mk().delete(inst.id, inst.id, { skipDirectoryRevoke: bad }),
      );
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(s.fake.writes().length).toBe(w);
    }
    const p = s.mk();
    const r = keep(
      await p.delete(inst.id, inst.id, {
        skipDirectoryRevoke: "customer Google tenant closed",
      }),
    );
    expect(r.state).toBe("deleted");
    expect(polls).toBe(0);
    expect(revokeRow(s, inst.id).directory_revoke).toBe("skipped");
    expect(p.notes).toContain(DIRECTORY_REVOKE_SKIPPED_NOTE);
    expect(DIRECTORY_REVOKE_SKIPPED_NOTE).toMatch(
      /^the Google grant stays live; revoke it in the customer's Google Admin console: Security > Access and data control > API controls > /,
    );
    const row = s
      .db()
      .prepare(
        "SELECT detail FROM hosted_audit WHERE install_id = ? AND action = 'delete.revoke_skipped'",
      )
      .get(inst.id) as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({
      reason: "customer Google tenant closed",
    });
  });

  it("a rerun with skipDirectoryRevoke while pending skips and tears down", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = null;
    await fails(s.p.delete(inst.id, inst.id));
    const r = keep(
      await s
        .mk()
        .delete(inst.id, inst.id, { skipDirectoryRevoke: "broker down" }),
    );
    expect(r.state).toBe("deleted");
    expect(revokeRow(s, inst.id).directory_revoke).toBe("skipped");
  });

  it("onPoll reports each poll; status shows the revoke state", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    let n = 0;
    s.fake.revoker = (_db, id) => {
      if (++n === 2) {
        s.db()
          .prepare(
            "UPDATE installs SET directory_revoke_attempts = 1 WHERE id = ?",
          )
          .run(id);
      }
      if (n === 3) setRevoke(s, id, "done");
    };
    const polls: {
      state: string | null;
      attempts: number;
      waitedMs: number;
    }[] = [];
    let mid: unknown;
    await s.p.delete(inst.id, inst.id, {
      onPoll: async (p) => {
        polls.push(p);
        if (polls.length === 2)
          mid = (await s.mk().status(inst.id)).directoryRevoke;
      },
    });
    expect(polls.map((p) => p.state)).toEqual(["pending", "pending", "done"]);
    expect(polls.map((p) => p.waitedMs)).toEqual([0, POLL_MS, 2 * POLL_MS]);
    expect(polls[1]?.attempts).toBe(1);
    expect(mid).toEqual({ state: "pending", attempts: 1, revokedAt: null });
  });
});

describe("H-DV fix 2: delete unmaps first and needs a fresh confirmed revoke", () => {
  const row = (s: S, id: string) =>
    s
      .db()
      .prepare(
        "SELECT state, directory_revoke, directory_revoked_at, directory_revoke_requested_at, directory_revoke_attempts FROM installs WHERE id = ?",
      )
      .get(id) as {
      state: string;
      directory_revoke: string | null;
      directory_revoked_at: number | null;
      directory_revoke_requested_at: number | null;
      directory_revoke_attempts: number;
    };
  const mapped = (s: S, i: { appHost: string; contentHost: string }) =>
    [i.appHost, i.contentHost].filter((h) => s.fake.kvValues(s.hostsId).has(h));
  const pendingAudits = (s: S, id: string) =>
    s.audit(id).filter((x) => x === "delete.revoke_pending").length;

  it("M1a: after phase 1, before any revoke resolves, no HOSTS key maps to the install", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    expect(mapped(s, inst)).toHaveLength(2);
    const seen: string[][] = [];
    s.fake.revoker = () => {
      seen.push(mapped(s, inst));
    };
    await fails(s.p.delete(inst.id, inst.id));
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) expect(m).toEqual([]);
    expect(row(s, inst.id).directory_revoke).toBe("pending");
  });

  it("ordering: the DIRECTORY_REGISTRY entry stays until the revoke is done, and goes only after", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const inDir = () => s.fake.kvValues(s.dirId).has(registryKey(inst.id));
    expect(inDir()).toBe(true);
    const seen: boolean[] = [];
    let n = 0;
    s.fake.revoker = (_db, id) => {
      // The broker's /revoke resolves the install through this entry.
      seen.push(inDir());
      if (++n === 3) setRevoke(s, id, "done");
    };
    expect(keep(await s.p.delete(inst.id, inst.id)).state).toBe("deleted");
    expect(seen).toEqual([true, true, true]);
    expect(inDir()).toBe(false);
  });

  it("ordering: a failed or still-pending revoke never removes the DIRECTORY_REGISTRY entry", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const inDir = () => s.fake.kvValues(s.dirId).has(registryKey(inst.id));
    s.fake.revoker = null;
    await fails(s.p.delete(inst.id, inst.id));
    expect(row(s, inst.id).directory_revoke).toBe("pending");
    expect(inDir()).toBe(true);
    setRevoke(s, inst.id, "failed");
    await fails(s.mk().delete(inst.id, inst.id));
    expect(inDir()).toBe(true);
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("M1b: a stale done from an earlier attempt does not unlock teardown", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', directory_revoke = 'done', directory_revoke_requested_at = 1000, directory_revoked_at = 500 WHERE id = ?",
      )
      .run(inst.id);
    s.fake.revoker = null;
    const e = await fails(s.mk().delete(inst.id, inst.id));
    expect(e.message).toMatch(/still pending/);
    const r = row(s, inst.id);
    expect(r.directory_revoke).toBe("pending");
    expect(r.directory_revoke_requested_at).toBeGreaterThan(1000);
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("M1b: a done newer than the attempt's start unlocks teardown, with no new attempt", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', directory_revoke = 'done', directory_revoke_requested_at = 1000, directory_revoked_at = 1001 WHERE id = ?",
      )
      .run(inst.id);
    s.fake.revoker = null;
    expect(keep(await s.mk().delete(inst.id, inst.id)).state).toBe("deleted");
    expect(pendingAudits(s, inst.id)).toBe(0);
  });

  it("M1b: a stale done seen on a poll re-dispatches (pending) and waits for a fresh one", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const states: (string | null)[] = [];
    let n = 0;
    s.fake.revoker = (db, id) => {
      states.push(row(s, id).directory_revoke);
      n++;
      if (n === 1)
        db.prepare(
          "UPDATE installs SET directory_revoke = 'done', directory_revoked_at = directory_revoke_requested_at - 1 WHERE id = ?",
        ).run(id);
      if (n === 3) setRevoke(s, id, "done");
    };
    expect(keep(await s.p.delete(inst.id, inst.id)).state).toBe("deleted");
    // The poll after the stale done finds it re-dispatched.
    expect(states).toEqual(["pending", "pending", "pending"]);
  });

  it("M1b: teardown refuses and re-dispatches when the done is stale at its re-read", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = (_db, id) => setRevoke(s, id, "done");
    let armed = true;
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const res = await s.fake.fetch(u, init);
        const body = init?.body ? String(init.body) : "";
        if (armed && body.includes("SELECT directory_revoke")) {
          armed = false;
          s.db()
            .prepare(
              "UPDATE installs SET directory_revoked_at = directory_revoke_requested_at - 1 WHERE id = ?",
            )
            .run(inst.id);
        }
        return res;
      }) as typeof fetch),
    });
    const e = await fails(p.delete(inst.id, inst.id));
    expect(e.message).toMatch(/not confirmed for this attempt/);
    expect(row(s, inst.id).directory_revoke).toBe("pending");
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("M2: a rerun after failed starts a fresh attempt (attempts reset, pending)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = (_db, id) => {
      s.db()
        .prepare(
          "UPDATE installs SET directory_revoke = 'failed', directory_revoke_attempts = 5 WHERE id = ?",
        )
        .run(id);
    };
    const e = await fails(s.p.delete(inst.id, inst.id));
    expect(e.message).toMatch(/directory revoke failed after 5 attempts/);
    expect(e.message).toMatch(/--skip-directory-revoke/);
    s.fake.revoker = null;
    await fails(s.mk().delete(inst.id, inst.id));
    expect(row(s, inst.id)).toMatchObject({
      directory_revoke: "pending",
      directory_revoke_attempts: 0,
    });
  });
});

describe("H-DV: a purged owner email ('') is never used as an address", () => {
  const purge = (s: S, id: string) =>
    s.db().prepare("UPDATE installs SET owner_email = '' WHERE id = ?").run(id);

  it("isPurgedEmail and ownerEmailOf", () => {
    expect(PURGED_EMAIL).toBe("");
    expect(isPurgedEmail("")).toBe(true);
    for (const v of ["o@x.test", null, undefined, " "])
      expect(isPurgedEmail(v)).toBe(false);
    expect(ownerEmailOf({ owner_email: "o@x.test" })).toBe("o@x.test");
    expect(ownerEmailOf({ owner_email: "" })).toBeNull();
    expect(ownerEmailOf({ owner_email: null })).toBeNull();
  });

  it.each([
    ["upgrade", (p: WfpProvisioner, id: string) => p.upgrade(id, "0.24.0")],
    [
      "updateVars",
      (p: WfpProvisioner, id: string) =>
        p.updateVars(id, { EMAIL_DAILY_CAP: "5" }),
    ],
  ] as const)(
    "%s on an install whose owner email is purged refuses before any write, and never renders it",
    async (_n, op) => {
      const s = setup();
      const inst = keep(await s.p.create(input()));
      purge(s, inst.id);
      const ups = uploads(s.fake).length;
      const w = s.fake.writes().length;
      const e = await fails(op(s.mk(), inst.id));
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(
        new RegExp(`install ${inst.id}: the owner email is purged`),
      );
      expect(s.fake.writes().length).toBe(w);
      expect(uploads(s.fake).length).toBe(ups);
    },
  );

  it("a purged email never enters the redaction set (an error message stays readable)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    purge(s, inst.id);
    const e = await fails(s.mk().upgrade(inst.id, "0.24.0"));
    expect(e.message).not.toContain("[redacted]");
    expect(e.message).toContain("purged");
  });

  it("status says owner (purged) or (set), never the address", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const st = await s.p.status(inst.id);
    expect(st.owner).toBe("(set)");
    expect(JSON.stringify(st)).not.toContain(OWNER);
    purge(s, inst.id);
    expect((await s.mk().status(inst.id)).owner).toBe("(purged)");
  });

  it("delete of an install whose email is purged still tears down (it needs no address)", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    purge(s, inst.id);
    expect(keep(await s.mk().delete(inst.id, inst.id)).state).toBe("deleted");
  });
});

describe("H-DV review fixes", () => {
  const failNext = (s: S, match: (body: string) => boolean) => {
    let armed = true;
    return s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(u, init);
      const body = req.method === "POST" ? await req.clone().text() : "";
      if (armed && match(body)) {
        armed = false;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: "boom" }] },
          { status: 400 },
        );
      }
      return s.fake.fetch(u, init);
    }) as typeof fetch);
  };
  const revokeOf = (s: S, id: string) =>
    (
      s
        .db()
        .prepare("SELECT directory_revoke FROM installs WHERE id = ?")
        .get(id) as {
        directory_revoke: string | null;
      }
    ).directory_revoke;

  it("M1: the skip reason is audited before the row says skipped; a failed audit leaves no skipped row, and a plain rerun never tears down", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = null;
    const p = s.mk({
      cf: failNext(s, (b) => b.includes("delete.revoke_skipped")),
    });
    await fails(
      p.delete(inst.id, inst.id, { skipDirectoryRevoke: "tenant closed" }),
    );
    expect(revokeOf(s, inst.id)).not.toBe("skipped");
    expect(s.audit(inst.id)).not.toContain("delete.revoke_skipped");
    // A rerun without the flag waits for the revoke: it never tears down.
    const e = await fails(s.mk().delete(inst.id, inst.id));
    expect(e.message).toMatch(/still pending/);
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("M1: a skipped row with no recorded reason refuses until the flag is given again", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', directory_revoke = 'skipped' WHERE id = ?",
      )
      .run(inst.id);
    const e = await fails(s.mk().delete(inst.id, inst.id));
    expect(e.message).toMatch(
      /skipped with no recorded reason; rerun with --skip-directory-revoke/,
    );
    expect(s.scriptOf(inst.id)).toBeDefined();
    const r = keep(
      await s
        .mk()
        .delete(inst.id, inst.id, { skipDirectoryRevoke: "tenant closed" }),
    );
    expect(r.state).toBe("deleted");
    expect(s.audit(inst.id)).toContain("delete.revoke_skipped");
  });

  it("L6: skip from failed tears down; skip on an install already revoked prints no note and audits no reason", async () => {
    const s = setup();
    const a = keep(await s.p.create(input("alpha")));
    s.fake.revoker = (db, id) => {
      db.prepare(
        "UPDATE installs SET directory_revoke = 'failed' WHERE id = ?",
      ).run(id);
    };
    await fails(s.mk().delete(a.id, a.id));
    const p = s.mk();
    expect(
      keep(
        await p.delete(a.id, a.id, {
          skipDirectoryRevoke: "grant revoked by hand",
        }),
      ).state,
    ).toBe("deleted");
    expect(p.notes).toContain(DIRECTORY_REVOKE_SKIPPED_NOTE);
    const b = keep(await s.mk().create(input("beta")));
    s.fake.revoker = (_db, id) => setRevoke(s, id, "done");
    // A done with no attempt start is stale: phase 1 runs (pending), the
    // revoke lands, so the skip is moot.
    s.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', directory_revoke = 'done' WHERE id = ?",
      )
      .run(b.id);
    const q = s.mk();
    expect(
      keep(await q.delete(b.id, b.id, { skipDirectoryRevoke: "not needed" }))
        .state,
    ).toBe("deleted");
    expect(q.notes).not.toContain(DIRECTORY_REVOKE_SKIPPED_NOTE);
    expect(s.audit(b.id)).not.toContain("delete.revoke_skipped");
  });

  it("M2: unsupported, then skip with a reason, tears down with the audited note", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.fake.revoker = (_db, id) => setRevoke(s, id, "unsupported");
    await fails(s.p.delete(inst.id, inst.id));
    const p = s.mk();
    expect(
      keep(
        await p.delete(inst.id, inst.id, {
          skipDirectoryRevoke: "old release",
        }),
      ).state,
    ).toBe("deleted");
    expect(s.audit(inst.id)).toContain("delete.revoke_skipped");
    expect(p.notes).toContain(DIRECTORY_REVOKE_SKIPPED_NOTE);
  });

  it("nit: teardown rechecks that the revoke is settled", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    // The poll sees done, then the row flips back before the teardown re-read.
    let n = 0;
    s.fake.revoker = (_db, id) => {
      if (++n === 1) setRevoke(s, id, "done");
    };
    const p = s.mk({
      cf: s.cfWith((async (u: RequestInfo | URL, init?: RequestInit) => {
        const res = await s.fake.fetch(u, init);
        const body = init?.body ? String(init.body) : "";
        if (body.includes("SELECT directory_revoke"))
          s.db()
            .prepare(
              "UPDATE installs SET directory_revoke = 'pending' WHERE id = ?",
            )
            .run(inst.id);
        return res;
      }) as typeof fetch),
    });
    const e = await fails(p.delete(inst.id, inst.id));
    expect(e.message).toMatch(/no longer settled/);
    expect(s.scriptOf(inst.id)).toBeDefined();
  });

  it("L6: rollback on an install whose owner email is purged refuses before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    await s.p.upgrade(inst.id, "0.24.0");
    s.db()
      .prepare("UPDATE installs SET owner_email = '' WHERE id = ?")
      .run(inst.id);
    const w = s.fake.writes().length;
    const e = await fails(s.mk().rollback(inst.id));
    expect(e.message).toMatch(/owner email is purged/);
    expect(s.fake.writes().length).toBe(w);
  });
});

describe("H-DV: the stored row a create writes (the scheduler's purge fixture)", () => {
  // apps/scheduler/test/revoke.test.ts seeds install_versions and
  // inputs_hash from this file, so its "nothing holds the email" check runs
  // on what create really stores. Regenerate with UPDATE_FIXTURES=1.
  const FIXTURE = new URL("./fixtures/stored-install.json", import.meta.url);
  it("matches a fresh google create (ids normalized)", async () => {
    const s = setup();
    const inst = keep(
      await s.p.create(
        input("finqore", {
          vars: { AUTH_PROVIDERS: "google", AUTH_DOMAINS: "finqore.test" },
        }),
      ),
    );
    const row = s.row(inst.id);
    const st = s.stored(inst.id, "0.23.0") as {
      metadata: string;
      vars: string;
    };
    const norm = (t: string) =>
      t
        .split(inst.id)
        .join("{{INSTALL_ID}}")
        .split(String(row.d1_id))
        .join("{{D1_ID}}")
        .split(String(row.kv_id))
        .join("{{KV_ID}}");
    const got = {
      ownerEmail: OWNER,
      inputsHash: row.inputs_hash,
      version: "0.23.0",
      vars: JSON.parse(norm(st.vars)),
      metadata: JSON.parse(norm(st.metadata)),
    };
    // The stored copy holds no email, by construction.
    expect(st.metadata + st.vars).not.toContain(OWNER);
    if (process.env.UPDATE_FIXTURES === "1")
      writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(got);
  });
});

describe("Turnstile test keys (red-line installs only)", () => {
  const RL_VARS = { ...HOOK_VARS, ...CODES };
  const siteKeyOf = (meta: { bindings: { name: string; text?: string }[] }) =>
    meta.bindings.find((b) => b.name === "TURNSTILE_SITE_KEY")?.text;

  it("are Cloudflare's always-pass pair", () => {
    expect(TURNSTILE_TEST_KEYS).toEqual({
      sitekey: "1x00000000000000000000AA",
      secret: "1x0000000000000000000000000000000AA",
    });
  });

  it("a test-hooks install with codes on gets the test pair, never the env widget", async () => {
    const s = setup();
    const from = s.fake.log.length;
    const inst = keep(
      await s.p.create(
        input("rl-a", { testHooks: true, bundle: "redline", vars: RL_VARS }),
      ),
    );
    const meta = metaOf(uploads(s.fake, from)[0]?.body as string);
    expect(siteKeyOf(meta)).toBe(TURNSTILE_TEST_KEYS.sitekey);
    expect(s.scriptOf(inst.id)?.secrets.get("TURNSTILE_SECRET")).toBe(
      TURNSTILE_TEST_KEYS.secret,
    );
    expect(JSON.stringify(s.fake.raw)).not.toContain(TS.secret);
    // No widget lookup: the test sitekey is not an account widget.
    expect(
      s.fake.log
        .slice(from)
        .some((l) => String(l.path).includes("/challenges/widgets/")),
    ).toBe(false);
  });

  it("an install without test hooks refuses a test key as the env's widget, before any write", async () => {
    for (const k of [
      TURNSTILE_TEST_KEYS,
      { sitekey: "2x00000000000000000000AB", secret: TS.secret },
      { sitekey: TS.sitekey, secret: "3x0000000000000000000000000000000AA" },
    ]) {
      const s = setup();
      const p = s.mk({ turnstile: k });
      const n = s.fake.writes().length;
      const e = await fails(p.create(input("acme", { vars: CODES })));
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(/test Turnstile key/);
      expect(s.fake.writes().length).toBe(n);
    }
  });

  it("prod refuses a test key as its widget", async () => {
    const s = setup({ env: "prod" });
    const p = s.mk({ turnstile: TURNSTILE_TEST_KEYS });
    const e = await fails(p.create(input("acme", { vars: CODES })));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/test Turnstile key/);
  });

  it("updateVars on a test-hooks install re-sends the test secret even when one is set, and renders the test sitekey", async () => {
    const s = setup();
    const inst = keep(
      await s.p.create(
        input("rl-a", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
      ),
    );
    // As on staging today: the env's real secret is already on the install.
    s.scriptOf(inst.id)?.secrets.set("TURNSTILE_SECRET", TS.secret);
    const from = s.fake.log.length;
    keep(await s.p.updateVars(inst.id, RL_VARS));
    const meta = metaOf(uploads(s.fake, from)[0]?.body as string);
    expect(siteKeyOf(meta)).toBe(TURNSTILE_TEST_KEYS.sitekey);
    expect(s.scriptOf(inst.id)?.secrets.get("TURNSTILE_SECRET")).toBe(
      TURNSTILE_TEST_KEYS.secret,
    );
  });

  it("rotation never touches a test-hooks install", async () => {
    const s = setup();
    const rl = keep(
      await s.p.create(
        input("rl-a", { testHooks: true, bundle: "redline", vars: RL_VARS }),
      ),
    );
    const a = keep(await s.p.create(input("alpha", { vars: CODES })));
    const p = s.mk({ turnstile: { sitekey: TS.sitekey, secret: TS_NEXT } });
    const out = keep(await p.rotateTurnstileSecret("staging"));
    const byId = Object.fromEntries(out.map((x) => [x.id, x]));
    expect(byId[rl.id]).toMatchObject({ ok: true, rotated: false });
    expect(byId[a.id]).toMatchObject({ ok: true, rotated: true });
    expect(s.scriptOf(rl.id)?.secrets.get("TURNSTILE_SECRET")).toBe(
      TURNSTILE_TEST_KEYS.secret,
    );
  });
});

describe("reissueOwnerToken", () => {
  const patPath = (s: ReturnType<typeof setup>, appHost: string) =>
    join(s.patDir, `${appHost}-pat-token`);

  it("mints a fresh provision PAT under the lease, writes it 0600, and retires the earlier provision ones only", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const idb = s.installDb(inst.id);
    // A token the owner made by hand stays; the revoked provision one is the old state.
    idb
      .prepare(
        "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tmine', id, 'my laptop', 'h', 1 FROM users WHERE role = 'owner'",
      )
      .run();
    idb
      .prepare("UPDATE tokens SET revoked_at = 1 WHERE label = 'provision'")
      .run();
    rmSync(patPath(s, inst.appHost));
    const r = keep(await s.p.reissueOwnerToken(inst.id, inst.id));
    expect(r).toEqual({ id: inst.id, patFile: patPath(s, inst.appHost) });
    expect(statSync(r.patFile).mode & 0o777).toBe(0o600);
    const live = idb
      .prepare(
        "SELECT label FROM tokens WHERE revoked_at IS NULL ORDER BY label",
      )
      .all() as { label: string }[];
    expect(live.map((t) => t.label)).toEqual(["my laptop", "provision"]);
    expect(s.audit(inst.id)).toContain("owner_token.reissue");
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
    // The install is upgradable again (the pre-flight uses the new token).
    keep(await s.p.upgrade(inst.id, "0.24.0"));
    const pat = readFileSync(r.patFile, "utf8").trim();
    expect(JSON.stringify(s.p.notes)).not.toContain(pat);
    expect(
      JSON.stringify(s.db().prepare("SELECT * FROM hosted_audit").all()),
    ).not.toContain(pat);
  });

  it("a second reissue retires the first", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    keep(await s.p.reissueOwnerToken(inst.id, inst.id));
    keep(await s.p.reissueOwnerToken(inst.id, inst.id));
    const n = s
      .installDb(inst.id)
      .prepare(
        "SELECT count(*) AS n FROM tokens WHERE label = 'provision' AND revoked_at IS NULL",
      )
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("refuses a wrong confirm or an install that is not active with no write, and a held lease with no token minted", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const w = s.fake.writes().length;
    expect(
      (await fails(s.p.reissueOwnerToken(inst.id, "ibbbbbbbbbbb"))).message,
    ).toMatch(/confirm/);
    s.db()
      .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
      .run(inst.id);
    expect(await fails(s.p.reissueOwnerToken(inst.id, inst.id))).toBeInstanceOf(
      ProvisionRefused,
    );
    expect(s.fake.writes().length).toBe(w);
    s.db()
      .prepare(
        "UPDATE installs SET state = 'active', lease = 'x', lease_until = ? WHERE id = ?",
      )
      .run(Date.now() + 1e12, inst.id);
    const tokens = () =>
      s.installDb(inst.id).prepare("SELECT id, revoked_at FROM tokens").all();
    const before = tokens();
    // Busy is the claim's compare-and-swap losing: it changes nothing.
    expect(
      (await fails(s.p.reissueOwnerToken(inst.id, inst.id))).message,
    ).toMatch(/busy/);
    expect(tokens()).toEqual(before);
    expect(s.row(inst.id).lease).toBe("x");
  });
});

describe("OPS-B: the CI owner token (ciOwnerToken)", () => {
  const CI = { ciOwnerToken: { label: "ci-42" } };
  const tokens = (s: S, id: string) =>
    s
      .installDb(id)
      .prepare("SELECT id, label, revoked_at FROM tokens ORDER BY created_at")
      .all() as { id: string; label: string; revoked_at: number | null }[];
  const ciTokens = (s: S, id: string) =>
    tokens(s, id).filter((t) => t.label === "ci-42");
  const patFiles = (s: S) =>
    readdirSync(s.patDir).filter((f) => f.endsWith("-pat-token"));
  /** Raw request index of the first body matching `re`, from `from`. */
  const at = (s: S, re: RegExp, from = 0) =>
    s.fake.raw.findIndex((r, i) => i >= from && re.test(r.body));
  const MINT = /INSERT INTO tokens/;
  const REVOKE = /UPDATE tokens SET revoked_at = \?1 WHERE id = \?2/;
  const CLAIM = /UPDATE installs SET state = \?1, lease = \?2/;
  const FINISH = /lease = NULL, lease_until = NULL/;
  /** Mint after the claim, revoke before the lease is dropped. */
  const underLease = (s: S, from: number) => {
    const claim = at(s, CLAIM, from);
    const mint = at(s, MINT, from);
    const revoke = at(s, REVOKE, from);
    const finish = at(s, FINISH, from);
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(mint).toBeGreaterThan(claim);
    expect(revoke).toBeGreaterThan(mint);
    expect(finish).toBeGreaterThan(revoke);
  };
  /** MCP never answers: the process "crashes" between mint and revoke. */
  const hangMcp =
    (s: S): typeof fetch =>
    (u, init) =>
      String(u).endsWith("/mcp")
        ? new Promise<Response>(() => {})
        : s.fake.fetch(u, init);

  it("create: the selftest runs on a ci-<run> PAT minted under the lease and revoked before it is released; no PAT file, no provision token", async () => {
    const s = setup();
    const from = s.fake.raw.length;
    const inst = keep(await s.mk(CI).create(input()));
    expect(inst.patFile).toBeUndefined();
    expect(patFiles(s)).toEqual([]);
    const ts = tokens(s, inst.id);
    expect(ts.map((t) => t.label)).toEqual(["ci-42"]);
    expect(ts[0]?.revoked_at).not.toBeNull();
    // The selftest published the welcome artifact with it.
    expect(s.fake.artifacts.size).toBe(1);
    underLease(s, from);
    expect(s.audit(inst.id)).toEqual(
      expect.arrayContaining([
        "ci_token.mint",
        "ci_token.revoke",
        "create.active",
      ]),
    );
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("upgrade, rollback and updateVars: no PAT file is read; each mints its own ci token under the lease and revokes it", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    // The laptop PAT file is gone: CI never has one.
    rmSync(join(s.patDir, `${inst.appHost}-pat-token`));
    let from = s.fake.raw.length;
    expect(keep(await s.mk(CI).upgrade(inst.id, "0.24.0"))).toMatchObject({
      ok: true,
    });
    underLease(s, from);
    from = s.fake.raw.length;
    const back = keep(await s.mk(CI).rollback(inst.id));
    expect(back).toMatchObject({ ok: true, rolledBack: true });
    // The selftest ran (not skipped as with a refused PAT).
    expect(back.note).toBeUndefined();
    underLease(s, from);
    from = s.fake.raw.length;
    expect(
      keep(await s.mk(CI).updateVars(inst.id, { FEATURES: "beta" })),
    ).toMatchObject({ ok: true });
    underLease(s, from);
    const ci = ciTokens(s, inst.id);
    expect(ci).toHaveLength(3);
    expect(ci.every((t) => t.revoked_at !== null)).toBe(true);
    // The owner's provision token from the laptop create is untouched.
    expect(
      tokens(s, inst.id).filter(
        (t) => t.label === "provision" && t.revoked_at === null,
      ),
    ).toHaveLength(1);
    // Without the flag, the same upgrade still needs the PAT file.
    expect((await fails(s.p.upgrade(inst.id, "0.24.0"))).message).toMatch(
      /owner token file .* is missing/,
    );
  });

  it("a failed upgrade's automatic rollback selftests with the same ci token, then revokes it", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    unhealthyAt(s, "0.24.0");
    const r = keep(await s.mk(CI).upgrade(inst.id, "0.24.0"));
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    const ci = ciTokens(s, inst.id);
    expect(ci).toHaveLength(1);
    expect(ci[0]?.revoked_at).not.toBeNull();
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("an upgrade that fails after the mint still revokes the ci token before the lease is dropped", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const from = s.fake.raw.length;
    // The script upload is refused: the upgrade aborts after the mint.
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-[^/]+$/.test(p));
    await fails(s.mk(CI).upgrade(inst.id, "0.24.0"));
    const ci = ciTokens(s, inst.id);
    expect(ci).toHaveLength(1);
    expect(ci[0]?.revoked_at).not.toBeNull();
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
    underLease(s, from);
  });

  it("a revoke that fails is a note naming the sweep, never the token; the sweep then revokes and verifies it", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const flaky: typeof fetch = async (u, init) => {
      if (REVOKE.test(String(init?.body ?? "")))
        return Response.json(
          { success: false, errors: [{ code: 7500, message: "boom" }] },
          { status: 400 },
        );
      return s.fake.fetch(u, init);
    };
    const p = s.mk({ ...CI, cf: s.cfWith(flaky) });
    expect(keep(await p.upgrade(inst.id, "0.24.0"))).toMatchObject({
      ok: true,
    });
    expect(p.notes.join("\n")).toMatch(
      /CI owner token was not revoked .*ci-token-sweep revokes it/,
    );
    expect(
      ciTokens(s, inst.id).filter((t) => t.revoked_at === null),
    ).toHaveLength(1);
    expect(keep(await s.mk().ciTokenSweep(inst.id, "ci-42"))).toEqual({
      id: inst.id,
      label: "ci-42",
      revoked: 1,
      active: 0,
    });
    expect(ciTokens(s, inst.id).every((t) => t.revoked_at !== null)).toBe(true);
  });

  it("a crash between mint and revoke leaves the token live; ci-token-sweep revokes it, and a second sweep finds none", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    void s.mk({ ...CI, fetch: hangMcp(s) }).upgrade(inst.id, "0.24.0");
    // Wait until the upgrade is past the mint and stuck (the hang is at
    // the pre-upload MCP-free path's end: the health check or selftest).
    for (let i = 0; i < 5000 && s.row(inst.id).version !== "0.24.0"; i++)
      await new Promise((r) => setImmediate(r));
    expect(s.row(inst.id).version).toBe("0.24.0");
    const live = ciTokens(s, inst.id).filter((t) => t.revoked_at === null);
    expect(live).toHaveLength(1);
    // Another run's ci token and the owner's own tokens are left alone.
    s.installDb(inst.id)
      .prepare(
        "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tother', id, 'ci-7', 'h7', 1 FROM users WHERE role = 'owner'",
      )
      .run();
    const r = keep(await s.mk().ciTokenSweep(inst.id, "ci-42"));
    expect(r).toEqual({ id: inst.id, label: "ci-42", revoked: 1, active: 0 });
    expect(
      ciTokens(s, inst.id).filter((t) => t.revoked_at === null),
    ).toHaveLength(0);
    const rest = tokens(s, inst.id).filter((t) => t.label !== "ci-42");
    expect(rest.every((t) => t.revoked_at === null)).toBe(true);
    expect(rest.map((t) => t.label).sort()).toEqual(["ci-7", "provision"]);
    expect(s.audit(inst.id)).toContain("ci_token.sweep");
    expect(keep(await s.mk().ciTokenSweep(inst.id, "ci-42")).revoked).toBe(0);
  });

  it("the sweep verifies by reading again: a revoke that silently did nothing fails the sweep", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    s.installDb(inst.id)
      .prepare(
        "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tleft', id, 'ci-42', 'h42', 1 FROM users WHERE role = 'owner'",
      )
      .run();
    // The label UPDATE "succeeds" but changes nothing.
    const lossy: typeof fetch = async (u, init) => {
      const body = String(init?.body ?? "");
      if (/UPDATE tokens SET revoked_at = \?1 WHERE label = \?2/.test(body))
        return s.fake.fetch(u, {
          ...init,
          body: JSON.stringify({ sql: "SELECT 1", params: [] }),
        });
      return s.fake.fetch(u, init);
    };
    const e = await fails(
      s.mk({ cf: s.cfWith(lossy) }).ciTokenSweep(inst.id, "ci-42"),
    );
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(
      /1 owner token\(s\) labelled ci-42 are still active after the sweep/,
    );
  });

  it("the sweep refuses a malformed label or id, and a deleted install has nothing to sweep", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    for (const bad of ["ci-", "ci-0", "provision", "ci-42 OR 1=1", "ci-4x"])
      expect((await fails(s.p.ciTokenSweep(inst.id, bad))).message).toMatch(
        /ci-<run id>/,
      );
    expect(await fails(s.p.ciTokenSweep("not-an-id", "ci-42"))).toBeInstanceOf(
      ProvisionRefused,
    );
    keep(await s.p.delete(inst.id, inst.id, { skipDirectoryRevoke: "test" }));
    expect(keep(await s.p.ciTokenSweep(inst.id, "ci-42"))).toEqual({
      id: inst.id,
      label: "ci-42",
      revoked: 0,
      active: 0,
    });
  });

  it("a malformed ciOwnerToken label is refused before any call", async () => {
    const s = setup();
    for (const label of ["ci-", "provision", "ci-1;DROP", ""]) {
      const n = s.fake.log.length;
      const e = await fails(s.mk({ ciOwnerToken: { label } }).create(input()));
      expect(e.message).toMatch(/ci-<run id>/);
      expect(s.fake.log.length).toBe(n);
    }
  });

  // SS3: the hosted provisioner's label (ss-<signup ULID>) and no patDir.
  const SS_A = "ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0A";
  const SS_B = "ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0B";
  /** The options with no patDir at all (the provisioner Worker has no disk). */
  const noPatDir = (s: S, over: Partial<WfpOptions> = {}) => {
    const o = s.opts(over);
    delete (o as { patDir?: string }).patDir;
    const p = new WfpProvisioner(o);
    PROVS.push(p);
    return p;
  };

  it("no patDir with ciOwnerToken: create succeeds and nothing is written under any directory", async () => {
    const s = setup();
    const before = readdirSync(s.patDir);
    FSW.WRITES.length = 0;
    const inst = keep(
      await noPatDir(s, { ciOwnerToken: { label: SS_A } }).create(input()),
    );
    expect(inst.patFile).toBeUndefined();
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
    // A delete with no patDir has no file to remove.
    expect(
      keep(
        await noPatDir(s).delete(inst.id, inst.id, {
          skipDirectoryRevoke: "test",
        }),
      ),
    ).toMatchObject({ ok: true, state: "deleted" });
    // No node:fs write at all (no mkdir, open, write or rm), anywhere.
    expect(FSW.WRITES).toEqual([]);
    expect(readdirSync(s.patDir)).toEqual(before);
  });

  it("the file hook sees a laptop create's PAT write (the hook is live)", async () => {
    const s = setup();
    FSW.WRITES.length = 0;
    const inst = keep(await s.p.create(input()));
    expect(FSW.WRITES).toContain(
      `openSync ${join(s.patDir, `${inst.appHost}-pat-token`)}`,
    );
  });

  it("reissueOwnerToken with no patDir is refused before any write", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    const rows = tokens(s, inst.id);
    const n = s.fake.log.length;
    const e = await fails(noPatDir(s).reissueOwnerToken(inst.id, inst.id));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/patDir is required/);
    expect(s.fake.log.length).toBe(n);
    expect(tokens(s, inst.id)).toEqual(rows);
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
  });

  it("upgrade, rollback and updateVars of a test-hook install with ciOwnerToken need no patDir and write no file", async () => {
    const s = setup();
    const inst = keep(
      await s.p.create(
        input("redqa", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
      ),
    );
    FSW.WRITES.length = 0;
    const ci = { ciOwnerToken: { label: SS_A } };
    expect(
      keep(await noPatDir(s, ci).upgrade(inst.id, "0.24.0")),
    ).toMatchObject({ ok: true });
    expect(keep(await noPatDir(s, ci).rollback(inst.id))).toMatchObject({
      ok: true,
      rolledBack: true,
    });
    expect(
      keep(
        await noPatDir(s, ci).updateVars(inst.id, {
          ...HOOK_VARS,
          FEATURES: "beta",
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(FSW.WRITES).toEqual([]);
  });

  it("no patDir and no ciOwnerToken is refused before any call", async () => {
    const s = setup();
    const n = s.fake.log.length;
    const e = await fails(noPatDir(s).create(input()));
    expect(e).toBeInstanceOf(ProvisionRefused);
    expect(e.message).toMatch(/patDir is required/);
    expect(s.fake.log.length).toBe(n);
  });

  it("a ciOwnerToken redline create with no patDir succeeds and writes no file", async () => {
    const s = setup();
    const before = readdirSync(s.patDir);
    FSW.WRITES.length = 0;
    const inst = keep(
      await noPatDir(s, { ciOwnerToken: { label: SS_A } }).create(
        input("redqa", { testHooks: true, bundle: "redline", vars: HOOK_VARS }),
      ),
    );
    expect(inst.patFile).toBeUndefined();
    expect(s.row(inst.id)).toMatchObject({ state: "active", lease: null });
    expect(FSW.WRITES).toEqual([]);
    expect(readdirSync(s.patDir)).toEqual(before);
  });

  it("ss-<ULID> labels mint and sweep; other labels are refused", async () => {
    const s = setup();
    const inst = keep(
      await s.mk({ ciOwnerToken: { label: SS_A } }).create(input()),
    );
    const ss = tokens(s, inst.id).filter((t) => t.label === SS_A);
    expect(ss).toHaveLength(1);
    expect(ss[0]?.revoked_at).not.toBeNull();
    s.installDb(inst.id)
      .prepare(
        `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tss', id, '${SS_A}', 'hss', 1 FROM users WHERE role = 'owner'`,
      )
      .run();
    expect(keep(await s.p.ciTokenSweep(inst.id, SS_A))).toEqual({
      id: inst.id,
      label: SS_A,
      revoked: 1,
      active: 0,
    });
    for (const bad of [
      "ss-short",
      `ss-${"a".repeat(26)}`,
      "ci-abc",
      `ss-${"0".repeat(25)}I`,
      `${SS_A}0`,
    ]) {
      const n = s.fake.log.length;
      const e = await fails(
        s.mk({ ciOwnerToken: { label: bad } }).create(input("other")),
      );
      expect(e.message, bad).toMatch(/ci-<run id> or ss-<ULID>/);
      expect(s.fake.log.length).toBe(n);
      expect(
        (await fails(s.p.ciTokenSweep(inst.id, bad))).message,
        bad,
      ).toMatch(/ci-<run id> or ss-<ULID>/);
    }
  });

  it("a sweep revokes only its own exact label", async () => {
    const s = setup();
    const inst = keep(await s.p.create(input()));
    for (const [id, label] of [
      ["t1", "ci-123"],
      ["t2", "ci-1234"],
      ["t3", SS_A],
      ["t4", SS_B],
    ])
      s.installDb(inst.id)
        .prepare(
          `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT '${id}', id, '${label}', 'h${id}', 1 FROM users WHERE role = 'owner'`,
        )
        .run();
    const live = () =>
      tokens(s, inst.id)
        .filter((t) => t.revoked_at === null)
        .map((t) => t.label)
        .sort();
    expect(keep(await s.p.ciTokenSweep(inst.id, "ci-123")).revoked).toBe(1);
    expect(live()).toEqual(["ci-1234", "provision", SS_A, SS_B].sort());
    expect(keep(await s.p.ciTokenSweep(inst.id, SS_A)).revoked).toBe(1);
    expect(live()).toEqual(["ci-1234", "provision", SS_B].sort());
  });
});

// C3: the surface W2 builds on. pause/unpause bodies are W2's; until then
// they check their arguments and refuse before any Cloudflare call.
describe("pause, unpause and the W2 options (5.4, 5.5)", () => {
  const ID = "iabcdefghjkm";
  it.each([
    [
      "pause",
      (p: WfpProvisioner) => p.pause(ID, "paused", { kind: "suspend" }),
    ],
    [
      "pause closed",
      (p: WfpProvisioner) => p.pause(ID, "closed", { kind: "delete" }),
    ],
    ["unpause", (p: WfpProvisioner) => p.unpause(ID, { kind: "resume" })],
  ])(
    "%s is declared and refuses before any call until W2 builds it",
    async (_n, call) => {
      const s = setup();
      const n = s.fake.log.length;
      const e = await fails(call(s.p));
      expect(e.message).toMatch(/not built yet/);
      expect(s.fake.log.length).toBe(n);
    },
  );

  it("pause refuses a bad id or a mode other than paused or closed", async () => {
    const s = setup();
    const n = s.fake.log.length;
    const kind = { kind: "suspend" } as const;
    expect((await fails(s.p.pause("nope", "paused", kind))).message).toMatch(
      /not an install id/,
    );
    for (const mode of ["serving", "unmapped", ""])
      expect(
        (await fails(s.p.pause(ID, mode as "paused", kind))).message,
      ).toMatch(/mode must be paused or closed/);
    expect(
      (await fails(s.p.unpause("nope", { kind: "resume" }))).message,
    ).toMatch(/not an install id/);
    for (const bad of [undefined, {}, { kind: "nope" }]) {
      expect(
        (await fails(s.p.pause(ID, "paused", bad as never))).message,
      ).toMatch(/unknown job kind/);
      expect((await fails(s.p.unpause(ID, bad as never))).message).toMatch(
        /unknown job kind/,
      );
    }
    expect(s.fake.log.length).toBe(n);
  });

  it("onStep must be a function and registryDisabled a boolean, checked before any call", async () => {
    const s = setup();
    const n = s.fake.log.length;
    for (const over of [
      { onStep: "upload" },
      { onStep: 1 },
      { registryDisabled: "yes" },
      { registryDisabled: 1 },
    ]) {
      const e = await fails(
        s.mk(over as unknown as Partial<WfpOptions>).create(input()),
      );
      expect(e.message).toMatch(/onStep|registryDisabled/);
    }
    expect(s.fake.log.length).toBe(n);
  });

  it("onStep and registryDisabled: true are refused before any call until W2 wires them", async () => {
    const s = setup();
    const n = s.fake.log.length;
    for (const over of [
      { onStep: () => {} },
      { registryDisabled: true },
    ] as Partial<WfpOptions>[]) {
      const e = await fails(s.mk(over).create(input()));
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(/not built yet \(W2\)/);
    }
    expect(s.fake.log.length).toBe(n);
  });

  it("a create with registryDisabled: false still succeeds", async () => {
    const s = setup();
    expect(
      keep(await s.mk({ registryDisabled: false }).create(input())),
    ).toMatchObject({ slug: "finqore" });
  });
});

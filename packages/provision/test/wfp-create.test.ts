import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Sqlite } from "node:sqlite";
import { isPat } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { packUstar } from "../../../scripts/ci/release-artifact.mjs";
import { assetHash, CfError, cfClient, type Target } from "../src/cf.js";
import * as INDEX from "../src/index.js";
import { RELEASE_PUBKEY_PLACEHOLDER } from "../src/internal/gates.js";
import { loadTemplate } from "../src/internal/template.js";
import {
  HOSTED_ADDED,
  type Template,
  userWorkerMetadata,
} from "../src/metadata.js";
import {
  ENV_PREFIX,
  type Env,
  hosts as hostsOf0,
  platformNames,
  registryKey,
} from "../src/names.js";
import { canonicalJson, inputsHash } from "../src/platform.js";
import {
  FLOOR_KEY,
  probeR2Conditionals,
  publishRelease,
  r2ReleaseReader,
} from "../src/publish.js";
import {
  assetEntries,
  bundleSha256,
  compareVersions,
  migrationsSha256,
  type ReleaseAsset,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  readTreeHardened,
  type SignedReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "../src/release.js";
import {
  assertBrokerOrigin,
  assertSessionSecret,
  brokerKid,
  brokerOrigin,
  HOSTED_DOMAINS,
  hostsKvTitle,
  NAMESPACES,
  ProdLocked,
  ProvisionRefused,
  type WfpOptions,
  WfpProvisioner,
} from "../src/wfp.js";
import { type FakeCf as Fake, FakeCf, splitSql } from "./fake-cf.js";

const hostsOf = (slug: string) =>
  hostsOf0(slug, { app: "app.test", content: "content.test" });

// Every generated secret, PAT and broker private key is captured at the
// generator, so values that were generated and then discarded (resumes,
// rotations, superseded PATs) are scanned too.
const H = vi.hoisted(() => {
  /** Every path read through node:fs, to prove the local checkout is never read. */
  const READS: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: wraps overloaded fs functions
  const recordReads = (m: any, fns: string[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: overloaded
    const out: Record<string, any> = {};
    for (const f of fns)
      out[f] = (p: unknown, ...a: unknown[]) => {
        READS.push(p instanceof URL ? p.pathname : String(p));
        return m[f](p, ...a);
      };
    return { ...m, ...out, default: { ...m, ...out } };
  };
  return { SENSITIVE: new Set<string>(), READS, recordReads };
});
vi.mock("node:fs", async (orig) =>
  H.recordReads(await orig(), ["readFileSync", "readdirSync", "openSync"]),
);
vi.mock("node:fs/promises", async (orig) =>
  H.recordReads(await orig(), ["readFile", "readdir", "lstat", "open"]),
);
// The sealed gates (src/internal/gates.ts): tests flip them here; no option can.
const G = vi.hoisted(() => ({
  PROD_UNLOCKED: true,
  ALLOW_ACCOUNT_TARGET: true,
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
  FLOOR_MIN_SEQ: { staging: 1, prod: 1 } as Record<string, number>,
}));
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
/** Runs fn with one gate set, then restores it. */
async function withGate<K extends keyof typeof G>(
  k: K,
  v: (typeof G)[K],
  fn: () => Promise<void>,
) {
  const before = G[k];
  G[k] = v;
  try {
    await fn();
  } finally {
    G[k] = before;
  }
}
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
vi.mock("node:crypto", async (orig) => {
  const m = await orig<typeof import("node:crypto")>();
  // biome-ignore lint/suspicious/noExplicitAny: wraps an overloaded function
  const generateKeyPairSync = (...a: any[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: overloaded
    const kp = (m.generateKeyPairSync as any)(...a);
    H.SENSITIVE.add(
      kp.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64url"),
    );
    return kp;
  };
  return { ...m, default: { ...m, generateKeyPairSync }, generateKeyPairSync };
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

const NOW = Date.parse("2026-10-22T00:00:00Z");
const ROOT = new URL("../../../", import.meta.url);
// Every platform D1 migration, in order (0002 adds the release_floor cache).
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
const EMAILS = new Set([OWNER, "someone@else.test"]);
const HOOK_VARS = { TEST_DOMAIN: "redline.test" };

const THROWN: string[] = [];
const PRINTABLE: string[] = [];
const FAKES: Fake[] = [];
const PROVS: WfpProvisioner[] = [];

async function fails(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    THROWN.push(String((e as Error).message), String(e), JSON.stringify(e));
    return e as Error;
  }
  throw new Error("expected a failure");
}

const enc = (s: string) => new TextEncoder().encode(s);

function makeBundle(
  variant: "release" | "redline",
  version = "0.23.0",
): {
  modules: { name: string; type: "esm" | "wasm"; bytes: Uint8Array }[];
  mainModule: string;
  version: string;
} {
  return {
    modules: [
      {
        name: "index.js",
        type: "esm",
        bytes: enc(
          `const hooksAllowed = ${variant === "redline"};\nexport default { fetch() { return new Response(String(hooksAllowed)); } };\n`,
        ),
      },
    ],
    mainModule: "index.js",
    version,
  };
}

// The release's own files (what T3b will put in oa-<p>-releases). Read here
// once from this checkout as fixtures; create itself must never read them.
const TEMPLATE_BYTES = new Uint8Array(
  readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
);
const MIGRATION_FILES: ReleaseFile[] = SERVER_MIGRATIONS.map((name) => ({
  name,
  bytes: new Uint8Array(
    readFileSync(new URL(`apps/server/migrations/${name}`, ROOT)),
  ),
}));
const ASSETS: ReleaseAsset[] = [
  { path: "index.html", bytes: enc("<!doctype html><p>hi</p>") },
  { path: "app.js", bytes: enc("console.log(1)") },
];

/** Release content; a Template object is serialized to the template bytes. */
type ReleaseSpec = {
  env?: Env;
  welcome?: Uint8Array;
  template?: Template | Uint8Array;
  migrations?: ReleaseFile[];
  assets?: ReleaseAsset[];
  floor?: unknown;
};
const tplBytes = (t: ReleaseSpec["template"]) =>
  t === undefined
    ? TEMPLATE_BYTES
    : t instanceof Uint8Array
      ? t
      : enc(JSON.stringify(t, null, 2));

// The release signing keypair of these tests (T3b holds the real one).
const SIGNER = generateKeyPairSync("ed25519");
const OTHER_SIGNER = generateKeyPairSync("ed25519");
for (const k of [SIGNER, OTHER_SIGNER]) {
  SENSITIVE.add(
    k.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  );
  SENSITIVE.add(k.privateKey.export({ format: "jwk" }).d as string);
}
const pubX = (k: { publicKey: KeyObject }) =>
  k.publicKey.export({ format: "jwk" }).x as string;
const TEST_PUBKEY = pubX(SIGNER);
// One key for both envs on purpose: domain separation must still hold (F2).
G.RELEASE_PUBKEY = { staging: TEST_PUBKEY, prod: TEST_PUBKEY };

/** The signed bytes: "oa-release-v1\n" + env + "\n" + the stored record string. */
const payloadOf = (record: string, env: string) =>
  Buffer.from(`oa-release-v1\n${env}\n${record}`);
/** The stored form (T3b): the record as its canonical JSON string, and the signature over it. */
const signRecord = (
  record: ReleaseRecord,
  key: KeyObject = SIGNER.privateKey,
  env: string = record.env,
): SignedReleaseRecord => {
  const s = canonicalJson(record);
  return {
    record: s,
    signature: sign(null, payloadOf(s, env), key).toString("base64url"),
  };
};
/** A stored record with one field replaced after signing. */
const tamper = (g: SignedReleaseRecord, over: Record<string, unknown>) => ({
  ...g,
  record: canonicalJson({ ...JSON.parse(g.record), ...over }),
});

/** The env's signed floor (releases/floor.json). */
type Floor = {
  env: string;
  seq: number;
  minVersion: string;
  revoked: string[];
};
const floorOf = (o: Partial<Floor> = {}, env: string = "staging"): Floor => ({
  env,
  seq: 1,
  minVersion: "0.1.0",
  revoked: [],
  ...o,
});
const signFloor = (
  f: Floor,
  key: KeyObject = SIGNER.privateKey,
  env: string = f.env,
) => {
  const s = canonicalJson(f);
  return {
    record: s,
    signature: sign(
      null,
      Buffer.from(`oa-release-floor-v1\n${env}\n${s}`),
      key,
    ).toString("base64url"),
  };
};

const WELCOME_BYTES = enc(
  "# Welcome to Open Artifacts\n\nThis text comes from the release (sentinel-from-release).\n",
);

/** The per-release manifest the bundle step (T3b) will write. */
const recordOf = (
  variant: "release" | "redline",
  version = "0.23.0",
  spec: ReleaseSpec = {},
): ReleaseRecord => ({
  env: spec.env ?? "staging",
  version,
  variant,
  sha256: bundleSha256(makeBundle(variant, version)),
  defines: { [TEST_HOOKS_DEFINE]: variant === "redline" },
  assets: assetEntries(spec.assets ?? ASSETS),
  templateSha256: createHash("sha256")
    .update(tplBytes(spec.template))
    .digest("hex"),
  migrationsSha256: migrationsSha256(spec.migrations ?? MIGRATION_FILES),
  welcomeSha256: createHash("sha256")
    .update(spec.welcome ?? WELCOME_BYTES)
    .digest("hex"),
});

type Kind =
  | "record"
  | "modules"
  | "assets"
  | "template"
  | "migrations"
  | "welcome"
  | "floor";
/** An in-memory release reader that counts reads; `over` replaces any read. */
function makeRelease(
  spec: ReleaseSpec = {},
  over: Partial<ReleaseReader> = {},
): ReleaseReader & { calls: Record<Kind, number> } {
  const calls: Record<Kind, number> = {
    record: 0,
    modules: 0,
    assets: 0,
    template: 0,
    migrations: 0,
    welcome: 0,
    floor: 0,
  };
  const base: ReleaseReader = {
    record: async (version, v) => signRecord(recordOf(v, version, spec)),
    modules: async (version, v) => {
      const b = makeBundle(v, version);
      return { mainModule: b.mainModule, modules: b.modules };
    },
    assets: async () =>
      (spec.assets ?? ASSETS).map((a) => ({ ...a, bytes: a.bytes.slice() })),
    template: async () => tplBytes(spec.template).slice(),
    migrations: async () =>
      (spec.migrations ?? MIGRATION_FILES).map((f) => ({
        ...f,
        bytes: f.bytes.slice(),
      })),
    welcome: async () => (spec.welcome ?? WELCOME_BYTES).slice(),
    floor: async () =>
      spec.floor !== undefined
        ? spec.floor
        : signFloor(floorOf({}, spec.env ?? "staging")),
  };
  const counted = (k: Kind) =>
    // biome-ignore lint/suspicious/noExplicitAny: forwards each reader's own args
    (async (...a: any[]) => {
      calls[k]++;
      // biome-ignore lint/suspicious/noExplicitAny: forwards each reader's own args
      return ((over[k] ?? base[k]) as any)(...a);
    }) as never;
  return {
    calls,
    record: counted("record"),
    modules: counted("modules"),
    assets: counted("assets"),
    template: counted("template"),
    migrations: counted("migrations"),
    welcome: counted("welcome"),
    floor: counted("floor"),
  };
}

/** The first `after` reads are the good ones, every later read the other. */
const swapAfterFirst = <T>(
  good: () => Promise<T>,
  evil: () => Promise<T>,
  after = 1,
) => {
  let n = 0;
  return () => (++n <= after ? good() : evil());
};

const TS = {
  staging: { sitekey: "0x4AAAAAAAstagingSITEKEY", secret: "" },
  prod: { sitekey: "0x4AAAAAAAprodSITEKEYxx", secret: "" },
};
TS.staging.secret = `0x4AAAAAAAts-secret-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
TS.prod.secret = `0x4AAAAAAAts-secret-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 24)}`;
SENSITIVE.add(TS.staging.secret);
SENSITIVE.add(TS.prod.secret);
const CODES = { AUTH_PROVIDERS: "email" };

type SetupOpts = {
  env?: Env;
  target?: Target;
  brokerEnabled?: boolean;
  release?: ReleaseReader;
  seed?: boolean;
};

function setup(o: SetupOpts = {}) {
  const fake = new FakeCf({ now: NOW });
  FAKES.push(fake);
  SENSITIVE.add(fake.token);
  const env = o.env ?? "staging";
  const seed = o.seed ?? true;
  const pdb = seed ? fake.seedD1(platformNames(env).db, PLATFORM_SQL) : "";
  const hostsId = seed ? fake.seedKv(hostsKvTitle(env)) : "";
  const regId = seed ? fake.seedKv(platformNames(env).registry) : "";
  const dirId = seed ? fake.seedKv(platformNames(env).directoryRegistry) : "";
  // The one Turnstile widget of each env (Task 8 creates it once per env).
  for (const e of ["staging", "prod"] as const)
    fake.turnstile.set(TS[e].sitekey, {
      sitekey: TS[e].sitekey,
      name: platformNames(e).turnstile,
      domains: [HOSTED_DOMAINS[e].app],
      mode: "managed",
      // The real GET returns the widget secret too.
      secret: TS[e].secret,
    });
  const target: Target = o.target ?? { kind: "namespace", ns: NAMESPACES[env] };
  fake.dispatch = {
    hostsKvId: hostsId,
    ns: target.kind === "namespace" ? target.ns : null,
  };
  const patDir = mkdtempSync(join(tmpdir(), "oa-t4-pat-"));
  let t = NOW;
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const release = o.release ?? makeRelease({ env });
  const opts = (over: Partial<WfpOptions> = {}): WfpOptions => ({
    cf,
    env,
    target,
    domains: HOSTED_DOMAINS[env],
    release,
    patDir,
    brokerEnabled: o.brokerEnabled ?? false,
    fetch: fake.fetch,
    now: clock.now,
    sleep: clock.sleep,
    turnstile: TS[env],
    ...over,
  });
  const mk = (over: Partial<WfpOptions> = {}) => {
    const p = new WfpProvisioner(opts(over));
    PROVS.push(p);
    return p;
  };
  const db = () => (fake.d1.get(pdb) as { db: DatabaseSync }).db;
  // biome-ignore lint/suspicious/noExplicitAny: test rows
  const rows = () => db().prepare("SELECT * FROM installs").all() as any[];
  const scriptOf = (id: string) =>
    fake.script(
      target.kind === "namespace" ? target.ns : null,
      `${ENV_PREFIX[env]}${id}`,
    );
  return {
    fake,
    env,
    p: mk(),
    mk,
    opts,
    pdb,
    hostsId,
    regId,
    dirId,
    patDir,
    release,
    target,
    db,
    rows,
    scriptOf,
    clock,
  };
}

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
const hookInput = (slug = "redqa") =>
  input(slug, { testHooks: true, bundle: "redline", vars: HOOK_VARS });

const nonReads = (fake: Fake, from = 0) => fake.writes().slice(from);

const uploads = (fake: Fake) =>
  fake.log
    .map((e, i) => ({ ...e, body: fake.raw[i]?.body ?? "" }))
    .filter((e) => e.method === "PUT" && /\/scripts\/[^/?]+$/.test(e.path));

function metaOf(body: string) {
  const m = body.match(
    /name="metadata"[^\n]*\r?\n(?:[^\n]*\r?\n)*?\r?\n(\{.*\})\r?\n/,
  );
  if (!m) throw new Error("no metadata part");
  return JSON.parse(m[1] as string);
}

const secretBindings = (meta: { bindings: { type: string; name: string }[] }) =>
  meta.bindings.filter((b) => b.type === "secret_text").map((b) => b.name);

/** Make /healthz unhealthy so a create stops after the upload. */
async function failAtHealth(s: ReturnType<typeof setup>, i = input(), p = s.p) {
  s.fake.health = () => ({ ok: false });
  const e = await fails(p.create(i));
  s.fake.health = undefined;
  return e;
}

const seedRow = (
  s: ReturnType<typeof setup>,
  r: {
    id: string;
    slug: string;
    app: string;
    content: string;
    state: string;
    rlNs?: number;
  },
) => {
  s.db()
    .prepare(
      "INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, state, rl_ns, created_at, updated_at) VALUES (?, ?, ?, ?, 'x@y.test', 'x', ?, ?, 1, 1)",
    )
    .run(r.id, r.slug, r.app, r.content, r.state, r.rlNs ?? 1_000_000);
  const h = s
    .db()
    .prepare("INSERT INTO hosts (host, install_id) VALUES (?, ?)");
  h.run(r.app, r.id);
  h.run(r.content, r.id);
};

// The template's latest DO migration tag, derived so a new server DO tag needs
// no edit here; pinned to the vN shape so a missing tag can't pass vacuously.
const lastTag = loadTemplate().migrations?.at(-1)?.tag;

describe("template DO migration tag", () => {
  it("is a vN tag", () => {
    expect(lastTag).toMatch(/^v\d+$/);
  });
});

describe("WfpProvisioner.create", () => {
  it("creates every resource named by install id and maps both hosts", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    PRINTABLE.push(JSON.stringify(inst));
    const [row] = s.rows();
    expect(row).toMatchObject({
      id: inst.id,
      slug: "finqore",
      app_host: "finqore.open-artifacts-staging.app",
      content_host: "finqore.open-artifacts-staging.page",
      state: "active",
      test_hooks: 0,
      version: "0.23.0",
      do_migration_tag: lastTag,
    });
    expect(
      s
        .db()
        .prepare("SELECT host FROM hosts WHERE install_id = ? ORDER BY host")
        .all(inst.id)
        .map((r) => (r as { host: string }).host),
    ).toEqual([
      "finqore.open-artifacts-staging.app",
      "finqore.open-artifacts-staging.page",
    ]);
    const n = `oa-s-${inst.id}`;
    expect([...s.fake.d1.values()].filter((d) => d.name === n)).toHaveLength(1);
    expect(row.d1_id).toBe(
      [...s.fake.d1.entries()].find(([, d]) => d.name === n)?.[0],
    );
    expect(s.fake.r2.has(n)).toBe(true);
    expect(row.kv_id).toBe(
      [...s.fake.kv.entries()].find(([, k]) => k.title === `${n}-oauth`)?.[0],
    );
    expect(s.fake.script("oa-staging", n)).toBeDefined();
    expect(s.fake.kvValues(s.hostsId).get(inst.appHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).get(inst.contentHost)).toBe(inst.id);
    expect(s.fake.kvValues(s.hostsId).size).toBe(2);
    const idb = s.fake.d1.get(row.d1_id)?.db as DatabaseSync;
    const applied = idb
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(applied).toEqual(SERVER_MIGRATIONS);
    expect(
      idb.prepare("SELECT role FROM users WHERE email = ?").get(OWNER),
    ).toEqual({ role: "owner" });
    expect(s.fake.artifacts.size).toBe(1);
    expect([...s.fake.artifacts.values()][0]?.title).toMatch(/Welcome/);
    const audit = s
      .db()
      .prepare(
        "SELECT action FROM hosted_audit WHERE install_id = ? ORDER BY id",
      )
      .all(inst.id)
      .map((r) => (r as { action: string }).action);
    expect(audit[0]).toBe("create.start");
    expect(audit.at(-1)).toBe("create.active");
    expect(inst).toMatchObject({
      slug: "finqore",
      appHost: "finqore.open-artifacts-staging.app",
      contentHost: "finqore.open-artifacts-staging.page",
      version: "0.23.0",
      patFile: join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
    });
  });

  it("namespace target: every script call uses the dispatch route and the subdomain API is never called", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    const scriptCalls = s.fake.log.filter(
      (e) => e.path.includes(`oa-s-${inst.id}`) && e.path.includes("/workers/"),
    );
    expect(scriptCalls.length).toBeGreaterThan(0);
    for (const e of scriptCalls)
      expect(e.path).toContain(
        "/workers/dispatch/namespaces/oa-staging/scripts/",
      );
    expect(s.fake.log.some((e) => e.path.endsWith("/subdomain"))).toBe(false);
    expect(s.fake.log.some((e) => e.status === 405)).toBe(false);
  });

  it("account target: script calls use /workers/scripts and the subdomain API turns workers.dev and previews off", async () => {
    const s = setup({ target: { kind: "account" } });
    const inst = await s.p.create(input());
    const sc = s.fake.script(null, `oa-s-${inst.id}`);
    expect(sc?.subdomain).toEqual({ enabled: false, previews_enabled: false });
    expect(s.fake.log.some((e) => e.path.includes("/dispatch/"))).toBe(false);
    const up = s.fake.log.findIndex(
      (e) =>
        e.method === "PUT" &&
        e.path.endsWith(`/workers/scripts/oa-s-${inst.id}`),
    );
    const sub = s.fake.log.findIndex((e) =>
      e.path.endsWith(`/workers/scripts/oa-s-${inst.id}/subdomain`),
    );
    expect(up).toBeGreaterThanOrEqual(0);
    expect(sub).toBeGreaterThan(up);
  });

  it("account target: every later upload calls the subdomain API again", async () => {
    const s = setup({ target: { kind: "account" } });
    await failAtHealth(s);
    const [row] = s.rows();
    s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    expect(uploads(s.fake)).toHaveLength(2);
    expect(
      s.fake.log.filter((e) => e.path.endsWith("/subdomain")),
    ).toHaveLength(2);
  });

  it("an upgrade that introduces DIRECTORY_TOKEN_KEY sends only that secret binding, with keep_bindings, and leaves the others untouched", async () => {
    const s = setup();
    await failAtHealth(s);
    const [row] = s.rows();
    const sc = s.scriptOf(row.id);
    if (!sc) throw new Error("no script");
    const before = new Map(sc.secrets);
    sc.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    const ups = uploads(s.fake);
    expect(ups).toHaveLength(2);
    const meta = metaOf(ups[1]?.body as string);
    expect(secretBindings(meta)).toEqual(["DIRECTORY_TOKEN_KEY"]);
    expect(meta.keep_bindings).toEqual(expect.arrayContaining(["secret_text"]));
    const after = s.scriptOf(row.id)?.secrets as Map<string, string>;
    expect(after.get("SESSION_SECRET")).toBe(before.get("SESSION_SECRET"));
    expect(after.get("CONTENT_SIGNING_KEY")).toBe(
      before.get("CONTENT_SIGNING_KEY"),
    );
    expect(after.get("DIRECTORY_TOKEN_KEY")).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(after.get("DIRECTORY_TOKEN_KEY")).not.toBe(
      before.get("DIRECTORY_TOKEN_KEY"),
    );
  });

  describe("resume by slug", () => {
    it("a creating row is resumed with the same id", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      expect(row.state).toBe("creating");
      const inst = await s.p.create(input());
      expect(inst.id).toBe(row.id);
      expect(s.rows()).toHaveLength(1);
      expect(s.rows()[0].rl_ns).toBe(row.rl_ns);
    });

    it("resumeId resumes that row; a resumeId of another slug is refused", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("other", { resumeId: row.id })));
      expect(e.message).toMatch(/resume/);
      expect(nonReads(s.fake, n)).toEqual([]);
      const inst = await s.p.create(input("finqore", { resumeId: row.id }));
      expect(inst.id).toBe(row.id);
    });

    it("an active slug fails before any Cloudflare write", async () => {
      const s = setup();
      await s.p.create(input());
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/already exists|active/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });

    it.each([
      ["owner", { ownerEmail: "someone@else.test" }],
      ["vars", { vars: { EMAIL_DAILY_CAP: "5" } }],
      [
        "testHooks",
        { testHooks: true, bundle: "redline" as const, vars: HOOK_VARS },
      ],
    ])(
      "a resume with a different %s is refused before any Cloudflare write",
      async (_k, over) => {
        const s = setup();
        s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
        await fails(s.p.create(input()));
        const n = s.fake.writes().length;
        const e = await fails(s.p.create(input("finqore", over)));
        expect(e.message).toMatch(/inputs/);
        expect(nonReads(s.fake, n)).toEqual([]);
        expect(s.rows()[0].inputs_hash).toBe(
          inputsHash({ ownerEmail: OWNER, vars: {}, testHooks: false }),
        );
      },
    );

    it("the owner email is normalized (trim, lowercase), so a resume in other casing is the same input", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(
        s.p.create(input("finqore", { ownerEmail: " Owner@FinQore.TEST " })),
      );
      expect(s.rows()[0].owner_email).toBe(OWNER);
      const inst = await s.p.create(input());
      const owner = s
        .scriptOf(inst.id)
        ?.metadata.bindings.find(
          (b: { name: string }) => b.name === "OWNER_EMAIL",
        );
      expect(owner.text).toBe(OWNER);
    });
  });

  describe("resume heals the hosts table (N1)", () => {
    const hostRows = (s: ReturnType<typeof setup>, id: string) =>
      s
        .db()
        .prepare("SELECT host FROM hosts WHERE install_id = ? ORDER BY host")
        .all(id)
        .map((r) => (r as { host: string }).host);

    it("a row without its hosts rows resumes, and both hosts rows end up present", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      s.db().prepare("DELETE FROM hosts WHERE install_id = ?").run(row.id);
      expect(hostRows(s, row.id)).toEqual([]);
      await s.p.create(input());
      expect(hostRows(s, row.id)).toEqual([
        "finqore.open-artifacts-staging.app",
        "finqore.open-artifacts-staging.page",
      ]);
    });

    it("a resume whose host is held by another install in the hosts table is refused before any write", async () => {
      const s = setup();
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "other",
        app: "other.open-artifacts-staging.app",
        content: "other.open-artifacts-staging.page",
        state: "active",
        rlNs: 1_999_992,
      });
      s.db().prepare("DELETE FROM hosts WHERE install_id = ?").run(row.id);
      s.db()
        .prepare(
          "INSERT INTO hosts (host, install_id) VALUES (?, 'iaaaaaaaaaaa')",
        )
        .run("finqore.open-artifacts-staging.page");
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });
  });

  describe("resources are resolved by name, never trusted from ids (H1)", () => {
    it("a missing staging platform D1 is refused with zero writes, even when the prod one exists", async () => {
      const s = setup({ seed: false });
      s.fake.seedD1(platformNames("prod").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("staging"));
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-platform/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a missing staging HOSTS KV is refused with zero writes, even when the prod one exists", async () => {
      const s = setup({ seed: false });
      s.fake.seedD1(platformNames("staging").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("prod"));
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-hosts/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a missing staging broker registry is refused with zero writes", async () => {
      const s = setup({ seed: false, brokerEnabled: true });
      s.fake.seedD1(platformNames("staging").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("staging"));
      s.fake.seedKv(platformNames("prod").registry);
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/oa-s-broker-registry/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("H-DR: a missing staging directory registry is refused with zero writes", async () => {
      const s = setup({ seed: false, brokerEnabled: true });
      s.fake.seedD1(platformNames("staging").db, PLATFORM_SQL);
      s.fake.seedKv(hostsKvTitle("staging"));
      s.fake.seedKv(platformNames("staging").registry);
      s.fake.seedKv(platformNames("prod").directoryRegistry);
      const e = await fails(s.p.create(input()));
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e.message).toMatch(
        /directory registry KV oa-s-directory-registry not found/,
      );
      expect(s.fake.writes()).toEqual([]);
    });

    it("a staging create only ever touches the staging platform ids", async () => {
      const s = setup({ brokerEnabled: true });
      const prodDb = s.fake.seedD1(platformNames("prod").db, PLATFORM_SQL);
      const prodHosts = s.fake.seedKv(hostsKvTitle("prod"));
      const prodReg = s.fake.seedKv(platformNames("prod").registry);
      const prodDir = s.fake.seedKv(platformNames("prod").directoryRegistry);
      await s.p.create(input());
      for (const id of [prodDb, prodHosts, prodReg, prodDir])
        expect(s.fake.log.some((e) => e.path.includes(id))).toBe(false);
    });

    it("a row whose d1_id belongs to another install is refused before any write", async () => {
      const s = setup();
      const a = await s.p.create(input("alpha"));
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input("beta")));
      const beta = s.rows().find((r) => r.slug === "beta");
      const alpha = s.rows().find((r) => r.id === a.id);
      expect(beta.d1_id).toBeTruthy();
      s.db()
        .prepare("UPDATE installs SET d1_id = ? WHERE id = ?")
        .run(alpha.d1_id, beta.id);
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("beta")));
      expect(e.message).toMatch(/d1_id/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });

    it("a row whose kv_id belongs to another install is refused before any write", async () => {
      const s = setup();
      const a = await s.p.create(input("alpha"));
      await failAtHealth(s, input("beta"));
      const beta = s.rows().find((r) => r.slug === "beta");
      const alpha = s.rows().find((r) => r.id === a.id);
      s.db()
        .prepare("UPDATE installs SET kv_id = ? WHERE id = ?")
        .run(alpha.kv_id, beta.id);
      const n = s.fake.writes().length;
      const e = await fails(s.p.create(input("beta")));
      expect(e.message).toMatch(/kv_id/);
      expect(nonReads(s.fake, n)).toEqual([]);
    });
  });

  describe("broker keypair (brokerEnabled)", () => {
    const regPuts = (s: ReturnType<typeof setup>) =>
      s.fake.log
        .map((e, i) => ({ ...e, body: s.fake.raw[i]?.body ?? "" }))
        .filter(
          (e) =>
            e.method === "PUT" &&
            e.path.includes(`/namespaces/${s.regId}/values/`),
        );

    it("stays consistent across failures between add, upload and removal", async () => {
      const s = setup({ brokerEnabled: true });
      s.fake.inject((m, p) => m === "PUT" && p.endsWith("/secrets"), {
        status: 400,
      });
      await fails(s.p.create(input()));
      const [row1] = s.rows();
      const reg = () =>
        JSON.parse(
          s.fake.kvValues(s.regId).get(registryKey(row1.id)) as string,
        );
      expect(reg().keys).toHaveLength(1);
      expect(row1.broker_kid).toBeNull();
      const before = regPuts(s).length;
      s.fake.inject(
        (m, p) => m === "PUT" && p.includes(`/namespaces/${s.regId}/values/`),
        { status: 400, skip: 1 },
      );
      await fails(s.p.create(input()));
      expect(regPuts(s).length).toBe(before + 2);
      const [row2] = s.rows();
      expect(row2.broker_kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(reg().keys).toHaveLength(2);
      const inst = await s.p.create(input());
      const [row3] = s.rows();
      const entry = reg();
      expect(entry.keys).toHaveLength(1);
      expect(entry.keys[0].kid).toBe(row3.broker_kid);
      expect(brokerKid(entry.keys[0].x)).toBe(entry.keys[0].kid);
      const digest = createHash("sha256")
        .update(Buffer.from(entry.keys[0].x, "base64url"))
        .digest("base64url");
      expect(entry.keys[0].kid).toBe(digest.slice(0, 16));
      for (const p of regPuts(s))
        if (p.status === 200)
          expect(JSON.parse(p.body).keys.length).toBeLessThanOrEqual(2);
      const sk = s
        .scriptOf(inst.id)
        ?.secrets.get("BROKER_SIGNING_KEY") as string;
      expect(SENSITIVE.has(sk)).toBe(true);
      const priv = createPrivateKey({
        key: Buffer.from(sk, "base64url"),
        format: "der",
        type: "pkcs8",
      });
      const pub = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: entry.keys[0].x },
        format: "jwk",
      });
      const msg = Buffer.from("broker round trip");
      expect(verify(null, msg, pub, sign(null, msg, priv))).toBe(true);
      expect(Buffer.from(entry.keys[0].x, "base64url")).toHaveLength(32);
    });

    it("writes exactly one entry with the exact origin and no secret, private key or email", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(input());
      const reg = s.fake.kvValues(s.regId);
      // The key the auth broker reads (apps/auth-broker/src/registry.ts).
      expect([...reg.keys()]).toEqual([`install:${inst.id}`]);
      const raw = reg.get(registryKey(inst.id)) as string;
      const entry = JSON.parse(raw);
      expect(Object.keys(entry).sort()).toEqual([
        "domains",
        "installId",
        "keys",
        "origin",
      ]);
      // No AUTH_DOMAINS: always written, empty.
      expect(entry.domains).toEqual([]);
      expect(entry.installId).toBe(inst.id);
      expect(entry.origin).toBe("https://finqore.open-artifacts-staging.app");
      expect(Object.keys(entry.keys[0]).sort()).toEqual(["kid", "x"]);
      expect(raw).not.toContain(OWNER);
      for (const v of s.scriptOf(inst.id)?.secrets.values() ?? [])
        expect(raw).not.toContain(v);
    });

    it("H-DR: create writes the identical entry to the directory registry, after the broker registry", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(input());
      const raw = s.fake.kvValues(s.regId).get(registryKey(inst.id)) as string;
      expect(raw).toBeTruthy();
      expect(s.fake.kvValues(s.dirId).get(registryKey(inst.id))).toBe(raw);
      // The same key the broker reads: install:<id> (registryKey).
      expect([...s.fake.kvValues(s.dirId).keys()]).toEqual([
        `install:${inst.id}`,
      ]);
      // Every directory put follows a broker put of the same body.
      const puts = s.fake.log
        .map((e, i) => ({ ...e, body: s.fake.raw[i]?.body ?? "" }))
        .filter(
          (e) =>
            e.method === "PUT" &&
            (e.path.includes(`/namespaces/${s.regId}/values/`) ||
              e.path.includes(`/namespaces/${s.dirId}/values/`)),
        )
        .map((e) => ({ dir: e.path.includes(s.dirId), body: e.body }));
      expect(puts.length).toBe(4);
      for (let k = 0; k < puts.length; k += 2) {
        expect(puts[k]?.dir).toBe(false);
        expect(puts[k + 1]).toEqual({ dir: true, body: puts[k]?.body });
      }
      expect(await s.p.status(inst.id)).toMatchObject({ registryDrift: null });
    });

    it("H-DR: a failure between the broker and directory writes resumes to both", async () => {
      const s = setup({ brokerEnabled: true });
      // The final directory put (right after the final broker put) fails.
      s.fake.inject(
        (m, p) => m === "PUT" && p.includes(`/namespaces/${s.dirId}/values/`),
        { status: 400, skip: 1 },
      );
      const e = await fails(s.p.create(input()));
      expect(e.message).toContain(`/namespaces/${s.dirId}/values/`);
      const [row] = s.rows();
      expect(row.state).toBe("creating");
      expect(row.lease).toBeNull();
      expect(row.broker_kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
      const reg = s.fake.kvValues(s.regId).get(registryKey(row.id)) as string;
      expect(JSON.parse(reg).keys).toHaveLength(1);
      // Stand in for a copy that kept an older value (e.g. mid-rotation).
      s.fake
        .kvValues(s.dirId)
        .set(registryKey(row.id), reg.replace(/"x":"[^"]+"/, '"x":"AAAA"'));
      expect(await s.p.status(row.id)).toMatchObject({
        registryDrift: { id: row.id, kind: "mismatch" },
      });
      const inst = await s.p.create(input());
      expect(inst.id).toBe(row.id);
      // The broker entry was healthy, so it stays; only the copy is rewritten.
      expect(s.fake.kvValues(s.regId).get(registryKey(row.id))).toBe(reg);
      expect(s.fake.kvValues(s.dirId).get(registryKey(row.id))).toBe(reg);
      expect(await s.p.status(row.id)).toMatchObject({ registryDrift: null });
    });

    it("H-DR: a failure of the first directory write resumes to both", async () => {
      const s = setup({ brokerEnabled: true });
      s.fake.inject(
        (m, p) => m === "PUT" && p.includes(`/namespaces/${s.dirId}/values/`),
        { status: 400 },
      );
      await fails(s.p.create(input()));
      const [row] = s.rows();
      expect(s.fake.kvValues(s.regId).has(registryKey(row.id))).toBe(true);
      expect(s.fake.kvValues(s.dirId).has(registryKey(row.id))).toBe(false);
      expect(await s.p.status(row.id)).toMatchObject({
        registryDrift: { id: row.id, kind: "missing_directory" },
      });
      await s.p.create(input());
      const reg = s.fake.kvValues(s.regId).get(registryKey(row.id)) as string;
      expect(JSON.parse(reg).keys).toHaveLength(1);
      expect(s.fake.kvValues(s.dirId).get(registryKey(row.id))).toBe(reg);
    });

    it("H-DR: status reports each drift kind with a data-free shape and never repairs", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(input());
      expect((await s.p.status(inst.id)).registryDrift).toBeNull();
      const reg = s.fake.kvValues(s.regId);
      const dir = s.fake.kvValues(s.dirId);
      const raw = reg.get(registryKey(inst.id)) as string;
      const check = async (kind: string) => {
        const w = s.fake.writes().length;
        const st = await s.p.status(inst.id);
        expect(st.registryDrift).toEqual({ id: inst.id, kind });
        expect(JSON.stringify(st)).not.toContain(JSON.parse(raw).keys[0].x);
        expect(s.fake.writes().length).toBe(w);
      };
      dir.delete(registryKey(inst.id));
      await check("missing_directory");
      dir.set(registryKey(inst.id), raw);
      reg.delete(registryKey(inst.id));
      await check("missing_broker");
      reg.set(registryKey(inst.id), raw);
      dir.set(registryKey(inst.id), raw.replace(/"x":"[^"]+"/, '"x":"AAAA"'));
      await check("mismatch");
      // Report only: status left the drift in place.
      expect(dir.get(registryKey(inst.id))).not.toBe(raw);
    });

    it("H-DR: an install that should have an entry and is in neither registry is missing_both", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(input());
      s.fake.kvValues(s.regId).delete(registryKey(inst.id));
      s.fake.kvValues(s.dirId).delete(registryKey(inst.id));
      const w = s.fake.writes().length;
      expect((await s.p.status(inst.id)).registryDrift).toEqual({
        id: inst.id,
        kind: "missing_both",
      });
      expect(s.fake.writes().length).toBe(w);
      // L2: an install mid-upgrade owes its entry like an active one.
      s.db()
        .prepare("UPDATE installs SET state = 'upgrading' WHERE id = ?")
        .run(inst.id);
      expect((await s.p.status(inst.id)).registryDrift).toEqual({
        id: inst.id,
        kind: "missing_both",
      });
      // A creating row past the registry step (broker_kid recorded) too.
      const s2 = setup({ brokerEnabled: true });
      await failAtHealth(s2);
      const [row] = s2.rows();
      expect(row.state).toBe("creating");
      expect(row.broker_kid).toBeTruthy();
      s2.fake.kvValues(s2.regId).delete(registryKey(row.id));
      s2.fake.kvValues(s2.dirId).delete(registryKey(row.id));
      expect((await s2.p.status(row.id)).registryDrift).toEqual({
        id: row.id,
        kind: "missing_both",
      });
    });

    it("H-DR: no drift for a creating row before the registry step, or a deleted install", async () => {
      const s = setup({ brokerEnabled: true });
      s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"));
      await fails(s.p.create(input()));
      const [row] = s.rows();
      expect(row.state).toBe("creating");
      expect(row.broker_kid).toBeNull();
      expect((await s.p.status(row.id)).registryDrift).toBeNull();
      const inst = await s.p.create(input());
      await s.p.delete(inst.id, inst.id);
      expect(s.rows()[0].state).toBe("deleted");
      expect(s.fake.kvValues(s.regId).has(registryKey(inst.id))).toBe(false);
      expect(s.fake.kvValues(s.dirId).has(registryKey(inst.id))).toBe(false);
      expect((await s.p.status(inst.id)).registryDrift).toBeNull();
    });

    it("H-RD: both copies carry AUTH_DOMAINS as parsed by the shared parser", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(
        input("finqore", {
          vars: { AUTH_DOMAINS: "B.example, a.example,b.example" },
        }),
      );
      const raw = s.fake.kvValues(s.regId).get(registryKey(inst.id)) as string;
      expect(JSON.parse(raw).domains).toEqual(["a.example", "b.example"]);
      expect(s.fake.kvValues(s.dirId).get(registryKey(inst.id))).toBe(raw);
      expect((await s.p.status(inst.id)).registryDrift).toBeNull();
    });

    it("H-RD: more than 50 domains, or an invalid one, is refused before any write", async () => {
      for (const AUTH_DOMAINS of [
        Array.from({ length: 51 }, (_, i) => `d${i}.example`).join(","),
        `${"a".repeat(64)}.example`,
      ]) {
        const s = setup({ brokerEnabled: true });
        const e = await fails(
          s.p.create(input("finqore", { vars: { AUTH_DOMAINS } })),
        );
        expect(e).toBeInstanceOf(ProvisionRefused);
        expect(e.message).toMatch(/domain/);
        expect(s.fake.writes()).toEqual([]);
      }
    });

    it("H-RD: status flags copies whose domains differ as a mismatch", async () => {
      const s = setup({ brokerEnabled: true });
      const inst = await s.p.create(
        input("finqore", { vars: { AUTH_DOMAINS: "a.example" } }),
      );
      const key = registryKey(inst.id);
      const raw = s.fake.kvValues(s.regId).get(key) as string;
      s.fake
        .kvValues(s.dirId)
        .set(
          key,
          JSON.stringify({ ...JSON.parse(raw), domains: ["b.example"] }),
        );
      expect((await s.p.status(inst.id)).registryDrift).toEqual({
        id: inst.id,
        kind: "mismatch",
      });
    });

    it("H-RD: a resumed create rewrites both copies when the domains are stale, keeping the key", async () => {
      const s = setup({ brokerEnabled: true });
      const i = input("finqore", { vars: { AUTH_DOMAINS: "a.example" } });
      await failAtHealth(s, i);
      const [row] = s.rows();
      const key = registryKey(row.id);
      const before = JSON.parse(s.fake.kvValues(s.regId).get(key) as string);
      // An entry written before domains existed.
      const legacy = JSON.stringify({ ...before, domains: undefined });
      s.fake.kvValues(s.regId).set(key, legacy);
      s.fake.kvValues(s.dirId).set(key, legacy);
      await s.p.create(i);
      const raw = s.fake.kvValues(s.regId).get(key) as string;
      expect(JSON.parse(raw)).toEqual({ ...before, domains: ["a.example"] });
      expect(s.fake.kvValues(s.dirId).get(key)).toBe(raw);
    });

    it("is not written when brokerEnabled is false", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      expect(s.fake.kvValues(s.regId).size).toBe(0);
      expect(s.scriptOf(inst.id)?.secrets.has("BROKER_SIGNING_KEY")).toBe(
        false,
      );
    });

    it("a create whose origin already belongs to another install is refused and writes nothing", async () => {
      const s = setup({ brokerEnabled: true });
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "legacy",
        app: "finqore.open-artifacts-staging.app",
        content: "legacy.open-artifacts-staging.page",
        state: "active",
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
      expect(s.fake.kvValues(s.regId).size).toBe(0);
    });

    it("a deleted finqore row blocks a new finqore (hosts and origin stay held until a purge)", async () => {
      const s = setup({ brokerEnabled: true });
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "finqore",
        app: "finqore.open-artifacts-staging.app",
        content: "finqore.open-artifacts-staging.page",
        state: "deleted",
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/deleted/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("a deleted row under another slug still holds its hosts", async () => {
      const s = setup();
      s.db()
        .prepare(
          "INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, state, rl_ns, created_at, updated_at) VALUES ('iaaaaaaaaaaa', 'old', 'old.open-artifacts-staging.app', 'old.open-artifacts-staging.page', 'x@y.test', 'x', 'deleted', 1000000, 1, 1)",
        )
        .run();
      s.db()
        .prepare(
          "INSERT INTO hosts (host, install_id) VALUES (?, 'iaaaaaaaaaaa')",
        )
        .run("finqore.open-artifacts-staging.page");
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
    });

    it("an origin that is not byte-equal to https://<appHost> is refused", () => {
      const h = "finqore.open-artifacts-staging.app";
      expect(brokerOrigin(h)).toBe(`https://${h}`);
      expect(() => assertBrokerOrigin(`https://${h}`, h)).not.toThrow();
      for (const bad of [
        `http://${h}`,
        `https://${h}/`,
        `https://${h}:443`,
        `https://${h}/x`,
        "https://FinQore.open-artifacts-staging.app",
        `https://${h}.`,
        "https://other.open-artifacts-staging.app",
      ])
        expect(() => assertBrokerOrigin(bad, h), bad).toThrow(/origin/);
      expect(() => brokerOrigin("FinQore.open-artifacts-staging.app")).toThrow(
        /origin/,
      );
    });
  });

  it("drift test names: BROKER_SIGNING_KEY is a secret binding; BROKER_KID and BROKER_KEY appear nowhere", async () => {
    const s = setup({ brokerEnabled: true });
    await s.p.create(input());
    const listed = s.fake.log.findIndex(
      (e) => e.method === "PUT" && e.path.endsWith("/secrets"),
    );
    expect(JSON.parse(s.fake.raw[listed]?.body as string)).toMatchObject({
      name: "BROKER_SIGNING_KEY",
      type: "secret_text",
    });
    const bad = /\bBROKER_(KID|KEY)\b/;
    for (const r of s.fake.raw) expect(bad.test(r.body)).toBe(false);
    for (const f of readdirSync(new URL("../src/", import.meta.url), {
      recursive: true,
    }).filter((x) => String(x).endsWith(".ts")))
      expect(
        bad.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")),
        String(f),
      ).toBe(false);
    const meta = metaOf(uploads(s.fake)[0]?.body as string);
    const t = loadTemplate();
    const known = new Set<string>([
      ...HOSTED_ADDED,
      ...Object.keys(t.vars),
      "DIRECTORY_TOKEN_KEY",
      "BROWSER",
      "EMAIL",
      "ASSETS",
      "DB",
      "FILES",
      "OAUTH_KV",
      "ARTIFACT_RUNTIME",
      // P3 T7b: UserPresence, bound one release after its class tag (v2).
      "USER_PRESENCE",
      // P3 T13: DirectorySync (v3) and the directory groups limiter.
      "DIRECTORY_SYNC",
      "RL_DIRECTORY",
      "RL_ANON",
      "RL_AUTH",
      "PLAN",
    ]);
    for (const b of meta.bindings) expect(known.has(b.name), b.name).toBe(true);
  });

  describe("bundle variants and the release record (decision 8, H2)", () => {
    it("testHooks in oa-prod is refused before any Cloudflare call", async () => {
      const s = setup({ env: "prod" });
      const e = await fails(
        s.p.create(
          input("finqore", {
            testHooks: true,
            bundle: "redline",
            vars: HOOK_VARS,
          }),
        ),
      );
      expect(e.message).toMatch(/test hooks|prod/);
      expect(s.fake.log).toEqual([]);
    });

    it.each([
      ["redline into oa-prod", "prod" as const, false, "redline" as const],
      [
        "redline into a staging non-test install",
        "staging" as const,
        false,
        "redline" as const,
      ],
      [
        "release into a test install",
        "staging" as const,
        true,
        "release" as const,
      ],
    ])(
      "%s is refused with zero Cloudflare calls",
      async (_n, env, testHooks, bundle) => {
        const s = setup({ env });
        await fails(
          s.p.create(
            input("finqore", {
              testHooks,
              bundle,
              vars: testHooks ? HOOK_VARS : {},
            }),
          ),
        );
        expect(s.fake.log).toEqual([]);
      },
    );

    it("redline on an account target is refused (hooks only in the oa-staging namespace)", async () => {
      const s = setup({ target: { kind: "account" } });
      await fails(s.p.create(hookInput("finqore")));
      expect(s.fake.log).toEqual([]);
    });

    it("a mislabelled bundle (redline bytes served as release) is refused with zero calls", async () => {
      const s = setup({
        release: makeRelease(
          {},
          {
            modules: async (version) => makeBundle("redline", version),
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/modules do not match the signed record/);
      expect(s.fake.log).toEqual([]);
    });

    it.each(["prod", "staging"] as const)(
      "a missing release record in %s is refused with zero calls",
      async (env) => {
        const s = setup({
          env,
          release: makeRelease({}, { record: async () => null }),
        });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/no release record/);
        expect(s.fake.log).toEqual([]);
      },
    );

    it.each([
      [
        'a string define "false" is invalid',
        { ...recordOf("release"), defines: { [TEST_HOOKS_DEFINE]: "false" } },
      ],
      [
        "a release record whose define is true",
        { ...recordOf("release"), defines: { [TEST_HOOKS_DEFINE]: true } },
      ],
      ["a record for another variant", recordOf("redline")],
      ["a record for another version", recordOf("release", "0.22.0")],
      [
        "a record with another sha256",
        { ...recordOf("release"), sha256: "0".repeat(64) },
      ],
    ])("%s is refused with zero calls", async (_n, rec) => {
      const s = setup({
        release: makeRelease(
          {},
          {
            record: async () => signRecord(rec as unknown as ReleaseRecord),
          },
        ),
      });
      await fails(s.p.create(input()));
      expect(s.fake.log).toEqual([]);
    });

    it('a redline record with the string "true" is refused as invalid, not treated as true', async () => {
      const s = setup({
        release: makeRelease(
          {},
          {
            record: async (version, v) =>
              signRecord({
                ...recordOf(v, version),
                defines: { [TEST_HOOKS_DEFINE]: "true" },
              } as unknown as ReleaseRecord),
          },
        ),
      });
      const e = await fails(s.p.create(hookInput()));
      expect(e.message).toMatch(/boolean/);
      expect(s.fake.log).toEqual([]);
    });

    it("the uploaded bytes are hashed and must equal the record", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      const sc = s.scriptOf(inst.id);
      const rel = makeBundle("release");
      expect(new TextDecoder().decode(sc?.modules.get("index.js")?.bytes)).toBe(
        new TextDecoder().decode(rel.modules[0]?.bytes),
      );
      expect(bundleSha256(rel)).toBe(recordOf("release").sha256);
      const names = sc?.metadata.bindings.map((b: { name: string }) => b.name);
      expect(names).not.toContain("TEST_HOOKS");
      expect(names).not.toContain("TEST_HOOK_KEY");
      expect(names).not.toContain("TEST_DOMAIN");
      expect(JSON.stringify(sc?.metadata)).not.toMatch(/hook/i);
      const audit = s
        .db()
        .prepare(
          "SELECT detail FROM hosted_audit WHERE action = 'create.upload'",
        )
        .get() as { detail: string };
      expect(JSON.parse(audit.detail).sha256).toBe(recordOf("release").sha256);
    });

    it("a bundle whose bytes change between pre-flight and upload is refused before the upload (N3)", async () => {
      const s = setup({
        release: makeRelease(
          {},
          {
            modules: swapAfterFirst(
              async () => makeBundle("release"),
              async () => makeBundle("redline"),
            ),
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/modules do not match the signed record/);
      expect(uploads(s.fake)).toHaveLength(0);
    });

    it("bundleSha256 changes with any module byte, name or the main module", () => {
      const a = makeBundle("release");
      expect(bundleSha256(a)).toMatch(/^[0-9a-f]{64}$/);
      expect(bundleSha256(makeBundle("redline"))).not.toBe(bundleSha256(a));
      expect(bundleSha256({ ...a, mainModule: "other.js" })).not.toBe(
        bundleSha256(a),
      );
    });
  });

  describe("TEST_DOMAIN", () => {
    it("a test-hook install without TEST_DOMAIN is refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.p.create(input("redqa", { testHooks: true, bundle: "redline" })),
      );
      expect(e.message).toMatch(/TEST_DOMAIN/);
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN on a non-test install is refused with zero calls", async () => {
      const s = setup();
      await fails(s.p.create(input("finqore", { vars: HOOK_VARS })));
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN in oa-prod is refused with zero calls", async () => {
      const s = setup({ env: "prod" });
      await fails(s.p.create(input("finqore", { vars: HOOK_VARS })));
      expect(s.fake.log).toEqual([]);
    });
    it("TEST_DOMAIN must be a lowercase hostname", async () => {
      const s = setup();
      for (const bad of [
        "Redline.test",
        "redline",
        "x@redline.test",
        "redline.test.",
      ])
        await fails(
          s.p.create(
            input("redqa", {
              testHooks: true,
              bundle: "redline",
              vars: { TEST_DOMAIN: bad },
            }),
          ),
        );
      expect(s.fake.log).toEqual([]);
    });
    it("metadata allows TEST_DOMAIN only on a test-hook install outside prod", () => {
      const base = {
        id: "iabcdefghjk2",
        appHost: "a.app.test",
        contentHost: "a.content.test",
        ownerEmail: "o@x.test",
      };
      const res = {
        d1Id: "11111111-2222-4333-8444-555555555555",
        kvId: "0123456789abcdef0123456789abcdef",
        version: "1.2.3",
        rlNs: 1_000_000,
        doMigrationTag: null,
        env: "staging" as const,
        target: "namespace" as const,
        mode: "update" as const,
        assetsJwt: "jwt",
        template: loadTemplate(),
        mainModule: "index.js",
      };
      const m = userWorkerMetadata(
        { ...base, vars: HOOK_VARS, testHooks: true },
        res,
      );
      expect(m.bindings.find((b) => b.name === "TEST_DOMAIN")).toMatchObject({
        type: "plain_text",
        text: "redline.test",
      });
      expect(() =>
        userWorkerMetadata({ ...base, vars: HOOK_VARS, testHooks: false }, res),
      ).toThrow(/TEST_DOMAIN/);
      expect(() =>
        userWorkerMetadata(
          { ...base, vars: HOOK_VARS, testHooks: false },
          { ...res, env: "prod" },
        ),
      ).toThrow(/TEST_DOMAIN/);
      THROWN.push("metadata TEST_DOMAIN");
    });
  });

  it("on staging the hook-key file is 0600, matches TEST_HOOK_KEY and never appears in output", async () => {
    const s = setup();
    const inst = await s.p.create(hookInput());
    PRINTABLE.push(JSON.stringify(inst));
    const f = join(s.patDir, "redqa.open-artifacts-staging.app-hook-key");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const key = readFileSync(f, "utf8").trim();
    expect(SENSITIVE.has(key)).toBe(true);
    expect(s.scriptOf(inst.id)?.secrets.get("TEST_HOOK_KEY")).toBe(key);
    expect(s.rows()[0].test_hooks).toBe(1);
    const b = (n: string) =>
      s
        .scriptOf(inst.id)
        ?.metadata.bindings.find((x: { name: string }) => x.name === n);
    expect(b("TEST_HOOKS")).toMatchObject({ type: "plain_text", text: "1" });
    expect(b("TEST_DOMAIN")).toMatchObject({
      type: "plain_text",
      text: "redline.test",
    });
    expect(JSON.stringify(inst)).not.toContain(key);
  });

  it("the hook-key file is never written through a symlink (O_NOFOLLOW)", async () => {
    const s = setup();
    const victim = join(s.patDir, "victim");
    writeFileSync(victim, "keep");
    const f = join(s.patDir, "redqa.open-artifacts-staging.app-hook-key");
    symlinkSync(victim, f);
    await fails(s.p.create(hookInput()));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(f).isSymbolicLink()).toBe(true);
    expect(uploads(s.fake)).toHaveLength(0);
  });

  it("secrets are 48-byte random, differ between two installs, and never appear in the call log's printable fields or thrown errors", async () => {
    const s = setup();
    const a = await s.p.create(input("alpha"));
    const b = await s.p.create(input("beta"));
    const sa = s.scriptOf(a.id)?.secrets as Map<string, string>;
    const sb = s.scriptOf(b.id)?.secrets as Map<string, string>;
    for (const k of [
      "SESSION_SECRET",
      "CONTENT_SIGNING_KEY",
      "DIRECTORY_TOKEN_KEY",
    ]) {
      expect(Buffer.from(sa.get(k) as string, "base64url")).toHaveLength(48);
      expect(Buffer.from(sb.get(k) as string, "base64url")).toHaveLength(48);
      expect(sa.get(k)).not.toBe(sb.get(k));
      expect(SENSITIVE.has(sa.get(k) as string)).toBe(true);
    }
    expect(new Set(sa.values()).size).toBe(sa.size);
  });

  it("a rerun/resume of the same install does not mint a new SESSION_SECRET, even when it uploads", async () => {
    const s = setup();
    await failAtHealth(s);
    const [row] = s.rows();
    const first = s.scriptOf(row.id)?.secrets.get("SESSION_SECRET");
    s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
    await s.p.create(input());
    const ups = uploads(s.fake);
    expect(ups).toHaveLength(2);
    expect(secretBindings(metaOf(ups[1]?.body as string))).not.toContain(
      "SESSION_SECRET",
    );
    expect(s.scriptOf(row.id)?.secrets.get("SESSION_SECRET")).toBe(first);
  });

  it("assertSessionSecret refuses short, malformed or reused values", () => {
    const ok = Buffer.alloc(48, 7).toString("base64url");
    expect(() => assertSessionSecret(ok, [])).not.toThrow();
    expect(() =>
      assertSessionSecret(Buffer.alloc(31, 1).toString("base64url"), []),
    ).toThrow(/32 bytes/);
    expect(() => assertSessionSecret("not base64url!", [])).toThrow(
      /SESSION_SECRET/,
    );
    expect(() => assertSessionSecret(ok, [ok])).toThrow(/distinct/);
    THROWN.push("assertSessionSecret");
  });

  it("resumes after an upload failure without duplicating resources", async () => {
    const s = setup();
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/[^/]+$/.test(p), {
      status: 400,
    });
    await fails(s.p.create(input()));
    expect(s.fake.kvValues(s.hostsId).size).toBe(0);
    const inst = await s.p.create(input());
    const n = `oa-s-${inst.id}`;
    expect([...s.fake.d1.values()].filter((d) => d.name === n)).toHaveLength(1);
    expect([...s.fake.r2].filter((b) => b === n)).toHaveLength(1);
    expect(
      [...s.fake.kv.values()].filter((k) => k.title === `${n}-oauth`),
    ).toHaveLength(1);
    expect([...(s.scriptOf(inst.id)?.secrets.keys() ?? [])].sort()).toEqual([
      "CONTENT_SIGNING_KEY",
      "DIRECTORY_TOKEN_KEY",
      "SESSION_SECRET",
    ]);
  });

  it("hosts are written last: kvPut(HOSTS) comes after the script upload", async () => {
    const s = setup({ brokerEnabled: true });
    await s.p.create(input());
    const w = s.fake.writes();
    const hostIdx = w.findIndex((x) =>
      x.includes(`/namespaces/${s.hostsId}/values/`),
    );
    const upIdx = w.findIndex((x) => /^PUT .*\/scripts\/[^/]+$/.test(x));
    const brokerIdx = w
      .map((x) => x.includes(`/namespaces/${s.regId}/values/`))
      .lastIndexOf(true);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(brokerIdx).toBeGreaterThan(upIdx);
    expect(hostIdx).toBeGreaterThan(upIdx);
    expect(hostIdx).toBeGreaterThan(brokerIdx);
    const after = w
      .slice(hostIdx)
      .filter(
        (x) =>
          !x.includes("/query") && !x.includes(`/namespaces/${s.hostsId}/`),
      );
    expect(after).toEqual([]);
  });

  describe("slug or host already taken fails before any Cloudflare write", () => {
    it("a host mapped in HOSTS to another install", async () => {
      const s = setup();
      s.fake
        .kvValues(s.hostsId)
        .set("finqore.open-artifacts-staging.page", "izzzzzzzzzzz");
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/taken/);
      expect(s.fake.writes()).toEqual([]);
    });
    it("a slug held by an active install", async () => {
      const s = setup();
      seedRow(s, {
        id: "iaaaaaaaaaaa",
        slug: "finqore",
        app: "finqore.open-artifacts-staging.app",
        content: "finqore.open-artifacts-staging.page",
        state: "active",
      });
      await fails(s.p.create(input()));
      expect(s.fake.writes()).toEqual([]);
    });
    it("an invalid or reserved slug makes zero calls", async () => {
      const s = setup();
      await fails(s.p.create(input("auth")));
      await fails(s.p.create(input("Bad_Slug")));
      expect(s.fake.log).toEqual([]);
    });
    it("the other env's domains are refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.mk({ domains: HOSTED_DOMAINS.prod }).create(input()),
      );
      expect(e.message).toMatch(/domains/);
      expect(s.fake.log).toEqual([]);
    });
  });

  it("the PAT file is 0600, minted for the owner, and its content never appears in returned values", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    expect(statSync(inst.patFile).mode & 0o777).toBe(0o600);
    const pat = readFileSync(inst.patFile, "utf8").trim();
    expect(isPat(pat)).toBe(true);
    expect(SENSITIVE.has(pat)).toBe(true);
    expect(JSON.stringify(inst)).not.toContain(pat);
    expect(JSON.stringify(s.p.notes)).not.toContain(pat);
    const idb = s.fake.d1.get(s.rows()[0].d1_id)?.db as DatabaseSync;
    const hash = createHash("sha256").update(pat).digest("hex");
    expect(
      idb
        .prepare("SELECT revoked_at FROM tokens WHERE token_hash = ?")
        .get(hash),
    ).toEqual({ revoked_at: null });
    expect(JSON.stringify(s.fake.log) + JSON.stringify(s.rows())).not.toContain(
      pat,
    );
  });

  it("the PAT file is never written through a symlink (O_NOFOLLOW)", async () => {
    const s = setup();
    const victim = join(s.patDir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(
      victim,
      join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
    );
    await fails(s.p.create(input()));
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(
      lstatSync(
        join(s.patDir, "finqore.open-artifacts-staging.app-pat-token"),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  describe("Durable Object migration tag (decision 5)", () => {
    const tpl = (tags: string[]) => {
      const t = structuredClone(loadTemplate());
      t.migrations = tags.map((tag, i) =>
        i === 0
          ? { tag, new_sqlite_classes: ["ArtifactRuntime"] }
          : { tag, new_sqlite_classes: [`C${i}`] },
      );
      return t;
    };

    it("the first upload sends the full chain with new_tag and no old_tag; no probe on a missing script", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(1);
      const m = metaOf(ups[0]?.body as string).migrations;
      expect(m.old_tag).toBeUndefined();
      expect(m.new_tag).toBe("v2");
      expect(m.steps).toHaveLength(2);
      expect(s.fake.log.some((e) => e.status === 412)).toBe(false);
      expect(s.rows()[0].do_migration_tag).toBe("v2");
    });

    it("a journal tag set while the script is missing sends the full chain, no old_tag", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.fake.scripts.delete(`oa-staging/${`oa-s-${row.id}`}`);
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 200]);
      const m = metaOf(ups[1]?.body as string).migrations;
      expect(m.old_tag).toBeUndefined();
      expect(m.steps).toHaveLength(2);
    });

    it("a rerun at the same tag sends no migrations", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.scriptOf(row.id)?.secrets.delete("DIRECTORY_TOKEN_KEY");
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups).toHaveLength(2);
      expect(metaOf(ups[1]?.body as string).migrations).toBeUndefined();
    });

    it("a rerun whose journal is empty probes with a sentinel old_tag, learns the live tag and sends nothing when it is current", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      await s.p.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
      expect(metaOf(ups[1]?.body as string).migrations.old_tag).toBe(
        "__oa_probe__",
      );
      expect(metaOf(ups[2]?.body as string).migrations).toBeUndefined();
      expect(s.scriptOf(row.id)?.migrationTag).toBe("v2");
      expect(s.rows()[0].do_migration_tag).toBe("v2");
    });

    it("a rerun whose journal is behind probes and sends only the missing steps", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = 'v1' WHERE id = ?")
        .run(row.id);
      const p2 = s.mk({
        release: makeRelease({ template: tpl(["v1", "v2", "v3"]) }),
      });
      await p2.create(input());
      const ups = uploads(s.fake);
      expect(ups.map((u) => u.status)).toEqual([200, 412, 200]);
      const m = metaOf(ups[2]?.body as string).migrations;
      expect(m).toMatchObject({ old_tag: "v2", new_tag: "v3" });
      expect(m.steps).toHaveLength(1);
      expect(s.scriptOf(row.id)?.migrationTag).toBe("v3");
      expect(s.rows()[0].do_migration_tag).toBe("v3");
    });

    it("a live tag the release does not know is refused (forward-fix only)", async () => {
      const s = setup({
        release: makeRelease({ template: tpl(["v1", "v2"]) }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      const e = await fails(
        s
          .mk({ release: makeRelease({ template: tpl(["v1"]) }) })
          .create(input()),
      );
      expect(e.message).toMatch(/forward-fix/);
      expect(uploads(s.fake).map((u) => u.status)).toEqual([200, 412]);
    });
  });

  describe("assets (decision 6)", () => {
    it("manifest hashes are 32 hex, uploads go to the account assets route with the session jwt, 202 then 201", async () => {
      const s = setup();
      await s.p.create(input());
      const sess = s.fake.log.findIndex((e) =>
        e.path.endsWith("/assets-upload-session"),
      );
      expect(s.fake.log[sess]?.path).toContain(
        "/workers/dispatch/namespaces/oa-staging/scripts/",
      );
      const manifest = JSON.parse(s.fake.raw[sess]?.body as string).manifest;
      expect(Object.keys(manifest).sort()).toEqual(["/app.js", "/index.html"]);
      for (const v of Object.values(manifest) as { hash: string }[])
        expect(v.hash).toMatch(/^[0-9a-f]{32}$/);
      expect(manifest["/app.js"].hash).toBe(
        assetHash(ASSETS[1]?.bytes as Uint8Array),
      );
      const ups = s.fake.log.filter((e) =>
        e.path.includes("/workers/assets/upload"),
      );
      expect(ups.map((e) => e.path)).toEqual([
        `/accounts/${s.fake.accountId}/workers/assets/upload?base64=true`,
        `/accounts/${s.fake.accountId}/workers/assets/upload?base64=true`,
      ]);
      expect(ups.map((e) => e.status)).toEqual([202, 201]);
      const meta = metaOf(uploads(s.fake)[0]?.body as string);
      expect(meta.assets.jwt).toMatch(/^jwt-done-/);
      expect(meta.keep_assets).toBeUndefined();
    });

    it("cf.assetsUpload with nothing new returns the session jwt without an upload call", async () => {
      const fake = new FakeCf();
      FAKES.push(fake);
      SENSITIVE.add(fake.token);
      const cf = cfClient({
        accountId: fake.accountId,
        token: fake.token,
        fetch: fake.fetch,
      });
      fake.assetHashes.add(assetHash(enc("a")));
      const r = await cf.assetsUpload(
        { kind: "namespace", ns: "oa-staging" },
        "oa-s-iaaaaaaaaaaa",
        [{ path: "a.txt", bytes: enc("a") }],
      );
      expect(r.jwt).toMatch(/^jwt-sess-/);
      expect(fake.log.some((e) => e.path.includes("/assets/upload"))).toBe(
        false,
      );
    });
  });

  describe("ratelimits (decision 12)", () => {
    it("each template ratelimit gets rlNs + its index (RL_ANON rlNs, RL_AUTH rlNs + 1); two installs never share an id", async () => {
      // Derived from the live template, so a new server limiter (P3 T13's
      // RL_DIRECTORY) needs no edit here.
      const tplRl = (loadTemplate().ratelimits ?? []) as {
        name: string;
        namespace_id: string;
      }[];
      expect(tplRl.slice(0, 2).map((r) => r.name)).toEqual([
        "RL_ANON",
        "RL_AUTH",
      ]);
      const s = setup();
      const a = await s.p.create(input("alpha"));
      const b = await s.p.create(input("beta"));
      const ids: string[] = [];
      for (const inst of [a, b]) {
        const row = s.rows().find((r) => r.id === inst.id);
        expect(row.rl_ns % 8).toBe(0);
        expect(row.rl_ns).toBeGreaterThanOrEqual(1_000_000);
        expect(row.rl_ns).toBeLessThan(2_000_000);
        const rl = s
          .scriptOf(inst.id)
          ?.metadata.bindings.filter(
            (x: { type: string }) => x.type === "ratelimit",
          );
        const by = Object.fromEntries(
          rl.map((x: { name: string; namespace_id: string }) => [
            x.name,
            x.namespace_id,
          ]),
        );
        expect(by).toEqual(
          Object.fromEntries(
            tplRl.map((r, k) => [r.name, String(row.rl_ns + k)]),
          ),
        );
        ids.push(...Object.values(by as Record<string, string>));
      }
      expect(new Set(ids).size).toBe(2 * tplRl.length);
      for (const r of tplRl) expect(ids).not.toContain(r.namespace_id);
    });

    it.each([
      [
        "a literal id >= 1,000,000",
        (t: Record<string, unknown[]>) => {
          (t.ratelimits[0] as { namespace_id: string }).namespace_id =
            "1000000";
        },
      ],
      [
        "more than 8 entries",
        (t: Record<string, unknown[]>) => {
          t.ratelimits = Array.from({ length: 9 }, (_, i) => ({
            name: `RL_${i}`,
            namespace_id: String(2000 + i),
            simple: { limit: 1, period: 60 },
          }));
        },
      ],
    ])(
      "a template with %s is refused before any Cloudflare call",
      async (_n, edit) => {
        const t = structuredClone(loadTemplate());
        edit(t);
        const s = setup({ release: makeRelease({ template: t }) });
        await fails(s.p.create(input()));
        expect(s.fake.log).toEqual([]);
      },
    );
  });

  describe("env and target (decisions 1, 2)", () => {
    it("a namespace target of the other env is refused with zero calls", async () => {
      const s = setup();
      const e = await fails(
        s.mk({ target: { kind: "namespace", ns: "oa-prod" } }).create(input()),
      );
      expect(e.message).toMatch(/namespace/);
      expect(s.fake.log).toEqual([]);
    });
  });

  describe("token check (decision 9)", () => {
    it.each([
      ["inactive", { status: "disabled" }],
      [
        "not yet valid",
        { not_before: new Date(NOW + 3_600_000).toISOString() },
      ],
      ["no expiry", { expires_on: undefined }],
      [
        "expiry over 30 days out",
        { expires_on: new Date(NOW + 31 * 86_400_000).toISOString() },
      ],
      ["expired", { expires_on: new Date(NOW - 1000).toISOString() }],
    ])("a token that is %s is refused before any write", async (_n, over) => {
      const s = setup();
      Object.assign(s.fake.tokenInfo, over);
      for (const [k, v] of Object.entries(over))
        if (v === undefined) delete s.fake.tokenInfo[k];
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/token/);
      expect(s.fake.writes()).toEqual([]);
      expect(s.fake.log.map((e) => e.path)).toEqual(["/user/tokens/verify"]);
    });

    it.each([401, 403])(
      "a %s on the Workers Scripts read is refused before any write",
      async (status) => {
        const s = setup();
        s.fake.scriptsReadStatus = status;
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/Workers Scripts/);
        expect(s.fake.log.map((e) => e.path)).toEqual([
          "/user/tokens/verify",
          `/accounts/${s.fake.accountId}/workers/scripts?per_page=1`,
        ]);
      },
    );

    it.each([
      ["2 days", 2 * 86_400_000],
      ["exactly 5 days", 5 * 86_400_000],
    ])(
      "a token that expires within 5 days (%s) is refused before any write, naming the date and the fix",
      async (_n, ms) => {
        const s = setup();
        const exp = new Date(NOW + ms).toISOString();
        s.fake.tokenInfo.expires_on = exp;
        const e = await fails(s.p.create(input()));
        expect(e.message).toContain(exp.slice(0, 10));
        expect(e.message).toMatch(/expires/);
        expect(e.message).toMatch(/roll/i);
        expect(e.message).toMatch(/My Profile > API Tokens/);
        expect(s.fake.writes()).toEqual([]);
        expect(s.fake.log.map((e) => e.path)).toEqual(["/user/tokens/verify"]);
      },
    );

    it("a token with just over 5 days left is accepted, with no expiry note", async () => {
      const s = setup();
      s.fake.tokenInfo.expires_on = new Date(
        NOW + 5 * 86_400_000 + 60_000,
      ).toISOString();
      await s.p.create(input());
      expect(s.p.notes.join("\n")).not.toMatch(/expires/);
    });

    it("never calls a zone, DNS or email API", async () => {
      const s = setup();
      const inst = await s.p.create(input());
      for (const e of s.fake.log)
        expect(e.path).not.toMatch(
          /\/zones|dns_records|custom_domains|\/workers\/domains|\/email\//,
        );
      const from = s
        .scriptOf(inst.id)
        ?.metadata.bindings.find(
          (b: { name: string }) => b.name === "EMAIL_FROM",
        );
      expect(from.text).toBe("noreply@finqore.mail.open-artifacts-staging.app");
    });
  });

  describe("health check", () => {
    it("waits for /healthz and fails after 120 s with the row left creating", async () => {
      const s = setup();
      const e = await failAtHealth(s);
      expect(e.message).toMatch(/healthz/);
      expect(s.rows()[0].state).toBe("creating");
      expect(s.clock.now() - NOW).toBeGreaterThanOrEqual(120_000);
    });

    it("requireInstallId makes the check insist on installId (Task 6b)", async () => {
      const s = setup();
      const p = s.mk({ requireInstallId: true });
      await fails(p.create(input()));
      s.fake.health = (sc) => ({
        ok: true,
        plan: "paid",
        version: "0.23.0",
        installId: sc.name.slice(5),
      });
      await p.create(input());
      expect(s.rows()[0].state).toBe("active");
    });
  });

  it("errors are scrubbed in every string property, including Cloudflare's own text", async () => {
    const s = setup();
    s.fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      message: `bucket refused for ${OWNER}`,
    });
    const e = await fails(s.p.create(input()));
    expect(e).toBeInstanceOf(CfError);
    expect((e as CfError).cfMessage).not.toContain(OWNER);
    expect(JSON.stringify(e)).not.toContain(OWNER);
    expect(e.message).not.toContain(OWNER);
  });
});

const ROOT_DIR = ROOT.pathname.replace(/\/$/, "");
const bindingOf = (
  meta: { bindings: { type: string; name: string; text?: string }[] },
  name: string,
) => meta.bindings.find((b) => b.name === name);
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
/** Any write that applies a D1 migration of the install. */
const migrationWrites = (fake: Fake) =>
  fake.raw.filter((r) => r.body.includes("INSERT INTO d1_migrations"));

describe("release record integrity (H-T4b M1)", () => {
  it("the record lists every asset sorted by path, the template bytes and the migrations", () => {
    const rec = recordOf("release");
    expect(rec.assets).toEqual([
      { path: "app.js", size: 14, sha256: sha("console.log(1)") },
      {
        path: "index.html",
        size: 24,
        sha256: sha("<!doctype html><p>hi</p>"),
      },
    ]);
    expect(rec.templateSha256).toBe(sha(TEMPLATE_BYTES));
    // A whitespace change in the template file changes the hash: exact bytes.
    expect(
      recordOf("release", "0.23.0", {
        template: enc(`${new TextDecoder().decode(TEMPLATE_BYTES)}\n`),
      }).templateSha256,
    ).not.toBe(rec.templateSha256);
    const want = sha(
      [...MIGRATION_FILES]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((f) => `${f.name}\0${sha(f.bytes)}`)
        .join("\n"),
    );
    expect(rec.migrationsSha256).toBe(want);
    expect(migrationsSha256([...MIGRATION_FILES].reverse())).toBe(want);
  });

  const evil: Record<
    "modules" | "assets" | "template" | "migrations",
    Partial<ReleaseReader>
  > = {
    modules: {
      modules: async () => makeBundle("redline"),
    },
    assets: {
      assets: async () => [
        ASSETS[0] as ReleaseAsset,
        { path: "app.js", bytes: enc("steal(document.cookie)") },
      ],
    },
    template: {
      template: async () => {
        const t = structuredClone(loadTemplate());
        t.compatibility_date = "2020-01-01";
        return enc(JSON.stringify(t));
      },
    },
    migrations: {
      migrations: async () => [
        ...MIGRATION_FILES,
        { name: "9999_evil.sql", bytes: enc("DROP TABLE users;") },
      ],
    },
  };

  it.each(Object.keys(evil) as (keyof typeof evil)[])(
    "release %s that differ from the signed record are refused with zero Cloudflare calls",
    async (kind) => {
      const s = setup({ release: makeRelease({}, evil[kind]) });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(
        new RegExp(`${kind} do not match the signed record`),
      );
      expect(s.fake.log).toEqual([]);
    },
  );

  it.each(Object.keys(evil) as (keyof typeof evil)[])(
    "release %s swapped between pre-flight and use are refused before the write",
    async (kind) => {
      const good = makeRelease();
      const bad = makeRelease({}, evil[kind]);
      const s = setup({
        release: makeRelease(
          {},
          {
            [kind]: swapAfterFirst(
              () =>
                (good[kind] as (v: string, b: "release") => Promise<unknown>)(
                  "0.23.0",
                  "release",
                ),
              () =>
                (bad[kind] as (v: string, b: "release") => Promise<unknown>)(
                  "0.23.0",
                  "release",
                ),
            ),
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(
        new RegExp(`${kind} do not match the signed record`),
      );
      // Re-read from the release, not the cached pre-flight copy.
      expect((s.release as ReturnType<typeof makeRelease>).calls[kind]).toBe(2);
      expect(uploads(s.fake)).toHaveLength(0);
      expect(
        s.fake.log.some((x) => x.path.endsWith("/assets-upload-session")),
      ).toBe(false);
      if (kind === "migrations")
        expect(migrationWrites(s.fake)).toHaveLength(0);
      else expect(migrationWrites(s.fake).length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["an extra asset", [...ASSETS, { path: "x.js", bytes: enc("x") }]],
    ["a missing asset", [ASSETS[0] as ReleaseAsset]],
    [
      "an asset of another size",
      [
        ASSETS[0] as ReleaseAsset,
        { path: "app.js", bytes: enc("console.log(12)") },
      ],
    ],
  ])("%s is refused with zero Cloudflare calls", async (_n, assets) => {
    const s = setup({
      release: makeRelease({}, { assets: async () => assets }),
    });
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/assets do not match the signed record/);
    expect(s.fake.log).toEqual([]);
  });

  it.each([
    ".env",
    ".well-known/x.txt",
    "a/.git/config",
    "a/./b",
    "a/../b",
    "/abs",
    "a//b",
    "a\\b",
  ])(
    "an asset path %s in the release is refused, even when the signed record lists it",
    async (path) => {
      const assets = [...ASSETS, { path, bytes: enc("secret=1") }];
      // Built by hand: assetEntries itself refuses the path.
      const entries = assets
        .map((a) => ({
          path: a.path,
          size: a.bytes.byteLength,
          sha256: sha(a.bytes),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const s = setup({
        release: makeRelease(
          {},
          {
            assets: async () => assets,
            record: async () =>
              signRecord({ ...recordOf("release"), assets: entries }),
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/asset path/);
      expect(s.fake.log).toEqual([]);
      const unlisted = setup({
        release: makeRelease({}, { assets: async () => assets }),
      });
      await fails(unlisted.p.create(input()));
      expect(unlisted.fake.log).toEqual([]);
    },
  );

  it("cf.assetsUpload refuses a dotfile without any call", async () => {
    const fake = new FakeCf();
    FAKES.push(fake);
    SENSITIVE.add(fake.token);
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
    });
    const e = await fails(
      cf.assetsUpload(
        { kind: "namespace", ns: "oa-staging" },
        "oa-s-iaaaaaaaaaaa",
        [{ path: ".dev.vars", bytes: enc("SECRET=1") }],
      ),
    );
    expect(e.message).toMatch(/asset path/);
    expect(fake.log).toEqual([]);
  });

  it("readAssetsDir lists files sorted and refuses symlinks, dotfiles and dot-directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-t4b-assets-"));
    mkdirSync(join(dir, "css"));
    writeFileSync(join(dir, "index.html"), "i");
    writeFileSync(join(dir, "css", "a.css"), "a");
    expect((await readTreeHardened(dir)).map((a) => a.path)).toEqual([
      "css/a.css",
      "index.html",
    ]);
    const withDot = mkdtempSync(join(tmpdir(), "oa-t4b-assets-"));
    writeFileSync(join(withDot, ".env"), "SECRET=1");
    expect((await fails(readTreeHardened(withDot))).message).toMatch(
      /asset path/,
    );
    const withDotDir = mkdtempSync(join(tmpdir(), "oa-t4b-assets-"));
    mkdirSync(join(withDotDir, ".git"));
    writeFileSync(join(withDotDir, ".git", "config"), "x");
    expect((await fails(readTreeHardened(withDotDir))).message).toMatch(
      /asset path/,
    );
    const withLink = mkdtempSync(join(tmpdir(), "oa-t4b-assets-"));
    writeFileSync(join(dir, "target.txt"), "t");
    symlinkSync(join(dir, "target.txt"), join(withLink, "link.txt"));
    expect((await fails(readTreeHardened(withLink))).message).toMatch(
      /symlink/,
    );
  });

  it("the local checkout is never read: sentinel files in apps/server and scripts/setup change nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oa-t4b-checkout-"));
    const srv = join(cwd, "apps", "server");
    mkdirSync(join(srv, "dist-assets"), { recursive: true });
    mkdirSync(join(srv, "migrations"), { recursive: true });
    writeFileSync(join(srv, "dist-assets", "sentinel.txt"), "SENTINEL");
    writeFileSync(
      join(srv, "migrations", "9999_sentinel.sql"),
      "CREATE TABLE sentinel (x);",
    );
    writeFileSync(join(srv, "wrangler.template.jsonc"), "SENTINEL {");
    mkdirSync(join(cwd, "scripts", "setup"), { recursive: true });
    writeFileSync(
      join(cwd, "scripts", "setup", "welcome.md"),
      "# Welcome to Open Artifacts\nSENTINEL-from-checkout",
    );
    // A release template unlike the checkout's, so a fallback would show.
    const tpl = structuredClone(loadTemplate());
    tpl.compatibility_date = "2026-09-30";
    const s = setup({ release: makeRelease({ template: tpl }) });
    const before = process.cwd();
    H.READS.length = 0;
    process.chdir(cwd);
    let inst: Awaited<ReturnType<WfpProvisioner["create"]>>;
    try {
      inst = await s.p.create(input());
    } finally {
      process.chdir(before);
    }
    // No fs read in the repo or the cwd checkout; only the PAT dir (tmp).
    const local = H.READS.filter(
      (r) =>
        r.startsWith(ROOT_DIR) ||
        r.startsWith(cwd) ||
        !r.startsWith("/") ||
        r.includes("/apps/server") ||
        r.includes("dist-assets") ||
        r.includes("welcome.md"),
    );
    expect(local).toEqual([]);
    const art = [...s.fake.artifacts.values()][0];
    expect(art?.content).toBe(new TextDecoder().decode(WELCOME_BYTES));
    const sess = s.fake.raw.find((r) =>
      r.path.endsWith("/assets-upload-session"),
    );
    expect(
      Object.keys(JSON.parse(sess?.body as string).manifest).sort(),
    ).toEqual(["/app.js", "/index.html"]);
    const row = s.rows()[0];
    const idb = s.fake.d1.get(row.d1_id)?.db as DatabaseSync;
    expect(
      idb
        .prepare("SELECT name FROM sqlite_master WHERE name = 'sentinel'")
        .all(),
    ).toEqual([]);
    expect(s.scriptOf(inst.id)?.metadata.compatibility_date).toBe("2026-09-30");
  });
});

describe("prod lock and signed records (H-T4b L2)", () => {
  it("prod is refused with ProdLocked and zero calls while the PROD_UNLOCKED gate is off", async () => {
    const s = setup({ env: "prod" });
    await withGate("PROD_UNLOCKED", false, async () => {
      const e = await fails(s.p.create(input()));
      expect(e).toBeInstanceOf(ProdLocked);
      expect(e.name).toBe("ProdLocked");
      expect(s.fake.log).toEqual([]);
    });
    // T3b flips the gate in code; then prod creates like staging.
    const inst = await s.p.create(input());
    expect(inst.appHost).toBe("finqore.open-artifacts.app");
  });

  it("create refuses while RELEASE_PUBKEY is the placeholder", async () => {
    for (const env of ["staging", "prod"] as const) {
      const s = setup({ env });
      await withGate(
        "RELEASE_PUBKEY",
        { ...G.RELEASE_PUBKEY, [env]: RELEASE_PUBKEY_PLACEHOLDER },
        async () => {
          const e = await fails(s.p.create(input()));
          expect(e.message).toMatch(/placeholder/i);
          expect(s.fake.log).toEqual([]);
        },
      );
    }
  });

  const good = () => signRecord(recordOf("release"));
  it.each<[string, () => unknown]>([
    [
      "an unsigned record",
      () => ({ record: canonicalJson(recordOf("release")) }),
    ],
    [
      "an object record (the pre-T3b envelope)",
      () => ({ ...good(), record: recordOf("release") }),
    ],
    ["an empty signature", () => ({ ...good(), signature: "" })],
    ["a bare record without the envelope", () => recordOf("release")],
    [
      "a record signed with another key",
      () => signRecord(recordOf("release"), OTHER_SIGNER.privateKey),
    ],
    [
      "a tampered record (template hash changed after signing)",
      () => tamper(good(), { templateSha256: "0".repeat(64) }),
    ],
    [
      "a tampered record (variant and define flipped after signing)",
      () =>
        tamper(good(), {
          variant: "redline",
          defines: { [TEST_HOOKS_DEFINE]: true },
        }),
    ],
    [
      "another record's signature",
      () => ({
        record: canonicalJson(recordOf("release")),
        signature: signRecord(recordOf("redline")).signature,
      }),
    ],
  ])("%s is refused with zero calls", async (_n, rec) => {
    const s = setup({
      release: makeRelease({}, { record: async () => rec() as never }),
    });
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/signature/);
    expect(s.fake.log).toEqual([]);
    // Nothing else of the release is read before the signature checks out.
    const c = (s.release as ReturnType<typeof makeRelease>).calls;
    expect([c.modules, c.assets, c.template, c.migrations]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("the signature is checked before any field: a bad signature on a wrong-version record names the signature", async () => {
    const rec = { ...recordOf("release", "0.22.0") };
    const s = setup({
      release: makeRelease(
        {},
        {
          record: async () => ({
            ...signRecord(rec, OTHER_SIGNER.privateKey),
          }),
        },
      ),
    });
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/signature/);
    expect(e.message).not.toMatch(/0\.22\.0/);
  });

  it("a signature verifies over the domain-separated canonical JSON of the record", () => {
    const g = good();
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: TEST_PUBKEY },
      format: "jwk",
    });
    expect(
      verify(
        null,
        payloadOf(g.record, "staging"),
        pub,
        Buffer.from(g.signature, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("account target is test-only (H-T4b L3)", () => {
  it("an account target is refused with zero calls while the ALLOW_ACCOUNT_TARGET gate is off", async () => {
    const s = setup({ target: { kind: "account" } });
    await withGate("ALLOW_ACCOUNT_TARGET", false, async () => {
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/account target/);
      expect(s.fake.log).toEqual([]);
    });
  });
});

describe("Durable Object migration safety (H-T4b L5)", () => {
  // A step after the live template's own tags (derived, never a literal that
  // a new server DO tag would collide with).
  const STEP_TAG = `${lastTag}-step`;
  const withStep = (step: Record<string, unknown>) => {
    const t = structuredClone(loadTemplate());
    t.migrations = [...(t.migrations ?? []), { tag: STEP_TAG, ...step }];
    return t;
  };
  it.each([
    ["deleted_classes", { deleted_classes: ["ArtifactRuntime"] }],
    [
      "renamed_classes",
      { renamed_classes: [{ from: "ArtifactRuntime", to: "X" }] },
    ],
    [
      "transferred_classes",
      {
        transferred_classes: [
          { from: "ArtifactRuntime", from_script: "oa-s-other", to: "X" },
        ],
      },
    ],
    ["deleted_sqlite_classes", { deleted_sqlite_classes: ["ArtifactRuntime"] }],
    ["an unknown step key", { new_kv_classes: ["X"] }],
  ])("a template step with %s is refused with zero calls", async (_n, step) => {
    const t = withStep(step);
    const s = setup({ release: makeRelease({ template: t }) });
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/migration/);
    expect(s.fake.log).toEqual([]);
    expect(() =>
      userWorkerMetadata(
        {
          id: "iaaaaaaaaaaa",
          appHost: "a.open-artifacts-staging.app",
          contentHost: "a.open-artifacts-staging.page",
          ownerEmail: OWNER,
          vars: {},
          testHooks: false,
        },
        {
          d1Id: "00000000-0000-4000-8000-000000000000",
          kvId: "0".repeat(32),
          version: "0.23.0",
          rlNs: 1_000_000,
          doMigrationTag: "v1",
          env: "staging",
          target: "namespace",
          mode: "update",
          mainModule: "index.js",
          assetsJwt: "j",
          template: t,
        },
      ),
    ).toThrow(/migration/);
  });

  it("new_classes and new_sqlite_classes are allowed", async () => {
    const s = setup({
      release: makeRelease({
        template: withStep({ new_classes: ["A"], new_sqlite_classes: ["B"] }),
      }),
    });
    await s.p.create(input());
    expect(s.rows()[0].do_migration_tag).toBe(STEP_TAG);
  });
});

describe("Turnstile, one widget per env (H-T4b)", () => {
  it.each([
    ["AUTH_PROVIDERS contains email", { AUTH_PROVIDERS: "google, email" }],
    [
      "EMAIL_CODE_DOMAIN=on",
      {
        EMAIL_CODE_DOMAIN: "on",
        AUTH_PROVIDERS: "email",
        AUTH_DOMAINS: "finqore.example",
      },
    ],
  ])(
    "codes on (%s) with no Turnstile input is refused with zero calls",
    async (_n, vars) => {
      for (const ts of [
        undefined,
        { sitekey: "", secret: "" },
        { sitekey: TS.staging.sitekey, secret: "" },
        { sitekey: "", secret: TS.staging.secret },
      ]) {
        const s = setup();
        const e = await fails(
          s.mk({ turnstile: ts }).create(input("finqore", { vars })),
        );
        expect(e.message).toMatch(/Turnstile/);
        expect(s.fake.log).toEqual([]);
      }
    },
  );

  it.each([
    ["the content domain", ["open-artifacts-staging.page"]],
    ["an extra hostname", ["open-artifacts-staging.app", "evil.example"]],
    ["no hostname", []],
    ["a subdomain only", ["finqore.open-artifacts-staging.app"]],
  ])(
    "a widget whose domains are %s is refused before any write",
    async (_n, domains) => {
      const s = setup();
      (
        s.fake.turnstile.get(TS.staging.sitekey) as { domains: string[] }
      ).domains = domains;
      const e = await fails(s.p.create(input("finqore", { vars: CODES })));
      expect(e.message).toMatch(/Turnstile widget/);
      expect(s.fake.writes()).toEqual([]);
    },
  );

  it("a widget for the other env is refused before any write", async () => {
    const s = setup();
    const e = await fails(
      s.mk({ turnstile: TS.prod }).create(input("finqore", { vars: CODES })),
    );
    expect(e.message).toMatch(/Turnstile widget/);
    expect(s.fake.writes()).toEqual([]);
  });

  it("a widget with the env's domain but another name, or a missing widget, is refused before any write", async () => {
    const s = setup();
    (s.fake.turnstile.get(TS.staging.sitekey) as { name: string }).name =
      "someone-elses-widget";
    await fails(s.p.create(input("finqore", { vars: CODES })));
    s.fake.turnstile.clear();
    const e = await fails(s.p.create(input("finqore", { vars: CODES })));
    expect(e.message).toMatch(/Turnstile widget/);
    expect(s.fake.writes()).toEqual([]);
  });

  it("codes on uploads TURNSTILE_SITE_KEY as a var and TURNSTILE_SECRET as secret_text, after a read-only widget check", async () => {
    const s = setup();
    const inst = await s.p.create(input("finqore", { vars: CODES }));
    const meta = metaOf(uploads(s.fake)[0]?.body as string);
    expect(bindingOf(meta, "TURNSTILE_SITE_KEY")).toEqual({
      type: "plain_text",
      name: "TURNSTILE_SITE_KEY",
      text: TS.staging.sitekey,
    });
    expect(bindingOf(meta, "TURNSTILE_SECRET")).toEqual({
      type: "secret_text",
      name: "TURNSTILE_SECRET",
      text: TS.staging.secret,
    });
    expect(s.scriptOf(inst.id)?.secrets.get("TURNSTILE_SECRET")).toBe(
      TS.staging.secret,
    );
    const widgetCalls = s.fake.log.filter((e) =>
      e.path.includes("/challenges/widgets"),
    );
    expect(widgetCalls.map((e) => e.method)).toEqual(["GET"]);
    expect(widgetCalls[0]?.path).toBe(
      `/accounts/${s.fake.accountId}/challenges/widgets/${TS.staging.sitekey}`,
    );
  });

  it("a resume of a codes-on install that lost TURNSTILE_SECRET sends it again", async () => {
    const s = setup();
    await failAtHealth(s, input("finqore", { vars: CODES }));
    const [row] = s.rows();
    s.scriptOf(row.id)?.secrets.delete("TURNSTILE_SECRET");
    await s.p.create(input("finqore", { vars: CODES }));
    const ups = uploads(s.fake);
    expect(secretBindings(metaOf(ups[1]?.body as string))).toEqual([
      "TURNSTILE_SECRET",
    ]);
  });

  it("codes off sets neither and never reads the widget", async () => {
    const s = setup();
    const inst = await s.p.create(input());
    const meta = metaOf(uploads(s.fake)[0]?.body as string);
    expect(bindingOf(meta, "TURNSTILE_SITE_KEY")).toBeUndefined();
    expect(bindingOf(meta, "TURNSTILE_SECRET")).toBeUndefined();
    expect(s.scriptOf(inst.id)?.secrets.has("TURNSTILE_SECRET")).toBe(false);
    expect(s.fake.log.some((e) => e.path.includes("/challenges/"))).toBe(false);
  });

  it.each(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET"])(
    "%s passed in vars is refused with zero calls",
    async (k) => {
      const s = setup();
      await fails(
        s.p.create(
          input("finqore", { vars: { ...CODES, [k]: TS.staging.sitekey } }),
        ),
      );
      expect(s.fake.log).toEqual([]);
    },
  );

  it("the Turnstile secret never leaks into vars, notes, audit rows, platform rows or errors", async () => {
    const s = setup();
    s.fake.inject((m, p) => m === "PUT" && /\/scripts\/[^/]+$/.test(p), {
      message: `upload refused: ${TS.staging.secret}`,
    });
    const e = await fails(s.p.create(input("finqore", { vars: CODES })));
    expect(JSON.stringify(e)).not.toContain(TS.staging.secret);
    expect(e.message).not.toContain(TS.staging.secret);
    expect(String(e.stack)).not.toContain(TS.staging.secret);
    const inst = await s.p.create(input("finqore", { vars: CODES }));
    const meta = s.scriptOf(inst.id)?.metadata;
    expect(
      meta.bindings
        .filter((b: { type: string }) => b.type === "plain_text")
        .map((b: { text: string }) => b.text),
    ).not.toContain(TS.staging.secret);
    const all = JSON.stringify([
      s.p.notes,
      s.db().prepare("SELECT * FROM hosted_audit").all(),
      s.rows(),
      s.fake.log,
    ]);
    expect(all).not.toContain(TS.staging.secret);
    expect(SENSITIVE.has(TS.staging.secret)).toBe(true);
  });
});

describe("H-T4b round 1", () => {
  describe("F1: sealed gates, no option reaches them", () => {
    const keys = [
      { prodRecordWriter: "t3b" },
      { __testOnlyReleasePubkey: pubX(OTHER_SIGNER) },
      { __testOnlyAllowAccountTarget: true },
      { __testOnlyAnything: 1 },
      { PROD_UNLOCKED: true },
      { ALLOW_ACCOUNT_TARGET: true },
      { RELEASE_PUBKEY: { staging: pubX(OTHER_SIGNER) } },
    ];
    it.each(
      keys.flatMap((k) => [["spread", k] as const, ["JSON", k] as const]),
    )(
      "an options object carrying a gate name (%s %j) is refused at construction and unlocks nothing",
      async (how, k) => {
        await withGate("PROD_UNLOCKED", false, () =>
          withGate("ALLOW_ACCOUNT_TARGET", false, () =>
            withGate(
              "RELEASE_PUBKEY",
              {
                staging: RELEASE_PUBKEY_PLACEHOLDER,
                prod: RELEASE_PUBKEY_PLACEHOLDER,
              },
              async () => {
                for (const env of ["staging", "prod"] as const) {
                  const s = setup({ env });
                  const base = s.opts();
                  const o =
                    how === "spread"
                      ? { ...base, ...k }
                      : Object.assign({}, base, JSON.parse(JSON.stringify(k)));
                  let p: WfpProvisioner | undefined;
                  const e = (() => {
                    try {
                      p = new WfpProvisioner(o);
                    } catch (err) {
                      return err as Error;
                    }
                  })();
                  expect(e?.message).toMatch(/not an option/);
                  expect(p).toBeUndefined();
                  // Without the name, the gates still hold.
                  const plain = await fails(
                    new WfpProvisioner(base).create(input()),
                  );
                  expect(plain.message).toMatch(
                    env === "prod" ? /locked/ : /placeholder/,
                  );
                  expect(s.fake.log).toEqual([]);
                }
              },
            ),
          ),
        );
      },
    );

    it("the package index does not export the gates, and the package exports only its index and names", () => {
      for (const k of [
        "PROD_UNLOCKED",
        "ALLOW_ACCOUNT_TARGET",
        "RELEASE_PUBKEY",
        "RELEASE_PUBKEY_PLACEHOLDER",
      ])
        expect(Object.keys(INDEX)).not.toContain(k);
      const pkg = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      );
      // "./names" is the Worker-safe entry (no node:*, no gates) the dispatch
      // Worker bundles; nothing else is reachable by subpath.
      expect(Object.keys(pkg.exports)).toEqual([".", "./names"]);
      expect(pkg.exports["./names"].import).toBe("./dist/names.js");
    });

    it("the real gates: prod locked, no account target, both keys pinned and distinct", async () => {
      const real = await vi.importActual<
        typeof import("../src/internal/gates.js")
      >("../src/internal/gates.js");
      // Prod unlocks in its own PR, after the red-line suite passes on staging.
      expect(real.PROD_UNLOCKED).toBe(false);
      expect(real.ALLOW_ACCOUNT_TARGET).toBe(false);
      expect(real.RELEASE_PUBKEY_PLACEHOLDER).toMatch(/placeholder/i);
      expect(real.RELEASE_PUBKEY.staging).not.toBe(
        real.RELEASE_PUBKEY_PLACEHOLDER,
      );
      expect(real.RELEASE_PUBKEY.prod).not.toBe(
        real.RELEASE_PUBKEY_PLACEHOLDER,
      );
      expect(real.RELEASE_PUBKEY.staging).not.toBe(real.RELEASE_PUBKEY.prod);
      expect(Object.isFrozen(real.RELEASE_PUBKEY)).toBe(true);
    });
  });

  describe("F2: records are bound to env and version", () => {
    it("a staging-signed record is refused in prod, even under the same key", async () => {
      expect(G.RELEASE_PUBKEY.staging).toBe(G.RELEASE_PUBKEY.prod);
      const stagingRec = recordOf("release", "0.23.0", { env: "staging" });
      for (const [n, rec] of [
        ["staging record, staging signature", signRecord(stagingRec)],
        [
          "staging record, prod-domain signature",
          signRecord(stagingRec, SIGNER.privateKey, "prod"),
        ],
        [
          "prod record, staging-domain signature",
          signRecord(
            recordOf("release", "0.23.0", { env: "prod" }),
            SIGNER.privateKey,
            "staging",
          ),
        ],
      ] as const) {
        const s = setup({
          env: "prod",
          release: makeRelease({ env: "prod" }, { record: async () => rec }),
        });
        const e = await fails(s.p.create(input()));
        expect(e.message, n).toMatch(/signature|env/);
        expect(s.fake.log, n).toEqual([]);
      }
    });

    it("a signature over the bare record, or a record without env, is refused", async () => {
      const rec = recordOf("release");
      const bare = {
        record: canonicalJson(rec),
        signature: sign(
          null,
          Buffer.from(canonicalJson(rec)),
          SIGNER.privateKey,
        ).toString("base64url"),
      };
      const { env: _e, ...noEnv } = rec;
      for (const r of [
        bare,
        signRecord(noEnv as ReleaseRecord, SIGNER.privateKey, "staging"),
      ]) {
        const s = setup({
          release: makeRelease({}, { record: async () => r }),
        });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/signature|env/);
        expect(s.fake.log).toEqual([]);
      }
    });

    it("a signed record for another version is refused with zero calls", async () => {
      const s = setup({
        release: makeRelease(
          {},
          { record: async () => signRecord(recordOf("release", "0.23.1")) },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/is for 0\.23\.1/);
      expect(s.fake.log).toEqual([]);
    });

    it("a downgrade below the install's current version is refused before any write", async () => {
      const s = setup();
      await failAtHealth(s);
      const writes = s.fake.writes().length;
      const e = await fails(
        s.p.create(input("finqore", { version: "0.22.9" })),
      );
      expect(e.message).toMatch(/downgrade/);
      expect(s.fake.writes().length).toBe(writes);
      // The same version resumes.
      await s.p.create(input());
    });

    it("compareVersions orders releases, prereleases first", () => {
      expect(compareVersions("0.23.0", "0.22.9")).toBeGreaterThan(0);
      expect(compareVersions("0.23.0", "0.23.0")).toBe(0);
      expect(compareVersions("0.23.0-rc.1", "0.23.0")).toBeLessThan(0);
      expect(compareVersions("0.23.0-rc.2", "0.23.0-rc.10")).toBeLessThan(0);
      expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
      expect(() => compareVersions("v1", "1.0.0")).toThrow(/version/);
    });

    it("the verified record is a private frozen copy: a reader mutating its object later changes nothing", async () => {
      const signed = signRecord(recordOf("release"));
      const evil = makeBundle("redline");
      const s = setup({
        release: makeRelease(
          {},
          {
            record: async () => signed,
            modules: async () => {
              signed.record = canonicalJson({
                ...JSON.parse(signed.record),
                sha256: bundleSha256(evil),
              });
              return evil;
            },
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/modules do not match/);
      expect(s.fake.log).toEqual([]);
    });
  });

  describe("F3: the welcome text comes from the release", () => {
    it("the published Welcome artifact is the release's text", async () => {
      const s = setup();
      await s.p.create(input());
      expect([...s.fake.artifacts.values()][0]?.content).toBe(
        new TextDecoder().decode(WELCOME_BYTES),
      );
    });

    it("a welcome text that differs from the signed record is refused with zero calls", async () => {
      const s = setup({
        release: makeRelease(
          {},
          { welcome: async () => enc("# Welcome to Open Artifacts\nphish") },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/welcome do not match the signed record/);
      expect(s.fake.log).toEqual([]);
    });

    it("a welcome text swapped before publishing is refused, and nothing is published", async () => {
      const s = setup({
        release: makeRelease(
          {},
          {
            welcome: swapAfterFirst(
              async () => WELCOME_BYTES,
              async () => enc("# Welcome to Open Artifacts\nphish"),
            ),
          },
        ),
      });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/welcome do not match the signed record/);
      expect((s.release as ReturnType<typeof makeRelease>).calls.welcome).toBe(
        2,
      );
      expect(s.fake.artifacts.size).toBe(0);
    });
  });

  describe("LOWs", () => {
    it("F5: userWorkerMetadata needs a template (no checkout fallback)", () => {
      expect(() =>
        userWorkerMetadata(
          {
            id: "iaaaaaaaaaaa",
            appHost: "a.open-artifacts-staging.app",
            contentHost: "a.open-artifacts-staging.page",
            ownerEmail: OWNER,
            vars: {},
            testHooks: false,
          },
          {
            d1Id: "00000000-0000-4000-8000-000000000000",
            kvId: "0".repeat(32),
            version: "0.23.0",
            rlNs: 1_000_000,
            doMigrationTag: null,
            env: "staging",
            target: "namespace",
            mode: "update",
            mainModule: "index.js",
            assetsJwt: "j",
          } as never,
        ),
      ).toThrow(/template/);
    });

    it.each([
      "AUTH_PROVIDERS",
      "EMAIL_CODE_DOMAIN",
      "TURNSTILE_SITE_KEY",
      "TURNSTILE_SECRET",
    ])(
      "F6: a release template that sets %s in vars is refused with zero calls",
      async (k) => {
        const t = structuredClone(loadTemplate());
        t.vars = { ...(t.vars ?? {}), [k]: "email" };
        const s = setup({ release: makeRelease({ template: t }) });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(new RegExp(k));
        expect(s.fake.log).toEqual([]);
      },
    );

    it("F6: a template whose var duplicates a binding name is refused with zero calls", async () => {
      const t = structuredClone(loadTemplate());
      t.vars = { ...(t.vars ?? {}), DB: "x" };
      const s = setup({ release: makeRelease({ template: t }) });
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/duplicate binding/);
      expect(s.fake.log).toEqual([]);
    });

    it("F7: readAssetsDir refuses an intermediate directory symlink", async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), "oa-t4b-elsewhere-"));
      writeFileSync(join(elsewhere, "a.txt"), "secret");
      const dir = mkdtempSync(join(tmpdir(), "oa-t4b-assets-"));
      writeFileSync(join(dir, "index.html"), "i");
      symlinkSync(elsewhere, join(dir, "link-dir"));
      expect((await fails(readTreeHardened(dir))).message).toMatch(/symlink/);
    });

    it.each([
      [
        "more than 20,000 assets",
        () =>
          Array.from({ length: 20_001 }, (_, i) => ({
            path: `f${String(i).padStart(5, "0")}.txt`,
            size: 1,
            sha256: "a".repeat(64),
          })),
      ],
      [
        "an asset over 25 MiB",
        () => [
          {
            path: "big.bin",
            size: 25 * 1024 * 1024 + 1,
            sha256: "a".repeat(64),
          },
        ],
      ],
      [
        "assets over 512 MiB in total",
        () =>
          Array.from({ length: 21 }, (_, i) => ({
            path: `b${String(i).padStart(2, "0")}.bin`,
            size: 25 * 1024 * 1024,
            sha256: "a".repeat(64),
          })),
      ],
    ])(
      "F8: a record with %s is refused before any other read",
      async (_n, assets) => {
        const s = setup({
          release: makeRelease(
            {},
            {
              record: async () =>
                signRecord({ ...recordOf("release"), assets: assets() }),
            },
          ),
        });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/assets|asset/);
        expect(
          (s.release as ReturnType<typeof makeRelease>).calls.modules,
        ).toBe(0);
        expect(s.fake.log).toEqual([]);
      },
    );

    it.each(["%2eenv", "．env", "a b.txt", "café.js", "a?b", "a#b", "a:b"])(
      "F8: asset path %j is outside the plain charset and refused",
      async (path) => {
        const s = setup({
          release: makeRelease(
            {},
            { assets: async () => [...ASSETS, { path, bytes: enc("x") }] },
          ),
        });
        const e = await fails(s.p.create(input()));
        expect(e.message).toMatch(/asset path/);
        expect(s.fake.log).toEqual([]);
      },
    );

    it("F10: a swap on the 412-probe retry read is refused before the retry upload", async () => {
      const s = setup({
        release: makeRelease({
          template: (() => {
            const t = structuredClone(loadTemplate());
            t.migrations = [
              { tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] },
              { tag: "v2", new_sqlite_classes: ["C1"] },
            ];
            return t;
          })(),
        }),
      });
      await failAtHealth(s);
      const [row] = s.rows();
      s.db()
        .prepare("UPDATE installs SET do_migration_tag = NULL WHERE id = ?")
        .run(row.id);
      const t = structuredClone(loadTemplate());
      t.migrations = [
        { tag: "v1", new_sqlite_classes: ["ArtifactRuntime"] },
        { tag: "v2", new_sqlite_classes: ["C1"] },
      ];
      // Reads: 1 pre-flight, 2 the probe upload (412), 3 the retry.
      const p2 = s.mk({
        release: makeRelease(
          { template: t },
          {
            modules: swapAfterFirst(
              async () => makeBundle("release"),
              async () => makeBundle("redline"),
              2,
            ),
          },
        ),
      });
      const e = await fails(p2.create(input()));
      expect(e.message).toMatch(/modules do not match the signed record/);
      expect(uploads(s.fake).map((u) => u.status)).toEqual([200, 412]);
    });

    it("F10: uppercase punycode is refused too", () => {
      for (const slug of ["XN--abc", "Xn--abc", "AB--c"])
        expect(() => hostsOf(slug)).toThrow(/slug/);
    });
  });
});

describe("cfClient", () => {
  const client = () => {
    const fake = new FakeCf();
    FAKES.push(fake);
    SENSITIVE.add(fake.token);
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    return { fake, cf };
  };

  it("retries 429 and 5xx three times and never puts the request body in the error", async () => {
    const { fake, cf } = client();
    const secret = "s3cr3t-value-that-must-not-leak-0123456789";
    SENSITIVE.add(secret);
    fake.inject((m, p) => m === "PUT" && p.endsWith("/secrets"), {
      status: 503,
      times: 3,
    });
    const e = await fails(
      cf.secretPut(
        { kind: "namespace", ns: "oa-staging" },
        "oa-s-iaaaaaaaaaaa",
        "SESSION_SECRET",
        secret,
      ),
    );
    expect(e).toBeInstanceOf(CfError);
    expect((e as CfError).status).toBe(503);
    expect(fake.log.filter((x) => x.path.endsWith("/secrets"))).toHaveLength(3);
    expect(e.message).not.toContain(secret);
    expect(e.message).not.toContain(fake.token);
    fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      status: 429,
    });
    await cf.r2Create("oa-s-x");
    expect(fake.r2.has("oa-s-x")).toBe(true);
  });

  it("does not retry other 4xx", async () => {
    const { fake, cf } = client();
    fake.inject((m, p) => m === "POST" && p.endsWith("/r2/buckets"), {
      status: 400,
    });
    await fails(cf.r2Create("oa-s-x"));
    expect(fake.log).toHaveLength(1);
  });

  it("kvGet returns null only for a missing key, and throws for a missing namespace", async () => {
    const { fake, cf } = client();
    const id = fake.seedKv("oa-s-hosts");
    expect(await cf.kvGet(id, "nope.example")).toBeNull();
    const e = await fails(cf.kvGet("f".repeat(32), "nope.example"));
    expect((e as CfError).status).toBe(404);
  });

  it("d1Get pages through the D1 list until it finds the name (H-T4b L6)", async () => {
    const { fake, cf } = client();
    for (let i = 0; i < 150; i++) fake.seedD1(`oa-s-paged-copy-${i}`);
    const id = fake.seedD1("oa-s-paged");
    expect(await cf.d1Get("oa-s-paged")).toBe(id);
    const pages = fake.log
      .filter((e) => e.path.includes("/d1/database?"))
      .map((e) => new URL(e.path, "https://x").searchParams.get("page"));
    expect(pages).toEqual(["1", "2"]);
    expect(await cf.d1Get("oa-s-nowhere")).toBeNull();
  });

  it("F9: d1Get trusts total_pages: a full final page, a clamped per_page, and no result_info", async () => {
    const pagesOf = (fake: Fake) =>
      fake.log
        .filter((e) => e.path.includes("/d1/database?"))
        .map((e) => new URL(e.path, "https://x").searchParams.get("page"));
    {
      const { fake, cf } = client();
      for (let i = 0; i < 100; i++) fake.seedD1(`oa-s-full-copy-${i}`);
      expect(await cf.d1Get("oa-s-full")).toBeNull();
      expect(pagesOf(fake)).toEqual(["1"]);
    }
    {
      const { fake, cf } = client();
      for (let i = 0; i < 199; i++) fake.seedD1(`oa-s-full-copy-${i}`);
      const id = fake.seedD1("oa-s-full");
      expect(await cf.d1Get("oa-s-full")).toBe(id);
      expect(pagesOf(fake)).toEqual(["1", "2"]);
    }
    {
      const { fake, cf } = client();
      fake.d1PerPageCap = 50;
      for (let i = 0; i < 120; i++) fake.seedD1(`oa-s-clamp-copy-${i}`);
      const id = fake.seedD1("oa-s-clamp");
      expect(await cf.d1Get("oa-s-clamp")).toBe(id);
      expect(pagesOf(fake)).toEqual(["1", "2", "3"]);
    }
    {
      const { fake, cf } = client();
      fake.d1ResultInfo = false;
      for (let i = 0; i < 150; i++) fake.seedD1(`oa-s-noinfo-copy-${i}`);
      const id = fake.seedD1("oa-s-noinfo");
      expect(await cf.d1Get("oa-s-noinfo")).toBe(id);
      expect(await cf.d1Get("oa-s-none")).toBeNull();
    }
  });

  it("d1Batch runs all statements or none", async () => {
    const { fake, cf } = client();
    const id = fake.seedD1("oa-s-x", "CREATE TABLE t (k TEXT PRIMARY KEY)");
    await fails(
      cf.d1Batch(id, [
        { sql: "INSERT INTO t (k) VALUES (?1)", params: ["a"] },
        { sql: "INSERT INTO t (k) VALUES (?1)", params: ["a"] },
      ]),
    );
    const r = await cf.d1Query(id, "SELECT count(*) AS n FROM t");
    expect(r[0]?.results).toEqual([{ n: 0 }]);
  });
});

describe("platform D1 migration (decisions 10, M1, M3)", () => {
  const db = () => {
    const d = new Sqlite(":memory:");
    for (const s of splitSql(PLATFORM_SQL)) d.exec(s);
    return d;
  };
  const row = (o: Record<string, unknown> = {}) => ({
    id: "i1",
    slug: "a",
    app_host: "a.app.test",
    content_host: "a.content.test",
    owner_email: "o@x.test",
    inputs_hash: "h",
    rl_ns: 1_000_000,
    state: "creating",
    test_hooks: 0,
    created_at: 1,
    updated_at: 1,
    ...o,
  });
  const ins = (d: Sqlite, r: Record<string, unknown>) => {
    const k = Object.keys(r);
    d.prepare(
      `INSERT INTO installs (${k.join(", ")}) VALUES (${k.map(() => "?").join(", ")})`,
    ).run(...(Object.values(r) as (string | number | null)[]));
  };

  it("has the full installs schema", () => {
    const cols = db()
      .prepare("PRAGMA table_info(installs)")
      .all()
      .map((c) => (c as { name: string }).name);
    expect(cols).toEqual([
      "id",
      "slug",
      "app_host",
      "content_host",
      "owner_email",
      "d1_id",
      "kv_id",
      "version",
      "previous_version",
      "rl_ns",
      "do_migration_tag",
      "test_hooks",
      "inputs_hash",
      "broker_kid",
      "state",
      "created_at",
      "updated_at",
      // 0003 (Task 5): the operation lock, current vars, a session cut owed.
      "lease",
      "lease_until",
      "vars",
      "session_cut",
      "row_version",
      "session_cut_base",
      "session_cut_armed",
    ]);
  });

  it.each([
    "slug",
    "app_host",
    "content_host",
    "rl_ns",
    "state",
    "owner_email",
    "created_at",
    "updated_at",
    "inputs_hash",
  ])("installs.%s is NOT NULL", (col) => {
    const d = db();
    expect(() => ins(d, row({ [col]: null }))).toThrow(/NOT NULL/);
  });

  it.each([
    [
      "slug",
      {
        id: "i2",
        app_host: "b.app.test",
        content_host: "b.content.test",
        rl_ns: 1_000_008,
      },
    ],
    [
      "app_host",
      { id: "i2", slug: "b", content_host: "b.content.test", rl_ns: 1_000_008 },
    ],
    [
      "content_host",
      { id: "i2", slug: "b", app_host: "b.app.test", rl_ns: 1_000_008 },
    ],
    [
      "rl_ns",
      {
        id: "i2",
        slug: "b",
        app_host: "b.app.test",
        content_host: "b.content.test",
      },
    ],
  ])("installs.%s is UNIQUE", (_c, over) => {
    const d = db();
    ins(d, row());
    expect(() => ins(d, row(over))).toThrow(/UNIQUE/);
  });

  it("rl_ns is a multiple of 8; state, test_hooks and app_host <> content_host are checked; deleted is a state", () => {
    const d = db();
    expect(() => ins(d, row({ rl_ns: 1_000_004 }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ state: "bogus" }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ test_hooks: 2 }))).toThrow(/CHECK/);
    expect(() => ins(d, row({ content_host: "a.app.test" }))).toThrow(/CHECK/);
    ins(d, row({ state: "deleted" }));
  });

  it("hosts holds each host once, across app and content columns of different installs", () => {
    const d = db();
    ins(d, row());
    ins(
      d,
      row({
        id: "i2",
        slug: "b",
        app_host: "b.app.test",
        content_host: "b.content.test",
        rl_ns: 1_000_008,
      }),
    );
    const h = d.prepare("INSERT INTO hosts (host, install_id) VALUES (?, ?)");
    h.run("a.content.test", "i1");
    expect(() => h.run("a.content.test", "i2")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => h.run(null, "i2")).toThrow();
    expect(() => h.run("c.app.test", null)).toThrow(/NOT NULL/);
  });

  it("hosted_audit is append-only", () => {
    const d = db();
    d.prepare(
      "INSERT INTO hosted_audit (at, install_id, action) VALUES (1, 'i', 'x')",
    ).run();
    expect(() =>
      d.prepare("UPDATE hosted_audit SET action = 'y'").run(),
    ).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM hosted_audit").run()).toThrow(
      /append-only/,
    );
  });
});

/** Every printable surface of every fake and provisioner created in this file. */
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
      rows.push(JSON.stringify(d.db.prepare("SELECT * FROM installs").all()));
      rows.push(JSON.stringify(d.db.prepare("SELECT * FROM hosts").all()));
    }
  }
  for (const p of PROVS) parts.push(JSON.stringify(p.notes));
  return { all: parts.join("\n"), rows: rows.join("\n") };
}

afterAll(() => {
  const { all, rows } = haystacks();
  const leaks = [...SENSITIVE, ...EMAILS].filter(
    (v) => v.length >= 8 && all.includes(v),
  );
  // Platform rows hold the owner email by design; they must hold no secret.
  const rowLeaks = [...SENSITIVE].filter(
    (v) => v.length >= 8 && rows.includes(v),
  );
  if (leaks.length + rowLeaks.length > 0)
    throw new Error(
      `${leaks.length + rowLeaks.length} sensitive value(s) leaked into errors, logs, notes or platform rows`,
    );
});

describe("no secret in any error or printable output", () => {
  it("collected values", () => {
    expect(SENSITIVE.size).toBeGreaterThan(50);
    expect(THROWN.length).toBeGreaterThan(20);
    const { all, rows } = haystacks();
    for (const v of [...SENSITIVE, ...EMAILS])
      if (v.length >= 8)
        expect(all.includes(v), "a sensitive value leaked").toBe(false);
    for (const v of SENSITIVE)
      if (v.length >= 8)
        expect(rows.includes(v), "a secret is in a platform row").toBe(false);
  });
});

describe("EMAIL_CODE_DOMAIN for the hosted trial (H-ECD)", () => {
  const GOOD = {
    EMAIL_CODE_DOMAIN: "on",
    AUTH_PROVIDERS: "email",
    AUTH_DOMAINS: "finqore.example",
  };

  it.each([
    [
      "email not in AUTH_PROVIDERS",
      { ...GOOD, AUTH_PROVIDERS: "" },
      /AUTH_PROVIDERS/,
    ],
    [
      "AUTH_PROVIDERS absent",
      { EMAIL_CODE_DOMAIN: "on", AUTH_DOMAINS: "finqore.example" },
      /AUTH_PROVIDERS/,
    ],
    [
      "google in AUTH_PROVIDERS",
      { ...GOOD, AUTH_PROVIDERS: "google,email" },
      /google/,
    ],
    [
      "AUTH_DOMAINS absent",
      { ...GOOD, AUTH_DOMAINS: undefined },
      /AUTH_DOMAINS/,
    ],
    ["AUTH_DOMAINS empty", { ...GOOD, AUTH_DOMAINS: "" }, /AUTH_DOMAINS/],
  ])(
    "%s is refused with zero calls, and the message has no values",
    async (_n, v, re) => {
      const vars = Object.fromEntries(
        Object.entries(v).filter(([, x]) => x !== undefined),
      ) as Record<string, string>;
      const s = setup();
      const e = await fails(s.p.create(input("finqore", { vars })));
      expect(e.message).toMatch(re);
      // Only the domain list is a free-form value; it must never be echoed.
      expect(e.message).not.toContain("finqore.example");
      expect(s.fake.log).toEqual([]);
    },
  );

  it("missing Turnstile input is refused with zero calls", async () => {
    const s = setup();
    const e = await fails(
      s.mk({ turnstile: undefined }).create(input("finqore", { vars: GOOD })),
    );
    expect(e.message).toMatch(/Turnstile/);
    expect(s.fake.log).toEqual([]);
  });

  it("names the first failing condition when several fail", async () => {
    const s = setup();
    const e = await fails(
      s.mk({ turnstile: undefined }).create(
        input("finqore", {
          vars: { EMAIL_CODE_DOMAIN: "on", AUTH_PROVIDERS: "google,email" },
        }),
      ),
    );
    expect(e.message).toMatch(/google/);
    expect(s.fake.log).toEqual([]);
  });

  it.each(["ON", "On", "true", "1", "yes", " on", "on ", ""])(
    "EMAIL_CODE_DOMAIN=%j is refused with zero calls",
    async (v) => {
      const s = setup();
      await fails(
        s.p.create(
          input("finqore", { vars: { ...GOOD, EMAIL_CODE_DOMAIN: v } }),
        ),
      );
      expect(s.fake.log).toEqual([]);
    },
  );

  it("all conditions met uploads EMAIL_CODE_DOMAIN=on", async () => {
    const s = setup();
    await s.p.create(input("finqore", { vars: GOOD }));
    const meta = metaOf(uploads(s.fake)[0]?.body as string);
    expect(bindingOf(meta, "EMAIL_CODE_DOMAIN")).toEqual({
      type: "plain_text",
      name: "EMAIL_CODE_DOMAIN",
      text: "on",
    });
    expect(bindingOf(meta, "TURNSTILE_SITE_KEY")?.text).toBe(
      TS.staging.sitekey,
    );
  });

  it('"off" and absent both upload no EMAIL_CODE_DOMAIN', async () => {
    for (const vars of [
      {} as Record<string, string>,
      { EMAIL_CODE_DOMAIN: "off" },
      { ...CODES, EMAIL_CODE_DOMAIN: "off" },
      { ...CODES, AUTH_PROVIDERS: "google,email", EMAIL_CODE_DOMAIN: "off" },
    ]) {
      const s = setup();
      await s.p.create(input("finqore", { vars }));
      const meta = metaOf(uploads(s.fake)[0]?.body as string);
      expect(bindingOf(meta, "EMAIL_CODE_DOMAIN")).toBeUndefined();
    }
  });

  it('"off" behaves exactly like absent (no Turnstile needed)', async () => {
    const s = setup();
    await s
      .mk({ turnstile: undefined })
      .create(input("finqore", { vars: { EMAIL_CODE_DOMAIN: "off" } }));
    expect(s.fake.log.some((e) => e.path.includes("/challenges/"))).toBe(false);
  });
});

describe("frozen constants (H-ECD)", () => {
  it("NAMESPACES, HOSTED_DOMAINS and ENV_PREFIX are frozen, deeply", () => {
    for (const o of [
      NAMESPACES,
      HOSTED_DOMAINS,
      HOSTED_DOMAINS.prod,
      HOSTED_DOMAINS.staging,
      ENV_PREFIX,
    ]) {
      expect(Object.isFrozen(o)).toBe(true);
      expect(() => {
        (o as Record<string, unknown>).prod = "x";
      }).toThrow(TypeError);
      expect(() => {
        (o as Record<string, unknown>).extra = "x";
      }).toThrow(TypeError);
    }
    expect(NAMESPACES.prod).toBe("oa-prod");
    expect(HOSTED_DOMAINS.prod.app).toBe("open-artifacts.app");
    expect(ENV_PREFIX.prod).toBe("oa-p-");
  });

  it("the package index no longer exports loadTemplate", () => {
    expect("loadTemplate" in INDEX).toBe(false);
  });
});

describe("T3b E: the signed floor gates create", () => {
  const floorSeq = (s: ReturnType<typeof setup>) =>
    (
      s
        .db()
        .prepare("SELECT floor_seq FROM release_floor WHERE id = 1")
        .get() as { floor_seq: number } | undefined
    )?.floor_seq;

  it.each<[string, unknown, RegExp]>([
    ["a missing floor", null, /floor/],
    ["an unsigned floor", { record: canonicalJson(floorOf()) }, /floor/],
    [
      "a wrong-key floor",
      signFloor(floorOf(), OTHER_SIGNER.privateKey),
      /floor/,
    ],
    ["another env's floor", signFloor(floorOf({}, "prod")), /floor/],
    ["a release record as the floor", signRecord(recordOf("release")), /floor/],
    [
      "a version below minVersion",
      signFloor(floorOf({ minVersion: "0.24.0" })),
      /below/,
    ],
    [
      "a revoked version",
      signFloor(floorOf({ revoked: ["0.23.0"] })),
      /revoked/,
    ],
  ])("%s is refused with zero calls", async (_n, floor, re) => {
    const s = setup({ release: makeRelease({ floor }) });
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(re);
    expect(s.fake.log).toEqual([]);
    const c = (s.release as ReturnType<typeof makeRelease>).calls;
    expect([c.modules, c.assets]).toEqual([0, 0]);
  });

  it("a floor below FLOOR_MIN_SEQ is refused with zero calls, even with a valid signature", async () => {
    const s = setup({
      release: makeRelease({ floor: signFloor(floorOf({ seq: 2 })) }),
    });
    await withGate("FLOOR_MIN_SEQ", { staging: 3, prod: 1 }, async () => {
      const e = await fails(s.p.create(input()));
      expect(e.message).toMatch(/seq 2 is below 3/);
      expect(s.fake.log).toEqual([]);
    });
  });

  it("a lower-seq floor with a valid signature is refused below the D1 floor_seq cache, with zero writes", async () => {
    const s = setup({
      release: makeRelease({ floor: signFloor(floorOf({ seq: 4 })) }),
    });
    s.db()
      .prepare("INSERT INTO release_floor (id, floor_seq) VALUES (1, 5)")
      .run();
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/seq 4 is below 5/);
    expect(nonReads(s.fake)).toEqual([]);
    expect(s.rows()).toEqual([]);
  });

  it("N1: a non-integer floor_seq in D1 is refused, not read as 0", async () => {
    const s = setup({
      release: makeRelease({ floor: signFloor(floorOf({ seq: 4 })) }),
    });
    s.db()
      .prepare("INSERT INTO release_floor (id, floor_seq) VALUES (1, 'x')")
      .run();
    const e = await fails(s.p.create(input()));
    expect(e.message).toMatch(/floor_seq/);
    expect(nonReads(s.fake)).toEqual([]);
  });

  it("create raises floor_seq to the floor's seq with MAX, never lowering it", async () => {
    const s = setup({
      release: makeRelease({ floor: signFloor(floorOf({ seq: 7 })) }),
    });
    expect(floorSeq(s)).toBeUndefined();
    await s.p.create(input());
    expect(floorSeq(s)).toBe(7);
    const sql = s.fake.raw
      .map((r) => r.body)
      .filter((b) => b.includes("release_floor") && !/"sql":"SELECT/.test(b));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("SET floor_seq = MAX(floor_seq, ");
    // The same seq again: no second write.
    await s.p.create(input("second"));
    expect(floorSeq(s)).toBe(7);
  });

  it("a create from the R2 release reader works end to end after publishRelease", async () => {
    const s = setup();
    const cf = s.opts().cf;
    s.fake.r2.add(platformNames("staging").releases);
    s.fake.r2Seed(
      platformNames("staging").releases,
      FLOOR_KEY,
      enc(JSON.stringify(signFloor(floorOf()))),
    );
    const files = [
      ...makeBundle("release").modules.map((m) => ({
        path: `modules/${m.name}`,
        bytes: m.bytes,
      })),
      ...ASSETS.map((a) => ({ path: `assets/${a.path}`, bytes: a.bytes })),
      { path: "template/wrangler.template.jsonc", bytes: TEMPLATE_BYTES },
      ...MIGRATION_FILES.map((f) => ({
        path: `migrations/${f.name}`,
        bytes: f.bytes,
      })),
      { path: "welcome/welcome.md", bytes: WELCOME_BYTES },
    ];
    await probeR2Conditionals(cf, "staging");
    await publishRelease({
      cf,
      env: "staging",
      version: "0.23.0",
      files: {
        tar: packUstar(files),
        sig: enc(JSON.stringify(signRecord(recordOf("release")))),
      },
    });
    const p = s.mk({ release: r2ReleaseReader(cf, "staging") });
    const inst = await p.create(input());
    expect(inst.version).toBe("0.23.0");
    const sc = s.scriptOf(inst.id);
    expect(sc?.modules.get("index.js")?.bytes).toEqual(
      makeBundle("release").modules[0]?.bytes,
    );
  });
});

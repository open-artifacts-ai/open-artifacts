// T3b: the hardened tree reader, the stored signature format, the record
// builder, the in-memory ustar reader, publishRelease, the signed floor and
// the R2 ReleaseReader. Everything runs against FakeCf and test keys.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertNoHookRoutes,
  assertSameConfigButDefine,
  readTreeHardened as libReadTree,
  packUstar,
} from "../../../scripts/ci/release-artifact.mjs";
import { buildBundle } from "../src/bundle.js";
import { type CfError, cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { canonicalJson } from "../src/platform.js";
import {
  FLOOR_KEY,
  PublishRefused,
  probeR2Conditionals,
  publishFloor,
  publishRelease,
  r2ReleaseReader,
  releaseKey,
} from "../src/publish.js";
import { r2S3Client } from "../src/r2s3.js";
import {
  ASSET_LIMITS,
  buildReleaseRecord,
  bundleSha256,
  type FloorRecord,
  floorRefusal,
  openFloor,
  openReleaseRecord,
  parseStrictJson,
  type ReleaseRecord,
  readTreeHardened,
  TEST_HOOKS_DEFINE,
  verifyReleaseSignature,
} from "../src/release.js";
import { parseUstar, ustarFits } from "../src/tar.js";
import { FakeCf } from "./fake-cf.js";

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
  FLOOR_MIN_SEQ: { staging: 1, prod: 1 } as Record<string, number>,
}));
vi.mock("../src/internal/gates.js", async (orig) => {
  const m = await orig<typeof import("../src/internal/gates.js")>();
  return {
    ...m,
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
    get FLOOR_MIN_SEQ() {
      return G.FLOOR_MIN_SEQ;
    },
  };
});

const ROOT = new URL("../../../", import.meta.url);
const enc = (s: string) => new TextEncoder().encode(s);

const KEYS = {
  staging: generateKeyPairSync("ed25519"),
  prod: generateKeyPairSync("ed25519"),
};
const OTHER = generateKeyPairSync("ed25519");
const pubX = (k: { publicKey: KeyObject }) =>
  k.publicKey.export({ format: "jwk" }).x as string;
G.RELEASE_PUBKEY = { staging: pubX(KEYS.staging), prod: pubX(KEYS.prod) };

async function fails(p: Promise<unknown> | (() => unknown)): Promise<Error> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a failure");
}

// ---------- fixtures ----------

const TEMPLATE = new Uint8Array(
  readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
);
const MIGRATIONS = [
  { name: "0000_init.sql", bytes: enc("CREATE TABLE a (x);\n") },
  { name: "0001_more.sql", bytes: enc("CREATE TABLE b (y);\n") },
];
const WELCOME = enc("# Welcome\n");
const ASSETS = [
  { path: "index.html", bytes: enc("<!doctype html><p>hi</p>") },
  { path: "assets/app.js", bytes: enc("console.log(1)") },
];
const modulesOf = (variant: "release" | "redline") => [
  {
    name: "index.js",
    type: "esm" as const,
    bytes: enc(`const h = ${variant === "redline"};\nexport default {};\n`),
  },
];

type Spec = {
  env?: "staging" | "prod";
  variant?: "release" | "redline";
  version?: string;
};
const recordOf = (s: Spec = {}): ReleaseRecord =>
  buildReleaseRecord({
    env: s.env ?? "staging",
    version: s.version ?? "0.34.0",
    variant: s.variant ?? "release",
    mainModule: "index.js",
    modules: modulesOf(s.variant ?? "release"),
    assets: ASSETS,
    template: TEMPLATE,
    migrations: MIGRATIONS,
    welcome: WELCOME,
  });

/** The stored form: the record as its canonical string, signed with the domain prefix. */
const signString = (
  recordString: string,
  env: string,
  key: KeyObject,
  domain = "oa-release-v1",
) => ({
  record: recordString,
  signature: sign(
    null,
    Buffer.from(`${domain}\n${env}\n${recordString}`),
    key,
  ).toString("base64url"),
});
const signRec = (
  rec: unknown,
  env = (rec as { env: string }).env,
  key = KEYS[env as "staging"].privateKey,
) => signString(canonicalJson(rec), env, key);

/** The tar entries the release workflow packs for one variant. */
const tarEntries = (variant: "release" | "redline" = "release") => [
  ...modulesOf(variant).map((m) => ({
    path: `modules/${m.name}`,
    bytes: m.bytes,
  })),
  ...ASSETS.map((a) => ({ path: `assets/${a.path}`, bytes: a.bytes })),
  { path: "template/wrangler.template.jsonc", bytes: TEMPLATE },
  ...MIGRATIONS.map((m) => ({ path: `migrations/${m.name}`, bytes: m.bytes })),
  { path: "welcome/welcome.md", bytes: WELCOME },
];
const sigBytes = (o: unknown) => enc(JSON.stringify(o));

// A raw ustar header, independent of the packer under test.
function header(
  name: string,
  o: {
    type?: string;
    size?: number;
    prefix?: string;
    magic?: string;
    version?: string;
    linkname?: string;
    badSum?: boolean;
  } = {},
): Uint8Array {
  const h = new Uint8Array(512);
  const put = (off: number, len: number, s: string) =>
    h.set(enc(s).slice(0, len), off);
  put(0, 100, name);
  put(100, 8, "0000644\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, `${(o.size ?? 0).toString(8).padStart(11, "0")}\0`);
  put(136, 12, "00000000000\0");
  put(156, 1, o.type ?? "0");
  put(157, 100, o.linkname ?? "");
  put(257, 6, o.magic ?? "ustar\0");
  put(263, 2, o.version ?? "00");
  put(345, 155, o.prefix ?? "");
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  if (o.badSum) sum += 1;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}
const block = (data: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const END = new Uint8Array(1024);
const rawTar = (
  entries: {
    name: string;
    data?: Uint8Array;
    o?: Parameters<typeof header>[1];
  }[],
  tail: Uint8Array = END,
) =>
  concat(
    ...entries.flatMap((e) => [
      header(e.name, { size: e.data?.length ?? 0, ...e.o }),
      block(e.data ?? new Uint8Array()),
    ]),
    tail,
  );

function setup() {
  const fake = new FakeCf();
  const bucket = platformNames("staging").releases;
  fake.r2.add(bucket);
  fake.r2.add(platformNames("prod").releases);
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  // H-S3: one R2 API token per env, scoped to that env's releases bucket.
  const s3 = (env: "staging" | "prod") =>
    r2S3Client({
      accountId: fake.accountId,
      env,
      credentials: fake.r2Token(platformNames(env).releases),
      fetch: fake.fetch,
      sleep: async () => {},
    });
  const r2 = { staging: s3("staging"), prod: s3("prod") };
  return { fake, cf, r2, bucket };
}

/** M2: publishRelease and publishFloor need a passed probe for this client and env. */
async function probed<T extends ReturnType<typeof setup>>(s: T): Promise<T> {
  await probeR2Conditionals(s.r2.staging, "staging");
  await probeR2Conditionals(s.r2.prod, "prod");
  s.fake.log.length = 0;
  s.fake.r2Log.length = 0;
  return s;
}

const floorOf = (o: Partial<FloorRecord> = {}): FloorRecord => ({
  env: "staging",
  seq: 1,
  minVersion: "0.30.0",
  revoked: [],
  ...o,
});
const signFloor = (
  f: unknown,
  env = (f as { env: string }).env,
  key = KEYS[env as "staging"].privateKey,
) => signString(canonicalJson(f), env, key, "oa-release-floor-v1");
const seedFloor = (
  s: ReturnType<typeof setup>,
  f: unknown = signFloor(floorOf()),
  env: "staging" | "prod" = "staging",
) => s.fake.r2Seed(platformNames(env).releases, FLOOR_KEY, sigBytes(f));

/** Every R2 PUT, REST or S3. */
const r2Writes = (fake: FakeCf) =>
  fake.log.filter(
    (e) =>
      e.method === "PUT" &&
      (e.path.includes("/objects/") ||
        e.path.includes(".r2.cloudflarestorage.com/")),
  );

// ---------- A: the hardened reader ----------

// M3: the same fixtures against both readers (provision's and the signer's
// node:* copy), with the same outcome.
describe.each([
  ["provision readTreeHardened", readTreeHardened],
  ["scripts/ci copy", libReadTree],
] as const)("A: %s", (_impl, readTree) => {
  const tree = () => {
    const d = mkdtempSync(join(tmpdir(), "oa-hard-"));
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "a.txt"), "a");
    writeFileSync(join(d, "sub/b.txt"), "bb");
    return d;
  };

  it("reads regular files, sorted, with their bytes", async () => {
    const got = await readTree(tree());
    expect(got.map((f) => [f.path, new TextDecoder().decode(f.bytes)])).toEqual(
      [
        ["a.txt", "a"],
        ["sub/b.txt", "bb"],
      ],
    );
  });

  it("refuses a symlink to a file and to a directory", async () => {
    const d = tree();
    symlinkSync(join(d, "a.txt"), join(d, "link.txt"));
    expect((await fails(readTree(d))).message).toMatch(/symlink/);
    const d2 = tree();
    symlinkSync(join(d2, "sub"), join(d2, "subl"));
    expect((await fails(readTree(d2))).message).toMatch(/symlink/);
    const out = mkdtempSync(join(tmpdir(), "oa-out-"));
    writeFileSync(join(out, "secret"), "s");
    const d3 = tree();
    symlinkSync(out, join(d3, "escape"));
    expect((await fails(readTree(d3))).message).toMatch(/symlink/);
  });

  it("refuses a hardlink (nlink > 1)", async () => {
    const d = tree();
    const other = mkdtempSync(join(tmpdir(), "oa-hl-"));
    writeFileSync(join(other, "x"), "outside");
    linkSync(join(other, "x"), join(d, "x.txt"));
    expect((await fails(readTree(d))).message).toMatch(/hardlink/);
  });

  it("refuses a file swapped between the two walks", async () => {
    const d = tree();
    const e = await fails(
      readTree(d, {
        // A new inode with the same name, size and bytes.
        afterRead: async () => {
          writeFileSync(join(d, "a.tmp"), "a");
          renameSync(join(d, "a.tmp"), join(d, "a.txt"));
        },
      }),
    );
    expect(e.message).toMatch(/changed while it was read/);
  });

  it("refuses a file grown between the two walks", async () => {
    const d = tree();
    const e = await fails(
      readTree(d, {
        afterRead: async () => writeFileSync(join(d, "a.txt"), "aaaa"),
      }),
    );
    expect(e.message).toMatch(/changed while it was read/);
  });

  it("refuses a directory swapped between the two walks", async () => {
    const d = tree();
    const e = await fails(
      readTree(d, {
        // A new directory inode with the same name and contents.
        afterRead: async () => {
          mkdirSync(join(d, "new"));
          writeFileSync(join(d, "new/b.txt"), "bb");
          renameSync(join(d, "sub"), join(d, "old"));
          renameSync(join(d, "new"), join(d, "sub"));
          rmSync(join(d, "old"), { recursive: true });
        },
      }),
    );
    expect(e.message).toMatch(/changed while it was read/);
  });

  it("refuses a file added between the two walks", async () => {
    const d = tree();
    const e = await fails(
      readTree(d, {
        afterRead: async () => writeFileSync(join(d, "new.txt"), "n"),
      }),
    );
    expect(e.message).toMatch(/changed while it was read/);
  });

  it("refuses dotfiles and dot-directories through the path check", async () => {
    const d = tree();
    writeFileSync(join(d, ".env"), "x");
    expect((await fails(readTree(d))).message).toMatch(/asset path/);
  });
});

// ---------- A: two-variant buildBundle ----------

describe("A: buildBundle builds both variants from one dry-run config", () => {
  async function fixtureRoot() {
    const root = await mkdtemp0();
    await mkdir(join(root, "apps/server"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"version":"0.34.0"}');
    await writeFile(
      join(root, "apps/server/wrangler.template.jsonc"),
      TEMPLATE,
    );
    return root;
  }
  const mkdtemp0 = async () => mkdtempSync(join(tmpdir(), "oa-root-"));
  // A fake wrangler: substitutes the define like esbuild would.
  const configs: Record<string, unknown>[] = [];
  const exec = async (_c: string, args: string[]) => {
    const out = args[args.indexOf("--outdir") + 1] as string;
    const cfg = JSON.parse(
      await readFile(args[args.indexOf("-c") + 1] as string, "utf8"),
    );
    configs.push(cfg);
    const v = cfg.define[TEST_HOOKS_DEFINE];
    await mkdir(join(out, "chunks"), { recursive: true });
    await writeFile(
      join(out, "index.js"),
      `const t = true; const hooks = ${v} === true && t;\nexport default {};\n`,
    );
    await writeFile(join(out, "chunks/a.mjs"), "export const x = false;\n");
  };

  it("renders configs that differ only in the define value (normalized: byte-identical)", async () => {
    configs.length = 0;
    const root = await fixtureRoot();
    const rel = await buildBundle(root, { variant: "release", exec });
    const red = await buildBundle(root, { variant: "redline", exec });
    expect(configs).toHaveLength(2);
    const [a, b] = configs as [
      Record<string, Record<string, unknown>>,
      Record<string, Record<string, unknown>>,
    ];
    expect(a.define?.[TEST_HOOKS_DEFINE]).toBe("false");
    expect(b.define?.[TEST_HOOKS_DEFINE]).toBe("true");
    const strip = (c: Record<string, unknown>) =>
      JSON.stringify({ ...c, define: undefined });
    expect(strip(a)).toBe(strip(b));
    expect(rel.variant).toBe("release");
    expect(red.variant).toBe("redline");
    expect(rel.modules.map((m) => [m.name, m.type])).toEqual(
      red.modules.map((m) => [m.name, m.type]),
    );
    // The exact configs wrangler built from: identical but the define value.
    expect(rel.config).toBe(JSON.stringify(a));
    expect(red.config).toBe(JSON.stringify(b));
    expect(() =>
      assertSameConfigButDefine(rel.config, red.config),
    ).not.toThrow();
  });

  it("defaults to release and leaves wrangler.staging.jsonc untouched", async () => {
    configs.length = 0;
    const root = await fixtureRoot();
    const b = await buildBundle(root, { exec });
    expect(b.variant).toBe("release");
    expect(
      (configs[0] as { define: Record<string, string> }).define[
        TEST_HOOKS_DEFINE
      ],
    ).toBe("false");
    const staging = readFileSync(
      new URL("apps/server/wrangler.staging.jsonc", ROOT),
      "utf8",
    );
    expect(staging).not.toContain(TEST_HOOKS_DEFINE);
  });

  it("refuses a symlink in the wrangler outdir", async () => {
    const root = await fixtureRoot();
    const e = await fails(
      buildBundle(root, {
        exec: async (_c, args) => {
          const out = args[args.indexOf("--outdir") + 1] as string;
          await writeFile(join(out, "index.js"), "export default {}");
          await symlink("/etc/hosts", join(out, "x.js"));
        },
      }),
    );
    expect(e.message).toMatch(/symlink/);
  });

  it("assertSameConfigButDefine refuses a config that differs in another key", async () => {
    configs.length = 0;
    const root = await fixtureRoot();
    const rel = (await buildBundle(root, { variant: "release", exec })).config;
    const red = (await buildBundle(root, { variant: "redline", exec })).config;
    const other = JSON.stringify({
      ...JSON.parse(red),
      compatibility_date: "2020-01-01",
    });
    const extraDefine = JSON.stringify({
      ...JSON.parse(red),
      define: { ...JSON.parse(red).define, OTHER: "1" },
    });
    for (const [n, a, b] of [
      ["another key", rel, other],
      ["another define", rel, extraDefine],
      ["the same variant twice", rel, rel],
      ["swapped variants", red, rel],
      [
        "key order",
        rel,
        JSON.stringify(
          Object.fromEntries(Object.entries(JSON.parse(red)).reverse()),
        ),
      ],
    ] as const)
      expect(() => assertSameConfigButDefine(a, b), n).toThrow(/define|differ/);
  });

  // Real-build finding (T3b ruling, option 2): with the define false, esbuild
  // tree-shakes the hook modules out of release, so the bundles are NOT
  // byte-identical; check-no-test-hooks is the behavioural proof. Needs the
  // server's generated files (`pnpm --filter @oa/server run gen`) and an
  // apps/server/dist-assets directory, else skipped. CI's test job has the
  // first without the second.
  const GENERATED =
    existsSync(new URL("apps/server/src/version.gen.ts", ROOT)) &&
    existsSync(new URL("apps/server/dist-assets", ROOT));
  // N5: the no-test-hooks CI job sets OA_REQUIRE_REAL_BUILD=1, so it never skips there.
  it.skipIf(!GENERATED && process.env.OA_REQUIRE_REAL_BUILD !== "1")(
    "real build: the bundles differ and release holds no hook route string",
    async () => {
      const root = new URL(".", ROOT).pathname;
      const rel = await buildBundle(root, { variant: "release" });
      const red = await buildBundle(root, { variant: "redline" });
      expect(() =>
        assertSameConfigButDefine(rel.config, red.config),
      ).not.toThrow();
      const main = (b: typeof rel) =>
        Buffer.from(
          b.modules.find((m) => m.name === b.mainModule)?.bytes ?? [],
        );
      expect(main(rel).equals(main(red))).toBe(false);
      for (const r of [
        "/__test/session",
        "/__test/otp/latest",
        "/__test/oauth-client",
        "/__test/code-caps/reset",
        "/__test/directory-groups",
      ]) {
        expect(main(rel).includes(r), r).toBe(false);
        expect(main(red).includes(r), r).toBe(true);
      }
      // Only the route-policy table's doc key keeps the bare prefix; nothing
      // else in release may contain /__test/ (assertNoHookRoutes).
      expect(
        main(rel)
          .toString()
          .match(/\/__test\//g),
      ).toHaveLength(1);
      expect(main(rel).includes('"ALL /__test/*"')).toBe(true);
      expect(() => assertNoHookRoutes(rel.modules)).not.toThrow();
      expect(() => assertNoHookRoutes(red.modules)).toThrow(/__test/);
    },
    300_000,
  );
});

// ---------- C: the stored signature format ----------

describe("C: openReleaseRecord", () => {
  const env = "staging";
  const pub = () => G.RELEASE_PUBKEY.staging as string;
  const open = (s: unknown) => openReleaseRecord(s, pub(), env);

  it("returns the parsed record for a canonical signed string", () => {
    const rec = recordOf();
    const got = open(signRec(rec));
    expect(canonicalJson(got)).toBe(canonicalJson(rec));
    expect(Object.getPrototypeOf(got)).toBe(null);
    expect(verifyReleaseSignature(signRec(rec), pub(), env)).not.toBeNull();
  });

  it("refuses a duplicate key at any depth (even if signed)", () => {
    const s = canonicalJson(recordOf());
    const dupTop = s.replace('{"assets"', '{"env":"prod","assets"');
    const dupDeep = s.replace(
      `{"${TEST_HOOKS_DEFINE}":false}`,
      `{"${TEST_HOOKS_DEFINE}":false,"${TEST_HOOKS_DEFINE}":true}`,
    );
    for (const t of [dupTop, dupDeep]) {
      expect(t).not.toBe(s);
      expect(() => open(signString(t, env, KEYS.staging.privateKey))).toThrow(
        /duplicate key/,
      );
    }
  });

  it("treats __proto__ as a plain key and refuses it as unknown", () => {
    const s = canonicalJson(recordOf()).replace(
      '{"assets"',
      '{"__proto__":{"variant":"redline"},"assets"',
    );
    const e = (() => {
      try {
        open(signString(s, env, KEYS.staging.privateKey));
      } catch (x) {
        return x as Error;
      }
      return null;
    })();
    expect(e?.message).toMatch(/unexpected key|__proto__/);
    const parsed = parseStrictJson('{"__proto__":{"a":1}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it("refuses a non-canonical record string (signed)", () => {
    const rec = recordOf();
    for (const t of [
      JSON.stringify(rec),
      JSON.stringify(rec, null, 1),
      ` ${canonicalJson(rec)}`,
    ])
      expect(() => open(signString(t, env, KEYS.staging.privateKey))).toThrow(
        /canonical/,
      );
  });

  it("refuses a re-serialized record (signature over the exact string)", () => {
    const signed = signRec(recordOf());
    // The same record, keys in another order: equal as JSON, other bytes.
    const re = {
      ...signed,
      record: JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(signed.record)).reverse()),
      ),
    };
    expect(re.record).not.toBe(signed.record);
    expect(() => open(re)).toThrow(/signature/);
    // An object record (the #435 envelope) is refused too.
    expect(() =>
      open({ record: JSON.parse(signed.record), signature: signed.signature }),
    ).toThrow(/signature/);
  });

  it("refuses a signature over other bytes", () => {
    const rec = canonicalJson(recordOf());
    const other = canonicalJson(recordOf({ version: "0.34.1" }));
    const s = signString(other, env, KEYS.staging.privateKey);
    expect(() => open({ record: rec, signature: s.signature })).toThrow(
      /signature/,
    );
    // The bare record string, no domain prefix.
    const bare = sign(null, Buffer.from(rec), KEYS.staging.privateKey).toString(
      "base64url",
    );
    expect(() => open({ record: rec, signature: bare })).toThrow(/signature/);
    // Another env's prefix and key.
    expect(() => open(signString(rec, "prod", KEYS.prod.privateKey))).toThrow(
      /signature/,
    );
    // The floor domain.
    expect(() =>
      open(
        signString(rec, env, KEYS.staging.privateKey, "oa-release-floor-v1"),
      ),
    ).toThrow(/signature/);
    // Extra envelope keys.
    expect(() => open({ ...signRec(recordOf()), extra: 1 })).toThrow(
      /signature|envelope/,
    );
  });

  it("refuses a string defines value (signed)", () => {
    for (const v of ['"false"', '"true"', "0", "null"]) {
      const s = canonicalJson(recordOf()).replace(
        `{"${TEST_HOOKS_DEFINE}":false}`,
        `{"${TEST_HOOKS_DEFINE}":${v}}`,
      );
      expect(() => open(signString(s, env, KEYS.staging.privateKey))).toThrow(
        /boolean/,
      );
    }
  });

  it("parseStrictJson parses JSON exactly and refuses trailing data", () => {
    const v = '{"a":[1,-2.5e3,"x\\u0041\\n",true,false,null,{}],"b":{}}';
    expect(JSON.stringify(parseStrictJson(v))).toBe(
      JSON.stringify(JSON.parse(v)),
    );
    for (const bad of ["{}x", "[1,]", '{"a":1,}', "01", "'a'", '{"a" 1}', ""])
      expect(() => parseStrictJson(bad), bad).toThrow();
  });
});

// ---------- C: the record builder refuses ----------

describe("C: buildReleaseRecord refuses", () => {
  const base = {
    env: "staging" as const,
    version: "0.34.0",
    variant: "release" as const,
    mainModule: "index.js",
    modules: modulesOf("release"),
    assets: ASSETS,
    template: TEMPLATE,
    migrations: MIGRATIONS,
    welcome: WELCOME,
  };

  it("writes defines as a JSON boolean", () => {
    expect(buildReleaseRecord(base).defines).toEqual({
      [TEST_HOOKS_DEFINE]: false,
    });
    expect(
      buildReleaseRecord({
        ...base,
        variant: "redline",
        modules: modulesOf("redline"),
      }).defines,
    ).toEqual({ [TEST_HOOKS_DEFINE]: true });
  });

  it("an env/variant mismatch (redline for prod)", () => {
    expect(() =>
      buildReleaseRecord({ ...base, env: "prod", variant: "redline" }),
    ).toThrow(/redline/);
    expect(() => buildReleaseRecord({ ...base, env: "dev" as never })).toThrow(
      /env/,
    );
  });

  it("a non-semver version", () => {
    for (const v of ["v0.34.0", "0.34", "latest", "0.34.0/../x"])
      expect(() => buildReleaseRecord({ ...base, version: v })).toThrow(
        /version/,
      );
  });

  it("an asset path assertAssetPath refuses, or that does not fit plain ustar", () => {
    for (const p of [".env", "a/../b", "/abs", "a//b", "a\\b"])
      expect(() =>
        buildReleaseRecord({ ...base, assets: [{ path: p, bytes: enc("") }] }),
      ).toThrow(/asset path/);
    const long = `${"d".repeat(60)}/${"f".repeat(101)}`;
    expect(() =>
      buildReleaseRecord({ ...base, assets: [{ path: long, bytes: enc("") }] }),
    ).toThrow(/ustar/);
    const deep = `${Array.from({ length: 60 }, () => "dddd").join("/")}/f`;
    expect(() =>
      buildReleaseRecord({ ...base, assets: [{ path: deep, bytes: enc("") }] }),
    ).toThrow(/ustar/);
  });

  it("anything over ASSET_LIMITS", () => {
    const big = new Uint8Array(ASSET_LIMITS.fileBytes + 1);
    expect(() =>
      buildReleaseRecord({
        ...base,
        assets: [{ path: "big.bin", bytes: big }],
      }),
    ).toThrow(/25 MiB|limit/);
    const many = Array.from({ length: ASSET_LIMITS.files + 1 }, (_, i) => ({
      path: `f${i}`,
      bytes: new Uint8Array(),
    }));
    expect(() => buildReleaseRecord({ ...base, assets: many })).toThrow(
      /assets|limit/,
    );
  });
});

describe("C: ustar", () => {
  it("ustarFits follows the 100-byte name and 155-byte prefix rule", () => {
    expect(ustarFits("a".repeat(100))).toBe(true);
    expect(ustarFits("a".repeat(101))).toBe(false);
    expect(ustarFits(`${"p".repeat(155)}/${"n".repeat(100)}`)).toBe(true);
    expect(ustarFits(`${"p".repeat(156)}/${"n".repeat(100)}`)).toBe(false);
  });

  it("parses what the packer writes, and the packer writes no pax header", () => {
    const entries = tarEntries();
    const tar = packUstar(entries);
    const text = Buffer.from(tar).toString("latin1");
    expect(text).not.toContain("PaxHeader");
    for (let o = 0; o < tar.length; o += 512)
      expect(["x", "g", "L", "K"]).not.toContain(
        String.fromCharCode(tar[o + 156] as number),
      );
    const got = parseUstar(tar);
    expect(got.map((f) => f.path).sort()).toEqual(
      entries.map((e) => e.path).sort(),
    );
    for (const e of entries)
      expect(got.find((f) => f.path === e.path)?.bytes).toEqual(e.bytes);
  });

  it.each<[string, Uint8Array, RegExp]>([
    [
      "a symlink",
      rawTar([{ name: "a", o: { type: "2", linkname: "/etc/passwd" } }]),
      /type/,
    ],
    [
      "a hardlink",
      rawTar([{ name: "a", o: { type: "1", linkname: "b" } }]),
      /type/,
    ],
    ["a fifo", rawTar([{ name: "a", o: { type: "6" } }]), /type/],
    [
      "a pax header",
      rawTar([
        {
          name: "PaxHeader/a",
          data: enc("30 path=../../etc/x\n"),
          o: { type: "x" },
        },
        { name: "a", data: enc("x") },
      ]),
      /pax|GNU|type/,
    ],
    [
      "a global pax header",
      rawTar([{ name: "g", data: enc("x"), o: { type: "g" } }]),
      /pax|GNU|type/,
    ],
    [
      "a GNU long name",
      rawTar([
        { name: "././@LongLink", data: enc("../../x\0"), o: { type: "L" } },
        { name: "a", data: enc("x") },
      ]),
      /pax|GNU|type/,
    ],
    [
      "a GNU magic",
      rawTar([
        { name: "a", data: enc("x"), o: { magic: "ustar ", version: " \0" } },
      ]),
      /ustar/,
    ],
    ["an absolute path", rawTar([{ name: "/etc/x", data: enc("x") }]), /path/],
    [
      "a .. segment",
      rawTar([{ name: "assets/../../x", data: enc("x") }]),
      /path/,
    ],
    ["a dot segment", rawTar([{ name: "assets/./x", data: enc("x") }]), /path/],
    [
      "an empty segment",
      rawTar([{ name: "assets//x", data: enc("x") }]),
      /path/,
    ],
    [
      "a duplicate name",
      rawTar([
        { name: "a", data: enc("x") },
        { name: "a", data: enc("y") },
      ]),
      /twice|duplicate/,
    ],
    [
      "a duplicate via prefix",
      rawTar([
        { name: "a/b", data: enc("x") },
        { name: "b", data: enc("y"), o: { prefix: "a" } },
      ]),
      /twice|duplicate/,
    ],
    [
      "trailing garbage",
      rawTar([{ name: "a", data: enc("x") }], concat(END, enc("junk"))),
      /trailing|garbage|512/,
    ],
    [
      "data after the end blocks",
      rawTar([{ name: "a", data: enc("x") }], concat(END, block(enc("junk")))),
      /trailing|garbage/,
    ],
    [
      "no end blocks",
      concat(header("a", { size: 1 }), block(enc("x"))),
      /end|truncated/,
    ],
    [
      "a truncated entry",
      concat(header("a", { size: 2000 }), block(enc("x"))),
      /truncated/,
    ],
    [
      "a bad checksum",
      rawTar([{ name: "a", data: enc("x"), o: { badSum: true } }]),
      /checksum/,
    ],
    [
      "a file over 25 MiB",
      concat(header("a", { size: ASSET_LIMITS.fileBytes + 1 }), END),
      /limit|25 MiB/,
    ],
  ])("parseUstar refuses %s", (_n, tar, re) => {
    expect(() => parseUstar(tar)).toThrow(re);
  });
});

// ---------- D: publishRelease ----------

describe("D: publishRelease", () => {
  const good = (
    variant: "release" | "redline" = "release",
    env: "staging" | "prod" = "staging",
  ) => ({
    tar: packUstar(tarEntries(variant)),
    sig: sigBytes(signRec(recordOf({ variant, env }))),
  });

  it("uploads exactly the verified bytes under releases/<version>/<variant>/, each If-None-Match: *, the record last", async () => {
    const s = await probed(setup());
    seedFloor(s);
    const files = good();
    await publishRelease({
      cf: s.cf,
      r2: s.r2.staging,
      env: "staging",
      version: "0.34.0",
      files,
    });
    const puts = s.fake.r2Log.filter((e) => e.method === "PUT");
    expect(puts.length).toBe(tarEntries().length + 1);
    for (const p of puts) {
      expect(p.bucket).toBe("oa-s-releases");
      expect(p.ifNoneMatch).toBe("*");
      expect(p.key.startsWith("releases/0.34.0/release/")).toBe(true);
    }
    expect(puts.at(-1)?.key).toBe(
      releaseKey("0.34.0", "release", "record.sig.json"),
    );
    for (const e of tarEntries())
      expect(
        s.fake.r2Object(s.bucket, `releases/0.34.0/release/${e.path}`)?.bytes,
      ).toEqual(e.bytes);
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/record.sig.json")
        ?.bytes,
    ).toEqual(files.sig);
  });

  it("a second publish of the same version is refused with zero writes", async () => {
    const s = await probed(setup());
    seedFloor(s);
    await publishRelease({
      cf: s.cf,
      r2: s.r2.staging,
      env: "staging",
      version: "0.34.0",
      files: good(),
    });
    const before = r2Writes(s.fake).length;
    const e = await fails(
      publishRelease({
        cf: s.cf,
        r2: s.r2.staging,
        env: "staging",
        version: "0.34.0",
        files: good(),
      }),
    );
    expect(e).toBeInstanceOf(PublishRefused);
    expect(e.message).toMatch(/already/);
    expect(r2Writes(s.fake).length).toBe(before);
  });

  it("an object written concurrently is never overwritten (If-None-Match)", async () => {
    const s = await probed(setup());
    seedFloor(s);
    // The listing misses it (written after the list): the PUT's 412 decides.
    const cf = {
      ...s.cf,
      r2ObjectList: async () => ({ objects: [], truncated: false }),
    };
    s.fake.r2Seed(
      s.bucket,
      "releases/0.34.0/release/welcome/welcome.md",
      enc("evil"),
    );
    const e = await fails(
      publishRelease({
        cf,
        r2: s.r2.staging,
        env: "staging",
        version: "0.34.0",
        files: good(),
      }),
    );
    expect(e).toBeInstanceOf(PublishRefused);
    expect(e.message).toMatch(/already exists.*differs from the tar/);
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/welcome/welcome.md")
        ?.bytes,
    ).toEqual(enc("evil"));
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/record.sig.json"),
    ).toBeUndefined();
  });

  it("staging takes redline; prod refuses it", async () => {
    const s = await probed(setup());
    seedFloor(s);
    await publishRelease({
      cf: s.cf,
      r2: s.r2.staging,
      env: "staging",
      version: "0.34.0",
      files: good("redline"),
    });
    seedFloor(s, signFloor(floorOf({ env: "prod" })), "prod");
    const rec = {
      ...recordOf(),
      env: "prod",
      variant: "redline",
      defines: { [TEST_HOOKS_DEFINE]: true },
      sha256: bundleSha256({
        mainModule: "index.js",
        modules: modulesOf("redline"),
      }),
    };
    const e = await fails(
      publishRelease({
        cf: s.cf,
        r2: s.r2.prod,
        env: "prod",
        version: "0.34.0",
        files: {
          tar: packUstar(tarEntries("redline")),
          sig: sigBytes(signRec(rec)),
        },
      }),
    );
    expect(e.message).toMatch(/redline/);
  });

  const refusals: [
    string,
    () => {
      version?: string;
      env?: "staging" | "prod";
      files: { tar: Uint8Array; sig: Uint8Array };
    },
    RegExp,
  ][] = [
    [
      "a signature by another key",
      () => ({
        files: {
          ...good(),
          sig: sigBytes(signRec(recordOf(), "staging", OTHER.privateKey)),
        },
      }),
      /signature/,
    ],
    [
      "the prod key for a staging record",
      () => ({
        files: {
          ...good(),
          sig: sigBytes(signRec(recordOf(), "staging", KEYS.prod.privateKey)),
        },
      }),
      /signature/,
    ],
    [
      "a staging record published to prod",
      () => ({ env: "prod", files: good() }),
      /signature/,
    ],
    [
      "a record for another version",
      () => ({ version: "0.34.1", files: good() }),
      /version/,
    ],
    [
      "a .sig.json with a duplicate key",
      () => ({
        files: {
          ...good(),
          sig: enc(
            JSON.stringify(signRec(recordOf())).replace(
              '{"record"',
              '{"signature":"x","record"',
            ),
          ),
        },
      }),
      /duplicate/,
    ],
    [
      "an extra file",
      () => ({
        files: {
          ...good(),
          tar: packUstar([
            ...tarEntries(),
            { path: "assets/extra.js", bytes: enc("x") },
          ]),
        },
      }),
      /extra|missing|match/,
    ],
    [
      "an extra top-level file",
      () => ({
        files: {
          ...good(),
          tar: packUstar([
            ...tarEntries(),
            { path: "evil.sh", bytes: enc("x") },
          ]),
        },
      }),
      /unexpected|extra/,
    ],
    [
      "a missing asset",
      () => ({
        files: {
          ...good(),
          tar: packUstar(
            tarEntries().filter((e) => e.path !== "assets/index.html"),
          ),
        },
      }),
      /extra|missing|match/,
    ],
    [
      "a missing welcome",
      () => ({
        files: {
          ...good(),
          tar: packUstar(
            tarEntries().filter((e) => e.path !== "welcome/welcome.md"),
          ),
        },
      }),
      /welcome/,
    ],
    [
      "a missing migration",
      () => ({
        files: {
          ...good(),
          tar: packUstar(
            tarEntries().filter((e) => e.path !== "migrations/0001_more.sql"),
          ),
        },
      }),
      /migrations/,
    ],
    [
      "an extra module",
      () => ({
        files: {
          ...good(),
          tar: packUstar([
            ...tarEntries(),
            { path: "modules/x.js", bytes: enc("x") },
          ]),
        },
      }),
      /modules/,
    ],
    [
      "changed asset bytes (same size)",
      () => ({
        files: {
          ...good(),
          tar: packUstar(
            tarEntries().map((e) =>
              e.path === "assets/index.html"
                ? { ...e, bytes: enc("<!doctype html><p>HI</p>") }
                : e,
            ),
          ),
        },
      }),
      /assets/,
    ],
    [
      "changed module bytes",
      () => ({
        files: {
          ...good(),
          tar: packUstar(tarEntries("redline").map((e) => e)),
        },
      }),
      /modules/,
    ],
    [
      "a changed template",
      () => ({
        files: {
          ...good(),
          tar: packUstar(
            tarEntries().map((e) =>
              e.path.startsWith("template/") ? { ...e, bytes: enc("{}") } : e,
            ),
          ),
        },
      }),
      /template/,
    ],
    [
      "a symlink in the tar",
      () => ({
        files: {
          ...good(),
          tar: rawTar([
            { name: "assets/x", o: { type: "2", linkname: "/etc/passwd" } },
          ]),
        },
      }),
      /type/,
    ],
    [
      "a pax header in the tar",
      () => ({
        files: {
          ...good(),
          tar: rawTar([{ name: "x", data: enc("1 x\n"), o: { type: "x" } }]),
        },
      }),
      /pax|GNU|type/,
    ],
    [
      "trailing garbage after the tar",
      () => ({
        files: { ...good(), tar: concat(packUstar(tarEntries()), enc("x")) },
      }),
      /trailing|garbage|512/,
    ],
  ];
  it.each(refusals)("refuses %s with zero writes", async (_n, mk, re) => {
    const s = await probed(setup());
    seedFloor(s);
    seedFloor(s, signFloor(floorOf({ env: "prod" })), "prod");
    const o = mk();
    const e = await fails(
      publishRelease({
        cf: s.cf,
        r2: s.r2[o.env ?? "staging"],
        env: o.env ?? "staging",
        version: o.version ?? "0.34.0",
        files: o.files,
      }),
    );
    expect(e.message).toMatch(re);
    expect(r2Writes(s.fake)).toEqual([]);
  });

  it("refuses a record over ASSET_LIMITS before reading the tar", async () => {
    const s = await probed(setup());
    seedFloor(s);
    const rec = {
      ...recordOf(),
      assets: [
        {
          path: "big.bin",
          size: ASSET_LIMITS.fileBytes + 1,
          sha256: "0".repeat(64),
        },
      ],
    };
    const e = await fails(
      publishRelease({
        cf: s.cf,
        r2: s.r2.staging,
        env: "staging",
        version: "0.34.0",
        files: { tar: new Uint8Array(1024), sig: sigBytes(signRec(rec)) },
      }),
    );
    expect(e.message).toMatch(/25 MiB|limit/);
    expect(r2Writes(s.fake)).toEqual([]);
  });

  it("refuses while RELEASE_PUBKEY is the placeholder", async () => {
    const s = await probed(setup());
    seedFloor(s);
    const before = G.RELEASE_PUBKEY;
    const { RELEASE_PUBKEY_PLACEHOLDER } = await vi.importActual<
      typeof import("../src/internal/gates.js")
    >("../src/internal/gates.js");
    G.RELEASE_PUBKEY = { ...before, staging: RELEASE_PUBKEY_PLACEHOLDER };
    try {
      const e = await fails(
        publishRelease({
          cf: s.cf,
          r2: s.r2.staging,
          env: "staging",
          version: "0.34.0",
          files: good(),
        }),
      );
      expect(e.message).toMatch(/placeholder/);
    } finally {
      G.RELEASE_PUBKEY = before;
    }
  });

  it.each<[string, (s: ReturnType<typeof setup>) => void, RegExp]>([
    ["a missing floor", () => {}, /floor/],
    [
      "an unsigned floor",
      (s) => seedFloor(s, { record: canonicalJson(floorOf()) }),
      /floor/,
    ],
    [
      "a wrong-key floor",
      (s) => seedFloor(s, signFloor(floorOf(), "staging", OTHER.privateKey)),
      /floor/,
    ],
    [
      "another env's floor",
      (s) => seedFloor(s, signFloor(floorOf({ env: "prod" }))),
      /floor/,
    ],
    [
      "a version below minVersion",
      (s) => seedFloor(s, signFloor(floorOf({ minVersion: "0.35.0" }))),
      /below/,
    ],
    [
      "a revoked version",
      (s) => seedFloor(s, signFloor(floorOf({ revoked: ["0.34.0"] }))),
      /revoked/,
    ],
  ])("checks the floor: refuses %s", async (_n, seed, re) => {
    const s = await probed(setup());
    seed(s);
    const e = await fails(
      publishRelease({
        cf: s.cf,
        r2: s.r2.staging,
        env: "staging",
        version: "0.34.0",
        files: good(),
      }),
    );
    expect(e.message).toMatch(re);
    expect(r2Writes(s.fake)).toEqual([]);
  });

  it("refuses a floor below FLOOR_MIN_SEQ (valid signature)", async () => {
    const s = await probed(setup());
    seedFloor(s, signFloor(floorOf({ seq: 2 })));
    G.FLOOR_MIN_SEQ = { staging: 3, prod: 1 };
    try {
      const e = await fails(
        publishRelease({
          cf: s.cf,
          r2: s.r2.staging,
          env: "staging",
          version: "0.34.0",
          files: good(),
        }),
      );
      expect(e.message).toMatch(/seq/);
    } finally {
      G.FLOOR_MIN_SEQ = { staging: 1, prod: 1 };
    }
  });
});

// ---------- E: the signed floor ----------

describe("E: the signed floor", () => {
  const pub = () => G.RELEASE_PUBKEY.staging as string;

  it("openFloor verifies under the floor prefix, for the env, with the exact shape", () => {
    expect(openFloor(signFloor(floorOf()), pub(), "staging")).toMatchObject({
      seq: 1,
    });
    // A release-record signature is not a floor signature.
    expect(() =>
      openFloor(
        signString(
          canonicalJson(floorOf()),
          "staging",
          KEYS.staging.privateKey,
        ),
        pub(),
        "staging",
      ),
    ).toThrow(/signature/);
    expect(() =>
      openFloor(signFloor(floorOf({ env: "prod" })), pub(), "staging"),
    ).toThrow(/signature|env/);
    for (const bad of [
      { ...floorOf(), seq: 0 },
      { ...floorOf(), seq: 1.5 },
      { ...floorOf(), seq: "2" },
      { ...floorOf(), minVersion: "latest" },
      { ...floorOf(), revoked: ["x"] },
      { ...floorOf(), revoked: "0.1.0" },
      { ...floorOf(), extra: true },
    ])
      expect(
        () => openFloor(signFloor(bad), pub(), "staging"),
        JSON.stringify(bad),
      ).toThrow();
  });

  it("floorRefusal: seq, minVersion and revoked", () => {
    const f = floorOf({ seq: 5, minVersion: "0.30.0", revoked: ["0.31.0"] });
    expect(floorRefusal(f, "0.34.0", 5)).toBeNull();
    expect(floorRefusal(f, "0.34.0", 6)).toMatch(/seq/);
    expect(floorRefusal(f, "0.29.9", 1)).toMatch(/below/);
    expect(floorRefusal(f, "0.30.0-rc.1", 1)).toMatch(/below/);
    expect(floorRefusal(f, "0.31.0", 1)).toMatch(/revoked/);
  });

  it("publishFloor writes the first floor with If-None-Match: *", async () => {
    const s = await probed(setup());
    await publishFloor({
      r2: s.r2.staging,
      env: "staging",
      floor: sigBytes(signFloor(floorOf())),
    });
    const puts = s.fake.r2Log.filter((e) => e.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ key: FLOOR_KEY, ifNoneMatch: "*" });
  });

  it("publishFloor replaces with If-Match: <etag> and needs a higher seq, a same-or-higher minVersion and a revoked superset", async () => {
    const s = await probed(setup());
    const first = floorOf({
      seq: 2,
      minVersion: "0.30.0",
      revoked: ["0.31.0"],
    });
    seedFloor(s, signFloor(first));
    const etag = s.fake.r2Object(s.bucket, FLOOR_KEY)?.etag;
    for (const [n, f, re] of [
      ["the same seq", { ...first }, /seq/],
      ["a lower seq (valid signature)", { ...first, seq: 1 }, /seq/],
      [
        "a lower minVersion",
        { ...first, seq: 3, minVersion: "0.29.0" },
        /minVersion/,
      ],
      ["a dropped revocation", { ...first, seq: 3, revoked: [] }, /revoked/],
      ["another env", { ...first, seq: 3, env: "prod" }, /signature|env/],
    ] as const) {
      const e = await fails(
        publishFloor({
          r2: s.r2.staging,
          env: "staging",
          floor: sigBytes(signFloor(f, "staging")),
        }),
      );
      expect(e.message, n).toMatch(re);
    }
    const e = await fails(
      publishFloor({
        r2: s.r2.staging,
        env: "staging",
        floor: sigBytes(
          signFloor({ ...first, seq: 3 }, "staging", OTHER.privateKey),
        ),
      }),
    );
    expect(e.message).toMatch(/signature/);
    expect(s.fake.r2Log.filter((x) => x.method === "PUT")).toEqual([]);
    const next = {
      ...first,
      seq: 3,
      minVersion: "0.32.0",
      revoked: ["0.31.0", "0.33.0"],
    };
    await publishFloor({
      r2: s.r2.staging,
      env: "staging",
      floor: sigBytes(signFloor(next)),
    });
    const puts = s.fake.r2Log.filter((x) => x.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ key: FLOOR_KEY, ifMatch: `"${etag}"` });
    expect(puts[0]?.ifNoneMatch).toBeUndefined();
  });

  it("publishFloor refuses a seq below FLOOR_MIN_SEQ", async () => {
    const s = await probed(setup());
    G.FLOOR_MIN_SEQ = { staging: 4, prod: 1 };
    try {
      const e = await fails(
        publishFloor({
          r2: s.r2.staging,
          env: "staging",
          floor: sigBytes(signFloor(floorOf({ seq: 3 }))),
        }),
      );
      expect(e.message).toMatch(/FLOOR_MIN_SEQ|seq/);
    } finally {
      G.FLOOR_MIN_SEQ = { staging: 1, prod: 1 };
    }
  });

  it("a concurrent floor change fails the If-Match: refused as floor seq exists, never retried as success", async () => {
    const s = await probed(setup());
    seedFloor(s, signFloor(floorOf({ seq: 1 })));
    const r2 = {
      ...s.r2.staging,
      get: async (k: string, o?: { maxBytes?: number }) => {
        const r = await s.r2.staging.get(k, o);
        s.fake.r2Seed(
          s.bucket,
          FLOOR_KEY,
          sigBytes(signFloor(floorOf({ seq: 2 }))),
        );
        return r;
      },
    };
    await probeR2Conditionals(r2, "staging");
    s.fake.r2Log.length = 0;
    const e = await fails(
      publishFloor({
        r2,
        env: "staging",
        floor: sigBytes(signFloor(floorOf({ seq: 3 }))),
      }),
    );
    expect(e).toBeInstanceOf(PublishRefused);
    expect(e.message).toMatch(/floor seq exists/);
    expect(s.fake.r2Log.filter((x) => x.method === "PUT")).toEqual([
      expect.objectContaining({ api: "s3", key: FLOOR_KEY, status: 412 }),
    ]);
  });

  it("a floor created concurrently fails the If-None-Match: refused as floor seq exists", async () => {
    const s = await probed(setup());
    const r2 = {
      ...s.r2.staging,
      get: async (k: string, o?: { maxBytes?: number }) => {
        const r = await s.r2.staging.get(k, o);
        s.fake.r2Seed(s.bucket, FLOOR_KEY, sigBytes(signFloor(floorOf())));
        return r;
      },
    };
    await probeR2Conditionals(r2, "staging");
    const e = await fails(
      publishFloor({
        r2,
        env: "staging",
        floor: sigBytes(signFloor(floorOf({ seq: 2 }))),
      }),
    );
    expect(e.message).toMatch(/floor seq exists/);
  });
});

// ---------- F: the R2 ReleaseReader ----------

describe("F: r2ReleaseReader", () => {
  async function published(perPage?: number) {
    const s = await probed(setup());
    seedFloor(s);
    await publishRelease({
      cf: s.cf,
      r2: s.r2.staging,
      env: "staging",
      version: "0.34.0",
      files: {
        tar: packUstar(tarEntries()),
        sig: sigBytes(signRec(recordOf())),
      },
    });
    if (perPage) s.fake.r2PerPage = perPage;
    s.fake.log.length = 0;
    s.fake.r2Log.length = 0;
    return s;
  }
  const gets = (s: ReturnType<typeof setup>, part: string) =>
    s.fake.r2Log.filter((e) => e.method === "GET" && e.key.includes(part));

  it("reads the record, modules, assets, template, migrations, welcome and floor from R2", async () => {
    const s = await published();
    const r = r2ReleaseReader(s.cf, "staging");
    const signed = (await r.record("0.34.0", "release")) as { record: string };
    expect(signed.record).toBe(canonicalJson(recordOf()));
    const m = await r.modules("0.34.0", "release");
    expect(m.mainModule).toBe("index.js");
    expect(bundleSha256(m)).toBe(recordOf().sha256);
    expect(
      (await r.assets("0.34.0", "release")).map((a) => a.path).sort(),
    ).toEqual(ASSETS.map((a) => a.path).sort());
    expect(await r.template("0.34.0", "release")).toEqual(TEMPLATE);
    expect(
      (await r.migrations("0.34.0", "release")).map((f) => f.name),
    ).toEqual(MIGRATIONS.map((f) => f.name));
    expect(await r.welcome("0.34.0", "release")).toEqual(WELCOME);
    expect(await r.floor()).toEqual(signFloor(floorOf()));
    // Account-scoped, the env's releases bucket only.
    for (const e of s.fake.log)
      expect(e.path).toMatch(
        new RegExp(
          `^/accounts/${s.fake.accountId}/r2/buckets/oa-s-releases/objects`,
        ),
      );
  });

  it("a missing record or floor is null", async () => {
    const s = await probed(setup());
    const r = r2ReleaseReader(s.cf, "staging");
    expect(await r.record("0.34.0", "release")).toBeNull();
    expect(await r.floor()).toBeNull();
  });

  it("refuses a malformed version or variant before any call", async () => {
    const s = await probed(setup());
    const r = r2ReleaseReader(s.cf, "staging");
    for (const [v, b] of [
      ["../x", "release"],
      ["0.34.0", "evil"],
      ["0.34.0/../0.1.0", "release"],
    ] as const)
      await expect(r.record(v, b as "release")).rejects.toThrow();
    expect(s.fake.log).toEqual([]);
  });

  it("pages through listings", async () => {
    const s = await published(1);
    const r = r2ReleaseReader(s.cf, "staging");
    expect((await r.assets("0.34.0", "release")).length).toBe(ASSETS.length);
    expect((await r.migrations("0.34.0", "release")).length).toBe(
      MIGRATIONS.length,
    );
    expect(
      s.fake.log.filter((e) => e.path.includes("/objects?")).length,
    ).toBeGreaterThan(2);
  });

  it("refuses an extra or resized asset before downloading any asset", async () => {
    for (const mutate of [
      (s: ReturnType<typeof setup>) =>
        s.fake.r2Seed(
          s.bucket,
          "releases/0.34.0/release/assets/extra.js",
          enc("x"),
        ),
      (s: ReturnType<typeof setup>) =>
        s.fake.r2Seed(
          s.bucket,
          "releases/0.34.0/release/assets/index.html",
          enc("much longer than before, yes"),
        ),
    ]) {
      const s = await published();
      mutate(s);
      s.fake.r2Log.length = 0;
      const e = await fails(
        r2ReleaseReader(s.cf, "staging").assets("0.34.0", "release"),
      );
      expect(e.message).toMatch(/assets|size/);
      expect(gets(s, "/assets/")).toEqual([]);
    }
  });

  it("checks each object's size against the record before its hash", async () => {
    const s = await published();
    // The listing says the record's size; the bytes served differ.
    s.fake.r2Serve = (key, bytes) =>
      key.endsWith("assets/index.html") ? concat(bytes, enc("!")) : bytes;
    const e = await fails(
      r2ReleaseReader(s.cf, "staging").assets("0.34.0", "release"),
    );
    expect(e.message).toMatch(/size/);
  });

  it("caps the asset count by ASSET_LIMITS before any download", async () => {
    const s = await published();
    for (let i = 0; i <= ASSET_LIMITS.files; i++)
      s.fake.r2Seed(
        s.bucket,
        `releases/0.34.0/release/assets/f${i}`,
        new Uint8Array(),
      );
    s.fake.r2Log.length = 0;
    const e = await fails(
      r2ReleaseReader(s.cf, "staging").assets("0.34.0", "release"),
    );
    expect(e.message).toMatch(/assets|limit/);
    expect(gets(s, "/assets/")).toEqual([]);
  }, 60_000);

  it("refuses an R2 object call outside an env's releases bucket", async () => {
    const s = await probed(setup());
    await expect(s.cf.r2ObjectGet("oa-s-iabc", "k")).rejects.toThrow(
      /releases/,
    );
    await expect(s.cf.r2ObjectList("other", "")).rejects.toThrow(/releases/);
    expect(s.fake.log).toEqual([]);
  });

  it("R-N1: deleteProbe deletes only probe/ keys; a release key and floor.json are refused before any call", async () => {
    const s = await probed(setup());
    s.fake.r2Seed(
      s.bucket,
      "releases/0.34.0/release/record.sig.json",
      enc("r"),
    );
    s.fake.r2Seed(s.bucket, FLOOR_KEY, enc("f"));
    for (const k of [
      "releases/0.34.0/release/record.sig.json",
      FLOOR_KEY,
      "probe/../releases/floor.json",
      "probe/",
      "probe/x",
      `probe/${"a".repeat(32)}/more`,
    ])
      await expect(s.r2.staging.deleteProbe(k), k).rejects.toThrow(/probe/);
    expect(s.fake.log).toEqual([]);
    expect(s.fake.r2Object(s.bucket, FLOOR_KEY)).toBeDefined();
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/record.sig.json"),
    ).toBeDefined();
    const probeKey = `probe/${"a".repeat(32)}`;
    s.fake.r2Seed(s.bucket, probeKey, enc("p"));
    await s.r2.staging.deleteProbe(probeKey);
    expect(s.fake.r2Object(s.bucket, probeKey)).toBeUndefined();
  });

  it("the S3 put sends If-None-Match / If-Match and surfaces 412", async () => {
    const s = await probed(setup());
    const r2 = s.r2.staging;
    const k = "releases/k";
    await r2.put(k, enc("1"), { ifNoneMatch: "*" });
    const e = await fails(r2.put(k, enc("2"), { ifNoneMatch: "*" }));
    expect((e as CfError).status).toBe(412);
    const head = await r2.head(k);
    expect(head?.size).toBe(1);
    await r2.put(k, enc("3"), { ifMatch: head?.etag as string });
    const e2 = await fails(
      r2.put(k, enc("4"), { ifMatch: head?.etag as string }),
    );
    expect((e2 as CfError).status).toBe(412);
    expect((await r2.get(k))?.bytes).toEqual(enc("3"));
    expect(await r2.head("releases/missing")).toBeNull();
  });
});

// ---------- G: gates ----------

describe("G: gates", () => {
  it("PROD_UNLOCKED stays false, RELEASE_PUBKEY is pinned (key ceremony 2026-10-24), FLOOR_MIN_SEQ starts at 1", async () => {
    const real = await vi.importActual<
      typeof import("../src/internal/gates.js")
    >("../src/internal/gates.js");
    expect(real.PROD_UNLOCKED).toBe(false);
    expect(real.RELEASE_PUBKEY.staging).not.toBe(
      real.RELEASE_PUBKEY_PLACEHOLDER,
    );
    expect(real.RELEASE_PUBKEY.prod).not.toBe(real.RELEASE_PUBKEY_PLACEHOLDER);
    expect(real.FLOOR_MIN_SEQ).toEqual({ staging: 1, prod: 1 });
    expect(Object.isFrozen(real.FLOOR_MIN_SEQ)).toBe(true);
  });

  it("RELEASE_PUBKEY.staging !== RELEASE_PUBKEY.prod whenever neither is the placeholder", async () => {
    const real = await vi.importActual<
      typeof import("../src/internal/gates.js")
    >("../src/internal/gates.js");
    const k = real.RELEASE_PUBKEY;
    if (
      k.staging !== real.RELEASE_PUBKEY_PLACEHOLDER &&
      k.prod !== real.RELEASE_PUBKEY_PLACEHOLDER
    )
      expect(k.staging).not.toBe(k.prod);
    // The rule itself, on a fixture.
    const same = (a: string, b: string) =>
      a !== real.RELEASE_PUBKEY_PLACEHOLDER &&
      b !== real.RELEASE_PUBKEY_PLACEHOLDER &&
      a === b;
    expect(same(pubX(KEYS.staging), pubX(KEYS.staging))).toBe(true);
    expect(same(pubX(KEYS.staging), pubX(KEYS.prod))).toBe(false);
  });

  it("FLOOR_MIN_SEQ is not exported from the package index", async () => {
    const idx = await import("../src/index.js");
    expect(Object.keys(idx)).not.toContain("FLOOR_MIN_SEQ");
    expect(
      readdirSync(new URL("../src/", import.meta.url)).includes("internal"),
    ).toBe(true);
  });
});

// ---------- fix round 2 ----------

describe("M2: R2 conditionals, retries and resume", () => {
  const good = () => ({
    tar: packUstar(tarEntries()),
    sig: sigBytes(signRec(recordOf())),
  });
  const publish = (s: ReturnType<typeof setup>, r2 = s.r2.staging) =>
    publishRelease({
      cf: s.cf,
      r2,
      env: "staging",
      version: "0.34.0",
      files: good(),
    });

  it("probeR2Conditionals passes on honest R2 and leaves nothing behind", async () => {
    const s = setup();
    await probeR2Conditionals(s.r2.staging, "staging");
    const puts = s.fake.r2Log.filter((e) => e.method === "PUT");
    expect(puts.map((p) => p.status)).toEqual([200, 412, 412, 200]);
    expect(puts.map((p) => [p.ifNoneMatch, p.ifMatch !== undefined])).toEqual([
      ["*", false],
      ["*", false],
      [undefined, true],
      [undefined, true],
    ]);
    expect(s.fake.r2Log.every((e) => e.api === "s3")).toBe(true);
    expect(puts.every((p) => p.key.startsWith("probe/"))).toBe(true);
    expect([...(s.fake.r2Objects.get(s.bucket)?.keys() ?? [])]).toEqual([]);
  });

  it("publishRelease and publishFloor refuse to run without a passed probe for that client and env", async () => {
    const s = setup();
    seedFloor(s);
    expect((await fails(publish(s))).message).toMatch(/probeR2Conditionals/);
    expect(
      (
        await fails(
          publishFloor({
            r2: s.r2.staging,
            env: "staging",
            floor: sigBytes(signFloor(floorOf())),
          }),
        )
      ).message,
    ).toMatch(/probeR2Conditionals/);
    // A probe for prod does not cover staging.
    await probeR2Conditionals(s.r2.prod, "prod");
    expect((await fails(publish(s))).message).toMatch(/probeR2Conditionals/);
    // Nor does a prod client handed in for staging.
    expect((await fails(publish(s, s.r2.prod))).message).toMatch(
      /R2 S3 client is for prod/,
    );
    await expect(probeR2Conditionals(s.r2.prod, "staging")).rejects.toThrow(
      /R2 S3 client is for prod/,
    );
    expect(r2Writes(s.fake).filter((e) => !e.path.includes("probe"))).toEqual(
      [],
    );
  });

  it("an R2 that ignores conditional headers fails the probe, and publish stays refused", async () => {
    const s = setup();
    seedFloor(s);
    s.fake.r2IgnoreConditionals = true;
    expect(
      (await fails(probeR2Conditionals(s.r2.staging, "staging"))).message,
    ).toMatch(/If-None-Match|If-Match|conditional/);
    // The second create-once PUT answered 2xx: never acceptable.
    expect(
      s.fake.r2Log.filter((e) => e.method === "PUT").map((e) => e.status),
    ).toEqual([200, 200]);
    expect((await fails(publish(s))).message).toMatch(/probeR2Conditionals/);
    expect(
      [...(s.fake.r2Objects.get(s.bucket)?.keys() ?? [])].filter((k) =>
        k.startsWith("probe/"),
      ),
    ).toEqual([]);
  });

  it("a conditional PUT that landed but answered 5xx: the retry's 412 is accepted only for identical bytes", async () => {
    const s = await probed(setup());
    seedFloor(s);
    // Every first PUT of a key stores the object, then answers 500.
    s.fake.r2PutLandsThen500 = true;
    await publish(s);
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/record.sig.json"),
    ).toBeDefined();
    const retried = s.fake.r2Log.filter(
      (e) => e.method === "PUT" && e.status === 412,
    );
    expect(retried.length).toBeGreaterThan(0);
  });

  it("a 412 on a retry with different bytes in R2 is refused", async () => {
    const s = await probed(setup());
    seedFloor(s);
    const k = "releases/0.34.0/release/welcome/welcome.md";
    s.fake.r2PutLandsThen500 = true;
    s.fake.r2OnPut = (key) =>
      key === k ? s.fake.r2Seed(s.bucket, k, enc("someone else")) : undefined;
    const e = await fails(publish(s));
    expect(e).toBeInstanceOf(PublishRefused);
    expect(e.message).toMatch(/already exists.*differs/);
    expect(
      s.fake.r2Object(s.bucket, "releases/0.34.0/release/record.sig.json"),
    ).toBeUndefined();
  });

  it("the S3 client never takes a 412 as success, on the first try or a retry", async () => {
    const s = await probed(setup());
    s.fake.r2Seed(s.bucket, "releases/k", enc("same"));
    const e = await fails(
      s.r2.staging.put("releases/k", enc("same"), { ifNoneMatch: "*" }),
    );
    expect((e as CfError).status).toBe(412);
    s.fake.r2PutLandsThen500 = true;
    const e2 = await fails(
      s.r2.staging.put("releases/j", enc("same"), { ifNoneMatch: "*" }),
    );
    expect((e2 as CfError).status).toBe(412);
  });

  it("resumes a partial version: present objects byte-identical, no record", async () => {
    const s = await probed(setup());
    seedFloor(s);
    const entries = tarEntries();
    for (const e of entries.slice(0, 3))
      s.fake.r2Seed(s.bucket, `releases/0.34.0/release/${e.path}`, e.bytes);
    await publish(s);
    const puts = s.fake.r2Log
      .filter((e) => e.method === "PUT")
      .map((e) => e.key);
    for (const e of entries.slice(0, 3))
      expect(puts).not.toContain(`releases/0.34.0/release/${e.path}`);
    expect(puts.at(-1)).toBe("releases/0.34.0/release/record.sig.json");
    expect(puts).toHaveLength(entries.length - 3 + 1);
  });

  it.each<[string, (s: ReturnType<typeof setup>) => void, RegExp]>([
    [
      "a present object with other bytes",
      (s) =>
        s.fake.r2Seed(
          s.bucket,
          "releases/0.34.0/release/welcome/welcome.md",
          enc("evil"),
        ),
      /differs/,
    ],
    [
      "a present object the tar does not have",
      (s) =>
        s.fake.r2Seed(
          s.bucket,
          "releases/0.34.0/release/assets/extra.js",
          enc("x"),
        ),
      /not in the tar/,
    ],
    [
      "a present record",
      (s) =>
        s.fake.r2Seed(
          s.bucket,
          "releases/0.34.0/release/record.sig.json",
          enc("{}"),
        ),
      /already published/,
    ],
  ])("refuses to resume over %s, with zero writes", async (_n, seed, re) => {
    const s = await probed(setup());
    seedFloor(s);
    seed(s);
    const e = await fails(publish(s));
    expect(e.message).toMatch(re);
    expect(r2Writes(s.fake)).toEqual([]);
  });

  it("N2: publishFloor caps the current floor's size", async () => {
    const s = await probed(setup());
    s.fake.r2Seed(s.bucket, FLOOR_KEY, new Uint8Array(16 * 1024 * 1024 + 1));
    const e = await fails(
      publishFloor({
        r2: s.r2.staging,
        env: "staging",
        floor: sigBytes(signFloor(floorOf({ seq: 2 }))),
      }),
    );
    expect(e.message).toMatch(/size|large/);
  });
});

describe("L6, L7: r2ReleaseReader caps and binds", () => {
  async function published() {
    const s = await probed(setup());
    seedFloor(s);
    await publishRelease({
      cf: s.cf,
      r2: s.r2.staging,
      env: "staging",
      version: "0.34.0",
      files: {
        tar: packUstar(tarEntries()),
        sig: sigBytes(signRec(recordOf())),
      },
    });
    return s;
  }

  it("L6: caps the total listed module bytes before any download", async () => {
    const s = await published();
    const big = new Uint8Array(ASSET_LIMITS.fileBytes);
    for (let i = 0; i < 21; i++)
      s.fake.r2Seed(s.bucket, `releases/0.34.0/release/modules/m${i}.js`, big);
    s.fake.r2Log.length = 0;
    const e = await fails(
      r2ReleaseReader(s.cf, "staging").modules("0.34.0", "release"),
    );
    expect(e.message).toMatch(/total|limit/);
    expect(
      s.fake.r2Log.filter(
        (x) => x.method === "GET" && x.key.includes("/modules/"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("L6: a GET whose body exceeds the listed size is aborted", async () => {
    const s = await published();
    s.fake.r2Serve = (key, bytes) =>
      key.endsWith("modules/index.js")
        ? concat(bytes, new Uint8Array(1024))
        : bytes;
    const e = await fails(
      r2ReleaseReader(s.cf, "staging").modules("0.34.0", "release"),
    );
    expect(e.message).toMatch(/size|over/);
  });

  it("L7: assets refuses a record of another version or variant copied to this path", async () => {
    const s = await published();
    s.fake.r2Seed(
      s.bucket,
      "releases/0.34.0/release/record.sig.json",
      sigBytes(signRec(recordOf({ version: "0.34.1" }))),
    );
    const e = await fails(
      r2ReleaseReader(s.cf, "staging").assets("0.34.0", "release"),
    );
    expect(e.message).toMatch(/version|record/);
  });
});

describe("N3: ustar headers are canonical", () => {
  it.each<[string, Uint8Array, RegExp]>([
    [
      "a directory entry",
      rawTar([{ name: "assets", o: { type: "5" } }]),
      /director/,
    ],
    [
      "bytes after the NUL in the name",
      (() => {
        const t = rawTar([{ name: "a", data: enc("x") }]);
        t[60] = 0x41;
        let sum = 0;
        for (let i = 0; i < 512; i++)
          sum += i >= 148 && i < 156 ? 32 : (t[i] as number);
        t.set(enc(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
        return t;
      })(),
      /name|NUL|canonical/,
    ],
    [
      "bytes after the NUL in the prefix",
      (() => {
        const t = rawTar([{ name: "b", data: enc("x"), o: { prefix: "a" } }]);
        t[400] = 0x41;
        let sum = 0;
        for (let i = 0; i < 512; i++)
          sum += i >= 148 && i < 156 ? 32 : (t[i] as number);
        t.set(enc(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
        return t;
      })(),
      /prefix|NUL|canonical/,
    ],
  ])("parseUstar refuses %s", (_n, tar, re) => {
    expect(() => parseUstar(tar)).toThrow(re);
  });
});

describe("N6: openReleaseRecord checks the record itself", () => {
  const pub = () => G.RELEASE_PUBKEY.staging as string;
  it.each<[string, Record<string, unknown>, RegExp]>([
    ["another env inside the record", { env: "prod" }, /env/],
    ["an unknown variant", { variant: "evil" }, /variant/],
    [
      "defines that do not match the variant",
      { defines: { [TEST_HOOKS_DEFINE]: true } },
      /variant|define/,
    ],
    ["a non-hex sha256", { sha256: "x".repeat(64) }, /sha256/],
    ["a non-semver version", { version: "latest" }, /version/],
    [
      "an asset entry without a valid size",
      { assets: [{ path: "a", size: -1, sha256: "0".repeat(64) }] },
      /size/,
    ],
  ])("refuses %s (signed)", (_n, over, re) => {
    const rec = { ...JSON.parse(canonicalJson(recordOf())), ...over };
    expect(() =>
      openReleaseRecord(signRec(rec, "staging"), pub(), "staging"),
    ).toThrow(re);
  });
});

// T3b: the CI signer (scripts/ci/sign-release.ts, node:* only) against
// @oa/provision. Its canonicalJson and record builder must produce the same
// bytes; its output must pass publishRelease. The key goes in on stdin only.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as LIB from "../../../scripts/ci/release-artifact.mjs";
import * as PUBKEYS from "../../../scripts/ci/release-pubkeys.mjs";
import { cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { canonicalJson } from "../src/platform.js";
import {
  FLOOR_KEY,
  probeR2Conditionals,
  publishRelease,
  r2ReleaseReader,
} from "../src/publish.js";
import { r2S3Client } from "../src/r2s3.js";
import {
  assetEntries,
  buildReleaseRecord,
  bundleSha256,
  migrationsSha256,
  openFloor,
  openReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "../src/release.js";
import { FakeCf } from "./fake-cf.js";

/**
 * R-N2: every test here spawns node (several times, each capped at
 * SPAWN_MS) and signs with real Ed25519. That takes about 1 s idle and
 * several times that on a loaded machine, which crossed vitest's 5 s default
 * (review run B: 41 s suite, "Test timed out in 5000ms"). The per-test budget
 * is the spawn cap, so only a hung child fails a test.
 */
const SPAWN_MS = 60_000;
vi.setConfig({ testTimeout: SPAWN_MS });

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
}));
vi.mock("../src/internal/gates.js", async (orig) => {
  const m = await orig<typeof import("../src/internal/gates.js")>();
  return {
    ...m,
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
  };
});

const ROOT = new URL("../../../", import.meta.url).pathname;
const CHECK = join(ROOT, "scripts/ci/check-hosted-release.ts");
const enc = (s: string) => new TextEncoder().encode(s);

const KEYS = {
  staging: generateKeyPairSync("ed25519"),
  prod: generateKeyPairSync("ed25519"),
};
const pubX = (k: { publicKey: KeyObject }) =>
  k.publicKey.export({ format: "jwk" }).x as string;
G.RELEASE_PUBKEY = { staging: pubX(KEYS.staging), prod: pubX(KEYS.prod) };
const pem = (env: "staging" | "prod") =>
  KEYS[env].privateKey.export({ format: "pem", type: "pkcs8" }).toString();

/**
 * The key-job scripts (plain .mjs, run on Node 22 from .nvmrc) pin the real
 * release keys, so the CLI tests run the real scripts from a temp copy whose
 * release-pubkeys.mjs pins these test keys instead, or the placeholder. There
 * is no runtime override: the shipped scripts can only ever use the pinned keys.
 */
function scriptsPinnedTo(pins: { staging: string; prod: string } | null) {
  const dir = mkdtempSync(join(tmpdir(), "oa-keyjob-"));
  for (const f of readdirSync(join(ROOT, "scripts/ci")))
    if (f.endsWith(".mjs"))
      copyFileSync(join(ROOT, "scripts/ci", f), join(dir, f));
  const p = join(dir, "release-pubkeys.mjs");
  const src = readFileSync(p, "utf8");
  const block = /export const RELEASE_PUBKEY = Object\.freeze\(\{[^}]*\}\);/;
  if (!block.test(src)) throw new Error("release-pubkeys.mjs layout changed");
  const body = pins
    ? `staging: ${JSON.stringify(pins.staging)}, prod: ${JSON.stringify(pins.prod)}`
    : "staging: RELEASE_PUBKEY_PLACEHOLDER, prod: RELEASE_PUBKEY_PLACEHOLDER";
  writeFileSync(
    p,
    src.replace(
      block,
      `export const RELEASE_PUBKEY = Object.freeze({ ${body} });`,
    ),
  );
  return dir;
}
const PINNED = scriptsPinnedTo({
  staging: pubX(KEYS.staging),
  prod: pubX(KEYS.prod),
});
const UNPINNED = scriptsPinnedTo(null);
const SIGN = join(PINNED, "sign-release.mjs");
const ASSEMBLE = join(PINNED, "assemble-release.mjs");
const SIGN_FLOOR = join(PINNED, "sign-floor.mjs");

const TEMPLATE = new Uint8Array(
  readFileSync(join(ROOT, "apps/server/wrangler.template.jsonc")),
);
const mods = (v: boolean) => [
  {
    name: "index.js",
    type: "esm" as const,
    bytes: enc(
      `const t = true;\nconst hooks = ${v} === true && t;\nexport default {};\n`,
    ),
  },
  {
    name: "chunks/a.wasm",
    type: "wasm" as const,
    bytes: new Uint8Array([0, 97, 115, 109]),
  },
];
const FIX = {
  version: "0.34.0",
  mainModule: "index.js",
  release: mods(false),
  redline: mods(true),
  assets: [
    { path: "index.html", bytes: enc("<p>hi</p>") },
    { path: "assets/app.js", bytes: enc("console.log(1)") },
  ],
  template: TEMPLATE,
  migrations: [{ name: "0000_init.sql", bytes: enc("CREATE TABLE a (x);\n") }],
  welcome: enc("# Welcome\n"),
  built: {
    release: { commit: "", lockfileSha256: "" },
    redline: { commit: "", lockfileSha256: "" },
  },
  // M1: the rendered dry-run configs travel in the artifact.
  configs: {
    release: JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: "false" },
    }),
    redline: JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: "true" },
    }),
  },
};
// hosted-guard's commit, and the lockfile the sign job checks out (this repo's).
const GUARD = "a".repeat(40);
const LOCK = join(ROOT, "pnpm-lock.yaml");
const LOCK_SHA = createHash("sha256").update(readFileSync(LOCK)).digest("hex");
FIX.built = {
  release: { commit: GUARD, lockfileSha256: LOCK_SHA },
  redline: { commit: GUARD, lockfileSha256: LOCK_SHA },
};

async function artifact(over: Partial<typeof FIX> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oa-art-"));
  const out = await LIB.writeArtifact(dir, { ...FIX, ...over });
  return { dir, ...out };
}

function run(
  script: string,
  args: string[],
  input = "",
): { code: number | null; stdout: string; stderr: string } {
  // The .ts helpers (check-hosted-release) still need strip-types.
  const flags = script.endsWith(".ts")
    ? ["--experimental-strip-types", "--no-warnings"]
    : [];
  const r = spawnSync(process.execPath, [...flags, script, ...args], {
    input,
    encoding: "utf8",
    timeout: SPAWN_MS,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const outputs = (stdout: string) =>
  Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("=") as [string, string]),
  );

async function signed(
  env: "staging" | "prod" = "staging",
  over: Partial<typeof FIX> = {},
) {
  const a = await artifact(over);
  const check = run(CHECK, [a.dir]);
  expect(check.code, check.stderr).toBe(0);
  const c = outputs(check.stdout);
  const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
  const args = [
    "--dir",
    a.dir,
    "--env",
    env,
    "--version",
    "0.34.0",
    "--manifest-sha256",
    c.manifest_sha256 as string,
    "--bundle-sha256",
    c.bundle_sha256 as string,
    "--commit",
    GUARD,
    "--lockfile",
    LOCK,
    "--out",
    out,
  ];
  const r = run(SIGN, args, pem(env));
  return { a, c, out, args, r, o: outputs(r.stdout) };
}

describe("parity with @oa/provision", () => {
  it("canonicalJson produces identical bytes on fixtures", () => {
    for (const v of [
      { b: 1, a: [3, { d: null, c: 'x "' }], e: true },
      [],
      "s",
      0,
      { "": { z: 1, y: [false] } },
    ])
      expect(LIB.canonicalJson(v)).toBe(canonicalJson(v));
  });

  it("the record builder produces identical bytes on fixtures", () => {
    for (const [env, variant] of [
      ["staging", "release"],
      ["staging", "redline"],
      ["prod", "release"],
    ] as const) {
      const i = {
        env,
        version: FIX.version,
        variant,
        mainModule: FIX.mainModule,
        modules: variant === "redline" ? FIX.redline : FIX.release,
        assets: FIX.assets,
        template: FIX.template,
        migrations: FIX.migrations,
        welcome: FIX.welcome,
      };
      const a = LIB.canonicalJson(LIB.buildRecord(i));
      const b = canonicalJson(buildReleaseRecord(i));
      expect(a).toBe(b);
      expect(JSON.parse(a).defines).toEqual({
        [TEST_HOOKS_DEFINE]: variant === "redline",
      });
    }
    expect(
      LIB.bundleSha256({ mainModule: FIX.mainModule, modules: FIX.release }),
    ).toBe(bundleSha256({ mainModule: FIX.mainModule, modules: FIX.release }));
    expect(LIB.migrationsSha256(FIX.migrations)).toBe(
      migrationsSha256(FIX.migrations),
    );
    expect(LIB.canonicalJson(LIB.assetEntries(FIX.assets))).toBe(
      canonicalJson(assetEntries(FIX.assets)),
    );
  });

  it("the record builder refuses what provision refuses", () => {
    const base = {
      ...FIX,
      env: "staging" as const,
      variant: "release" as const,
      modules: FIX.release,
    };
    for (const bad of [
      { env: "prod" as const, variant: "redline" as const },
      { version: "v1" },
      { assets: [{ path: ".env", bytes: enc("") }] },
      {
        assets: [
          { path: `${"d".repeat(60)}/${"f".repeat(101)}`, bytes: enc("") },
        ],
      },
      {
        assets: [{ path: "big", bytes: new Uint8Array(25 * 1024 * 1024 + 1) }],
      },
    ]) {
      expect(
        () => LIB.buildRecord({ ...base, ...bad }),
        JSON.stringify(Object.keys(bad)),
      ).toThrow();
      expect(() => buildReleaseRecord({ ...base, ...bad })).toThrow();
    }
  });
});

describe("check-hosted-release.ts", () => {
  it("prints the bundleSha256 recomputed from the bytes and the manifest's sha256", async () => {
    const a = await artifact();
    const r = run(CHECK, [a.dir]);
    expect(r.code, r.stderr).toBe(0);
    const o = outputs(r.stdout);
    expect(o.bundle_sha256).toBe(
      bundleSha256({ mainModule: "index.js", modules: FIX.release }),
    );
    expect(o.manifest_sha256).toBe(a.manifestSha256);
  });

  it("refuses a file that does not match manifest.json, an extra file and a symlink", async () => {
    const a = await artifact();
    writeFileSync(join(a.dir, "assets/index.html"), "<p>HI</p>");
    expect(run(CHECK, [a.dir]).code).toBe(1);
    const b = await artifact();
    writeFileSync(join(b.dir, "assets/extra.js"), "x");
    expect(run(CHECK, [b.dir]).code).toBe(1);
    const c = await artifact();
    symlinkSync("/etc/hosts", join(c.dir, "assets/hosts"));
    expect(run(CHECK, [c.dir]).code).toBe(1);
  });
});

describe("sign-release.ts", () => {
  it("staging: signs release and redline, writes the tar and .sig.json, prints only outputs", async () => {
    const s = await signed("staging");
    expect(s.r.code, s.r.stderr).toBe(0);
    expect(readdirSync(s.out).sort()).toEqual([
      "oa-release-staging-redline-0.34.0.sig.json",
      "oa-release-staging-redline-0.34.0.tar",
      "oa-release-staging-release-0.34.0.sig.json",
      "oa-release-staging-release-0.34.0.tar",
    ]);
    expect(Object.keys(s.o).sort()).toEqual([
      "staging_redline_record_sha256",
      "staging_redline_signature",
      "staging_redline_tar_sha256",
      "staging_release_record_sha256",
      "staging_release_signature",
      "staging_release_tar_sha256",
      "staging_signed",
    ]);
    // The key never reaches stdout, stderr or the written files.
    const der = KEYS.staging.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const d = KEYS.staging.privateKey.export({ format: "jwk" }).d as string;
    for (const text of [
      s.r.stdout,
      s.r.stderr,
      ...readdirSync(s.out).map((f) => readFileSync(join(s.out, f), "latin1")),
    ]) {
      expect(text).not.toContain(der.slice(20, 60));
      expect(text).not.toContain(d);
      expect(text).not.toContain("PRIVATE KEY");
    }
    // The .sig.json verifies with provision's reader.
    for (const v of ["release", "redline"] as const) {
      const stored = JSON.parse(
        readFileSync(
          join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
          "utf8",
        ),
      );
      const rec = openReleaseRecord(
        stored,
        G.RELEASE_PUBKEY.staging as string,
        "staging",
      );
      expect(rec.variant).toBe(v);
      expect(rec.defines[TEST_HOOKS_DEFINE]).toBe(v === "redline");
      expect(stored.signature).toBe(s.o[`staging_${v}_signature`]);
    }
  });

  it("prod: signs release only", async () => {
    const s = await signed("prod");
    expect(s.r.code, s.r.stderr).toBe(0);
    expect(readdirSync(s.out).sort()).toEqual([
      "oa-release-prod-release-0.34.0.sig.json",
      "oa-release-prod-release-0.34.0.tar",
    ]);
  });

  it("its tar and .sig.json pass publishRelease and read back through r2ReleaseReader", async () => {
    const s = await signed("staging");
    expect(s.r.code, s.r.stderr).toBe(0);
    const fake = new FakeCf();
    fake.r2.add(platformNames("staging").releases);
    const floor = canonicalJson({
      env: "staging",
      seq: 1,
      minVersion: "0.1.0",
      revoked: [],
    });
    const { sign } = await import("node:crypto");
    fake.r2Seed(
      "oa-s-releases",
      FLOOR_KEY,
      enc(
        JSON.stringify({
          record: floor,
          signature: sign(
            null,
            Buffer.from(`oa-release-floor-v1\nstaging\n${floor}`),
            KEYS.staging.privateKey,
          ).toString("base64url"),
        }),
      ),
    );
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const r2 = r2S3Client({
      accountId: fake.accountId,
      env: "staging",
      credentials: fake.r2Token(platformNames("staging").releases),
      fetch: fake.fetch,
      sleep: async () => {},
    });
    await probeR2Conditionals(r2, "staging");
    for (const v of ["release", "redline"] as const)
      await publishRelease({
        cf,
        r2,
        env: "staging",
        version: "0.34.0",
        files: {
          tar: new Uint8Array(
            readFileSync(join(s.out, `oa-release-staging-${v}-0.34.0.tar`)),
          ),
          sig: new Uint8Array(
            readFileSync(
              join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
            ),
          ),
        },
      });
    const r = r2ReleaseReader(cf, "staging");
    expect(bundleSha256(await r.modules("0.34.0", "redline"))).toBe(
      bundleSha256({ mainModule: "index.js", modules: FIX.redline }),
    );
  });

  it.each<
    [string, (s: Awaited<ReturnType<typeof signed>>) => string[], string]
  >([
    [
      "a manifest sha256 that is not hosted-check's",
      (s) => swap(s.args, "--manifest-sha256", "0".repeat(64)),
      "staging",
    ],
    [
      "a bundle sha256 that is not hosted-check's",
      (s) => swap(s.args, "--bundle-sha256", "0".repeat(64)),
      "staging",
    ],
    [
      "a version other than the manifest's",
      (s) => swap(s.args, "--version", "0.34.1"),
      "staging",
    ],
    ["an unknown env", (s) => swap(s.args, "--env", "dev"), "staging"],
    ["a key in argv", (s) => [...s.args, "--key", "x"], "staging"],
    ["a non-Ed25519 key", (s) => s.args, "rsa"],
  ])("refuses %s", async (_n, argsOf, keyKind) => {
    const s = await signed("staging");
    const key =
      keyKind === "staging"
        ? pem("staging")
        : keyKind === "rsa"
          ? generateKeyPairSync("rsa", { modulusLength: 2048 })
              .privateKey.export({ format: "pem", type: "pkcs8" })
              .toString()
          : "";
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const r = run(SIGN, swap(argsOf(s), "--out", out), key);
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
    expect(r.stdout).toBe("");
  });

  it("with the placeholder keys, an empty stdin skips: exit 0, <env>_signed=false, no files", async () => {
    for (const env of ["staging", "prod"] as const) {
      const s = await signed(env);
      const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
      const r = run(
        join(UNPINNED, "sign-release.mjs"),
        swap(s.args, "--out", out),
        "",
      );
      expect(r.code, r.stderr).toBe(0);
      expect(outputs(r.stdout)).toEqual({ [`${env}_signed`]: "false" });
      expect(readdirSync(out)).toEqual([]);
      expect(r.stderr).toMatch(/::notice::/);
    }
  });
  it("once pinned, an empty stdin fails (no skip)", async () => {
    const s = await signed("staging");
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const r = run(SIGN, swap(s.args, "--out", out), "");
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
    expect(r.stdout).toBe("");
  });
  // The gap between key generation and the pin PR: a real key with the
  // placeholder still pinned must refuse, never warn and sign.
  it("a key on stdin while RELEASE_PUBKEY is still the placeholder is refused", async () => {
    for (const env of ["staging", "prod"] as const) {
      const s = await signed(env);
      const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
      const r = run(
        join(UNPINNED, "sign-release.mjs"),
        swap(s.args, "--out", out),
        pem(env),
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(
        new RegExp(`key set but RELEASE_PUBKEY\\.${env} not pinned`),
      );
      expect(readdirSync(out)).toEqual([]);
      expect(r.stdout).toBe("");
    }
  });
  it("a signed run also outputs <env>_signed=true", async () => {
    const s = await signed("prod");
    expect(s.r.code, s.r.stderr).toBe(0);
    expect(s.o.prod_signed).toBe("true");
  });

  it("refuses a file changed after hosted-check (re-hashed against manifest.json)", async () => {
    const s = await signed("staging");
    writeFileSync(join(s.a.dir, "welcome/welcome.md"), "# Evil\n");
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const r = run(SIGN, swap(s.args, "--out", out), pem("staging"));
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });

  // T3b ruling (option 2): the bundles may differ (esbuild tree-shakes the
  // hooks out of release); the configs are compared in hosted-build instead.
  it("signs a redline whose bytes differ from release beyond the define", async () => {
    const red = mods(true);
    red[0] = {
      ...red[0],
      bytes: enc("const hooks = true;\nexport default { hooks };\n"),
    } as (typeof red)[0];
    const s = await signed("staging", { redline: red });
    expect(s.r.code, s.r.stderr).toBe(0);
    for (const v of ["release", "redline"] as const) {
      const stored = JSON.parse(
        readFileSync(
          join(s.out, `oa-release-staging-${v}-0.34.0.sig.json`),
          "utf8",
        ),
      );
      expect(
        openReleaseRecord(stored, G.RELEASE_PUBKEY.staging as string, "staging")
          .defines,
      ).toEqual({
        [TEST_HOOKS_DEFINE]: v === "redline",
      });
    }
  });

  const built = (
    r: Partial<{ commit: string; lockfileSha256: string }>,
    d: Partial<{ commit: string; lockfileSha256: string }>,
  ) => ({
    built: {
      release: { commit: GUARD, lockfileSha256: LOCK_SHA, ...r },
      redline: { commit: GUARD, lockfileSha256: LOCK_SHA, ...d },
    },
  });
  it.each<[string, Partial<typeof FIX>, string[], RegExp]>([
    [
      "release and redline from different commits",
      built({}, { commit: "b".repeat(40) }),
      [],
      /different commits/,
    ],
    [
      "release and redline with different lockfiles",
      built({}, { lockfileSha256: "0".repeat(64) }),
      [],
      /different lockfiles/,
    ],
    [
      "a commit other than hosted-guard's",
      {},
      ["--commit", "c".repeat(40)],
      /hosted-guard/,
    ],
    [
      "both builds from another commit than the guard's",
      built({ commit: "d".repeat(40) }, { commit: "d".repeat(40) }),
      [],
      /hosted-guard/,
    ],
    [
      "a lockfile other than the checked-out one",
      built(
        { lockfileSha256: "1".repeat(64) },
        { lockfileSha256: "1".repeat(64) },
      ),
      [],
      /lockfile/,
    ],
    [
      "a release bundle with a hook route",
      {
        release: [
          {
            name: "index.js",
            type: "esm",
            bytes: enc('app.get("/__test/session", h); const hooks = false;'),
          },
        ],
      },
      [],
      /hook route/,
    ],
    [
      "a release bundle with any other /__test/ string",
      {
        release: [
          {
            name: "index.js",
            type: "esm",
            bytes: enc('app.get("/__test/new-hook", h); const hooks = false;'),
          },
        ],
      },
      [],
      /hook route/,
    ],
  ])("refuses %s", async (_n, over, extra, re) => {
    const a = await artifact(over);
    const ck = run(CHECK, [a.dir]);
    const c =
      ck.code === 0
        ? outputs(ck.stdout)
        : {
            manifest_sha256: a.manifestSha256,
            bundle_sha256: a.bundleSha256.release,
          };
    const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
    const args = [
      "--dir",
      a.dir,
      "--env",
      "staging",
      "--version",
      "0.34.0",
      "--manifest-sha256",
      c.manifest_sha256 as string,
      "--bundle-sha256",
      c.bundle_sha256 as string,
      "--commit",
      GUARD,
      "--lockfile",
      LOCK,
      "--out",
      out,
    ];
    const r = run(
      SIGN,
      extra.length ? swap(args, extra[0] as string, extra[1] as string) : args,
      pem("staging"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(readdirSync(out)).toEqual([]);
  });

  it("check-hosted-release refuses a release bundle with a hook route", async () => {
    const a = await artifact({
      release: [
        { name: "index.js", type: "esm", bytes: enc('"/__test/otp/latest"') },
      ],
    });
    const r = run(CHECK, [a.dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/hook route/);
  });

  it("assertSameConfigButDefine: only the define value may differ", () => {
    const cfg = (v: string, extra = {}) =>
      JSON.stringify({
        main: "x",
        define: { [TEST_HOOKS_DEFINE]: v },
        ...extra,
      });
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("false"), cfg("true")),
    ).not.toThrow();
    expect(() =>
      LIB.assertSameConfigButDefine(
        cfg("false"),
        cfg("true", { vars: { A: "1" } }),
      ),
    ).toThrow(/differ/);
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("true"), cfg("false")),
    ).toThrow(/define/);
    expect(() =>
      LIB.assertSameConfigButDefine(cfg("false"), cfg("false")),
    ).toThrow(/define/);
  });
});

describe("assemble-release.ts", () => {
  it("rebuilds the signed files from the artifact and the sign job's outputs, byte-identical", async () => {
    const s = await signed("staging");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const pass = (v: string) =>
      `${s.o[`staging_${v}_signature`]}:${s.o[`staging_${v}_tar_sha256`]}:${s.o[`staging_${v}_record_sha256`]}`;
    const r = run(ASSEMBLE, [
      ...swap(s.args, "--out", out),
      "--release",
      pass("release"),
      "--redline",
      pass("redline"),
    ]);
    expect(r.code, r.stderr).toBe(0);
    for (const f of readdirSync(s.out))
      expect(readFileSync(join(out, f)), f).toEqual(
        readFileSync(join(s.out, f)),
      );
  });

  it("refuses a tar or record hash that is not the sign job's", async () => {
    const s = await signed("prod");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const r = run(ASSEMBLE, [
      ...swap(s.args, "--out", out),
      "--release",
      `${s.o.prod_release_signature}:${"0".repeat(64)}:${s.o.prod_release_record_sha256}`,
    ]);
    expect(r.code).toBe(1);
    expect(readdirSync(out)).toEqual([]);
  });
});

function swap(args: string[], flag: string, value: string): string[] {
  const out = [...args];
  const i = out.indexOf(flag);
  if (i < 0) return [...out, flag, value];
  out[i + 1] = value;
  return out;
}

// ---------- fix round 2 ----------

/** Sign with hosted-check's real outputs for this artifact; returns the run. */
async function signArtifact(
  over: Partial<typeof FIX>,
  env: "staging" | "prod" = "staging",
) {
  const a = await artifact(over);
  const ck = run(CHECK, [a.dir]);
  const c =
    ck.code === 0
      ? outputs(ck.stdout)
      : {
          manifest_sha256: a.manifestSha256,
          bundle_sha256: a.bundleSha256.release,
        };
  const out = mkdtempSync(join(tmpdir(), "oa-signed-"));
  const r = run(
    SIGN,
    [
      "--dir",
      a.dir,
      "--env",
      env,
      "--version",
      "0.34.0",
      "--manifest-sha256",
      c.manifest_sha256 as string,
      "--bundle-sha256",
      c.bundle_sha256 as string,
      "--commit",
      GUARD,
      "--lockfile",
      LOCK,
      "--out",
      out,
    ],
    pem(env),
  );
  return { r, out };
}

describe("M1: defines come from the rendered configs in the artifact", () => {
  const cfg = (v: string, extra = {}) =>
    JSON.stringify({
      main: "src/index.ts",
      define: { [TEST_HOOKS_DEFINE]: v },
      ...extra,
    });
  it("manifest.json covers config/release.json and config/redline.json", async () => {
    const a = await artifact();
    const m = JSON.parse(readFileSync(join(a.dir, "manifest.json"), "utf8"));
    const paths = m.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["config/release.json", "config/redline.json"]),
    );
    writeFileSync(join(a.dir, "config/release.json"), cfg("true"));
    expect(run(CHECK, [a.dir]).code).toBe(1);
  });
  it.each<[string, { release: string; redline: string }, RegExp]>([
    [
      "both variants hooks-on",
      { release: cfg("true"), redline: cfg("true") },
      /define/,
    ],
    [
      "swapped configs",
      { release: cfg("true"), redline: cfg("false") },
      /define/,
    ],
    [
      "configs that differ in another key",
      { release: cfg("false"), redline: cfg("true", { vars: { A: "1" } }) },
      /differ/,
    ],
  ])("refuses %s", async (_n, configs, re) => {
    const { r, out } = await signArtifact({ configs });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(re);
    expect(readdirSync(out)).toEqual([]);
  });
  it("derives defines from the config value: the parsed define, not the label", () => {
    expect(LIB.testHooksOf(cfg("false"))).toBe(false);
    expect(LIB.testHooksOf(cfg("true"))).toBe(true);
    for (const bad of [
      cfg("1"),
      cfg("TRUE"),
      JSON.stringify({ define: {} }),
      "{",
    ])
      expect(() => LIB.testHooksOf(bad), bad).toThrow();
  });
});

describe("L2: the route-policy doc key may appear once across release", () => {
  it("refuses two occurrences", async () => {
    const twice = [
      {
        name: "index.js",
        type: "esm" as const,
        bytes: enc('const a = { "ALL /__test/*": 1 }; const hooks = false;'),
      },
      {
        name: "b.js",
        type: "esm" as const,
        bytes: enc('const b = { "ALL /__test/*": 2 };'),
      },
    ];
    expect(() => LIB.assertNoHookRoutes(twice)).toThrow(/once|ALL/);
    expect(() => LIB.assertNoHookRoutes(twice.slice(0, 1))).not.toThrow();
  });
});

describe("L11: pinned public keys in the node:* copy", () => {
  it("equal gates.ts RELEASE_PUBKEY and its placeholder (parity)", async () => {
    const real = await vi.importActual<
      typeof import("../src/internal/gates.js")
    >("../src/internal/gates.js");
    expect(PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER).toBe(
      real.RELEASE_PUBKEY_PLACEHOLDER,
    );
    expect({ ...PUBKEYS.RELEASE_PUBKEY }).toEqual({ ...real.RELEASE_PUBKEY });
  });
  const x = (e: "staging" | "prod") => pubX(KEYS[e]);
  it("checkSigningKey: refuses a key that is not the pinned one, and any key while a placeholder", () => {
    const pinned = { staging: x("staging"), prod: x("prod") };
    expect(PUBKEYS.checkSigningKey("staging", x("staging"), pinned)).toBe(
      "verified",
    );
    expect(() => PUBKEYS.checkSigningKey("prod", x("staging"), pinned)).toThrow(
      /not the pinned/,
    );
    const ph = {
      staging: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(() => PUBKEYS.checkSigningKey("prod", x("prod"), ph)).toThrow(
      /key set but RELEASE_PUBKEY\.prod not pinned/,
    );
  });
  // v0.35.0's release went red on "no signing key on stdin" before the key
  // ceremony. While an env's key is the placeholder, no key means skip (a
  // notice, <env>_signed=false, the attach job skips); once pinned, it fails.
  it("skipUnsigned: skips a missing key only while the pinned key is the placeholder", () => {
    const pinned = { staging: x("staging"), prod: x("prod") };
    const ph = {
      staging: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(PUBKEYS.skipUnsigned("staging", "", ph)).toBe(true);
    expect(PUBKEYS.skipUnsigned("prod", "  \n", ph)).toBe(true);
    expect(PUBKEYS.skipUnsigned("staging", "", pinned)).toBe(false);
    expect(PUBKEYS.skipUnsigned("prod", "", pinned)).toBe(false);
    // A key that is present is always signed with (and checked if pinned).
    expect(PUBKEYS.skipUnsigned("staging", pem("staging"), ph)).toBe(false);
    expect(PUBKEYS.skipUnsigned("staging", pem("staging"), pinned)).toBe(false);
    // Only one env pinned: the other may still skip.
    const half = {
      staging: x("staging"),
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(PUBKEYS.skipUnsigned("staging", "", half)).toBe(false);
    expect(PUBKEYS.skipUnsigned("prod", "", half)).toBe(true);
  });
  it("verifySignature: refuses an invalid signature once the key is real, and any signature while a placeholder", async () => {
    const { sign } = await import("node:crypto");
    const payload = Buffer.from("oa-release-v1\nstaging\n{}");
    const good = sign(null, payload, KEYS.staging.privateKey).toString(
      "base64url",
    );
    const bad = sign(null, payload, KEYS.prod.privateKey).toString("base64url");
    const pinned = { staging: x("staging"), prod: x("prod") };
    expect(PUBKEYS.verifySignature("staging", payload, good, pinned)).toBe(
      "verified",
    );
    expect(() =>
      PUBKEYS.verifySignature("staging", payload, bad, pinned),
    ).toThrow(/does not verify/);
    const ph = {
      staging: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
      prod: PUBKEYS.RELEASE_PUBKEY_PLACEHOLDER,
    };
    expect(() => PUBKEYS.verifySignature("staging", payload, good, ph)).toThrow(
      /key set but RELEASE_PUBKEY\.staging not pinned/,
    );
  });
  it("assemble refuses while the pubkey is still the placeholder", async () => {
    const s = await signed("prod");
    const out = mkdtempSync(join(tmpdir(), "oa-asm-"));
    const r = run(join(UNPINNED, "assemble-release.mjs"), [
      ...swap(s.args, "--out", out),
      "--release",
      `${s.o.prod_release_signature}:${s.o.prod_release_tar_sha256}:${s.o.prod_release_record_sha256}`,
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/key set but RELEASE_PUBKEY\.prod not pinned/);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("H1: sign-floor.ts", () => {
  const args = (env: string, o: Record<string, string> = {}) => {
    const out = mkdtempSync(join(tmpdir(), "oa-floor-"));
    const a = {
      "--env": env,
      "--seq": "3",
      "--min-version": "0.30.0",
      "--revoked": "0.31.0,0.32.1",
      "--out": out,
      ...o,
    };
    return { out, argv: Object.entries(a).flat() };
  };
  it("signs a floor whose bytes open with provision's openFloor, and prints only outputs", () => {
    const { out, argv } = args("staging");
    const r = run(SIGN_FLOOR, argv, pem("staging"));
    expect(r.code, r.stderr).toBe(0);
    expect(readdirSync(out)).toEqual(["floor-staging-3.sig.json"]);
    const bytes = readFileSync(join(out, "floor-staging-3.sig.json"), "utf8");
    const f = openFloor(JSON.parse(bytes), pubX(KEYS.staging), "staging");
    expect(f).toMatchObject({
      env: "staging",
      seq: 3,
      minVersion: "0.30.0",
      revoked: ["0.31.0", "0.32.1"],
    });
    expect(Object.keys(outputs(r.stdout)).sort()).toEqual([
      "floor_record_sha256",
      "floor_signature",
    ]);
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");
    // An empty revoked list.
    const e = args("prod", { "--revoked": "" });
    expect(run(SIGN_FLOOR, e.argv, pem("prod")).code).toBe(0);
    expect(
      openFloor(
        JSON.parse(readFileSync(join(e.out, "floor-prod-3.sig.json"), "utf8")),
        pubX(KEYS.prod),
        "prod",
      ).revoked,
    ).toEqual([]);
  });
  it("--assemble rebuilds the identical file from the signature and the record sha256, with no key", () => {
    const s = args("staging");
    const r = run(SIGN_FLOOR, s.argv, pem("staging"));
    const o = outputs(r.stdout);
    const a = args("staging");
    const r2 = run(SIGN_FLOOR, [
      ...a.argv,
      "--assemble",
      "--signature",
      o.floor_signature as string,
      "--record-sha256",
      o.floor_record_sha256 as string,
    ]);
    expect(r2.code, r2.stderr).toBe(0);
    expect(readFileSync(join(a.out, "floor-staging-3.sig.json"))).toEqual(
      readFileSync(join(s.out, "floor-staging-3.sig.json")),
    );
    const bad = args("staging", { "--seq": "4" });
    expect(
      run(SIGN_FLOOR, [
        ...bad.argv,
        "--assemble",
        "--signature",
        o.floor_signature as string,
        "--record-sha256",
        o.floor_record_sha256 as string,
      ]).code,
    ).toBe(1);
    expect(readdirSync(bad.out)).toEqual([]);
  });
  it.each<[string, Record<string, string>]>([
    ["seq 0", { "--seq": "0" }],
    ["a non-integer seq", { "--seq": "1.5" }],
    ["a huge seq", { "--seq": "99999999999999999" }],
    ["a non-semver minVersion", { "--min-version": "v1" }],
    ["a non-semver revoked entry", { "--revoked": "0.31.0,latest" }],
    ["a duplicate revoked entry", { "--revoked": "0.31.0,0.31.0" }],
    ["a revoked list with spaces", { "--revoked": "0.31.0, 0.32.0" }],
    ["an unknown env", { "--env": "dev" }],
  ])("refuses %s", (_n, o) => {
    const { out, argv } = args("staging", o);
    const r = run(SIGN_FLOOR, argv, pem("staging"));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(readdirSync(out)).toEqual([]);
  });
  it("refuses a key in argv and an empty stdin", () => {
    const { argv } = args("staging");
    expect(run(SIGN_FLOOR, [...argv, "--key", "x"], pem("staging")).code).toBe(
      1,
    );
    expect(run(SIGN_FLOOR, argv, "").code).toBe(1);
  });
});

// The in-memory release the create tests provision from: a signed record and
// floor, a tiny bundle, assets and the welcome text. Shared by the node suite
// (packages/provision/test) and the workerd suite (apps/provisioner/test), so
// nothing here reads the filesystem: the template and server migrations come
// in through releaseFixtures().
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import type { Template } from "../../src/metadata.js";
import type { Env } from "../../src/names.js";
import { canonicalJson } from "../../src/platform.js";
import {
  assetEntries,
  bundleSha256,
  migrationsSha256,
  type ReleaseAsset,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  type SignedReleaseRecord,
  TEST_HOOKS_DEFINE,
} from "../../src/release.js";

export const enc = (s: string) => new TextEncoder().encode(s);

export function makeBundle(
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

export const ASSETS: ReleaseAsset[] = [
  { path: "index.html", bytes: enc("<!doctype html><p>hi</p>") },
  { path: "app.js", bytes: enc("console.log(1)") },
];

/**
 * A reader's assets and assetBytes over these files: the list in their own
 * order (path, size, sha256, unchecked, so a test can serve a bad path) and a
 * fresh copy of one file's bytes per read.
 */
export function assetsOf(
  files: readonly ReleaseAsset[],
): Pick<ReleaseReader, "assets" | "assetBytes"> {
  return {
    assets: async () =>
      files.map((f) => ({
        path: f.path,
        size: f.bytes.byteLength,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
      })),
    assetBytes: async (_version, _variant, path) => {
      const f = files.find((x) => x.path === path);
      if (!f) throw new Error(`no asset ${path}`);
      return f.bytes.slice();
    },
  };
}

/** Release content; a Template object is serialized to the template bytes. */
export type ReleaseSpec = {
  env?: Env;
  welcome?: Uint8Array;
  template?: Template | Uint8Array;
  migrations?: ReleaseFile[];
  assets?: ReleaseAsset[];
  floor?: unknown;
};

// The release signing keypair of these tests (T3b holds the real one).
export const SIGNER = generateKeyPairSync("ed25519");
export const OTHER_SIGNER = generateKeyPairSync("ed25519");
export const pubX = (k: { publicKey: KeyObject }) =>
  k.publicKey.export({ format: "jwk" }).x as string;
export const TEST_PUBKEY = pubX(SIGNER);

/** The signed bytes: "oa-release-v1\n" + env + "\n" + the stored record string. */
export const payloadOf = (record: string, env: string) =>
  Buffer.from(`oa-release-v1\n${env}\n${record}`);
/** The stored form (T3b): the record as its canonical JSON string, and the signature over it. */
export const signRecord = (
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
export const tamper = (
  g: SignedReleaseRecord,
  over: Record<string, unknown>,
) => ({
  ...g,
  record: canonicalJson({ ...JSON.parse(g.record), ...over }),
});

/** The env's signed floor (releases/floor.json). */
export type Floor = {
  env: string;
  seq: number;
  minVersion: string;
  revoked: string[];
};
export const floorOf = (
  o: Partial<Floor> = {},
  env: string = "staging",
): Floor => ({
  env,
  seq: 1,
  minVersion: "0.1.0",
  revoked: [],
  ...o,
});
export const signFloor = (
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

export const WELCOME_BYTES = enc(
  "# Welcome to Open Artifacts\n\nThis text comes from the release (sentinel-from-release).\n",
);

export type Kind =
  | "record"
  | "modules"
  | "assets"
  | "assetBytes"
  | "template"
  | "migrations"
  | "welcome"
  | "floor";

/**
 * The fixtures that carry the server's own files: the template and the
 * migrations, read by the caller (node:fs in node, bindings in workerd).
 */
export function releaseFixtures(src: {
  template: Uint8Array;
  migrations: ReleaseFile[];
}) {
  const TEMPLATE_BYTES = src.template;
  const MIGRATION_FILES = src.migrations;
  const tplBytes = (t: ReleaseSpec["template"]) =>
    t === undefined
      ? TEMPLATE_BYTES
      : t instanceof Uint8Array
        ? t
        : enc(JSON.stringify(t, null, 2));

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

  /** An in-memory release reader that counts reads; `over` replaces any read. */
  function makeRelease(
    spec: ReleaseSpec = {},
    over: Partial<ReleaseReader> = {},
  ): ReleaseReader & { calls: Record<Kind, number> } {
    const calls: Record<Kind, number> = {
      record: 0,
      modules: 0,
      assets: 0,
      assetBytes: 0,
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
      ...assetsOf(spec.assets ?? ASSETS),
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
      assetBytes: counted("assetBytes"),
      template: counted("template"),
      migrations: counted("migrations"),
      welcome: counted("welcome"),
      floor: counted("floor"),
    };
  }

  return { TEMPLATE_BYTES, MIGRATION_FILES, tplBytes, recordOf, makeRelease };
}

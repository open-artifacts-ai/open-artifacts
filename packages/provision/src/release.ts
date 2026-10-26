// The signed release record (H-T4b): what a release uploads or applies, and
// how create proves it came from the release workflow. The provisioning token
// can write oa-<p>-releases, so the record is trusted only through its
// Ed25519 signature, made by the release workflow's key (T3b) and checked
// against RELEASE_PUBKEY[env] in src/internal/gates.ts (not exported).
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Module } from "./cf.js";
import type { Env } from "./names.js";
import { canonicalJson } from "./platform.js";
import { ustarFits } from "./tar.js";

import { compareVersions, isReleaseVersion } from "./versions.js";

export { compareVersions, isReleaseVersion };

/**
 * Compile-time define, confirmed by Backend: a BOOLEAN literal, `true` only in
 * the redline bundle and `false` in the release bundle.
 */
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__" as const;

export type BundleVariant = "release" | "redline";

export interface ReleaseAssetEntry {
  /** Relative, "/"-separated, no dot segment. */
  path: string;
  size: number;
  /** Full SHA-256 hex of the bytes. */
  sha256: string;
}

/**
 * The per-release manifest entry for one bundle variant, written and signed
 * by the release workflow (scripts/ci/sign-release.ts) after building both
 * variants and running check-no-test-hooks, and copied to R2 by
 * publishRelease (T3b).
 */
export interface ReleaseRecord {
  /** The env this record was signed for; also inside the signed prefix. */
  env: Env;
  version: string;
  variant: BundleVariant;
  /** bundleSha256() of the modules. */
  sha256: string;
  /**
   * A JSON boolean, on purpose. Wrangler's `define` config holds the string
   * "true"/"false" (a JS expression the bundler substitutes, so the code sees
   * a real boolean and dead-code elimination works). This record is our own
   * schema: T3b converts the config string to a boolean when it writes it.
   * Do not change this to a string; create refuses one.
   */
  defines: { [TEST_HOOKS_DEFINE]: boolean };
  /** Every asset uploaded, sorted by path. */
  assets: ReleaseAssetEntry[];
  /** SHA-256 of the exact bytes of the server template file. */
  templateSha256: string;
  /** migrationsSha256() of every D1 migration file applied. */
  migrationsSha256: string;
  /** SHA-256 of the exact bytes of the Welcome artifact text (welcome.md). */
  welcomeSha256: string;
}

/**
 * The stored form (.sig.json, R2 record.sig.json): the record as the exact
 * string canonicalJson(record), and a base64url Ed25519 signature over
 * releaseRecordPayload(env, record). Verified over that exact string, then
 * parsed; the parse must re-serialize to the same string.
 */
export interface SignedReleaseRecord {
  record: string;
  signature: string;
}

export interface ReleaseAsset {
  path: string;
  bytes: Uint8Array;
}

export interface ReleaseFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Reads one release's files (R2 oa-<p>-releases in production, T3b). Never
 * the local checkout. create calls each read again right before it uses the
 * result and checks it against the signed record every time.
 */
export interface ReleaseReader {
  record(
    version: string,
    variant: BundleVariant,
  ): Promise<SignedReleaseRecord | null>;
  modules(
    version: string,
    variant: BundleVariant,
  ): Promise<{ mainModule: string; modules: Module[] }>;
  assets(version: string, variant: BundleVariant): Promise<ReleaseAsset[]>;
  /** The exact bytes of the server template (wrangler.template.jsonc). */
  template(version: string, variant: BundleVariant): Promise<Uint8Array>;
  /** Every D1 migration file of the server. */
  migrations(version: string, variant: BundleVariant): Promise<ReleaseFile[]>;
  /** The exact bytes of the Welcome artifact text (scripts/setup/welcome.md). */
  welcome(version: string, variant: BundleVariant): Promise<Uint8Array>;
  /** The env's signed floor (releases/floor.json, stored form), or null. */
  floor(): Promise<unknown>;
}

/** Cloudflare's per-script asset limits, and a total cap of our own. */
export const ASSET_LIMITS = {
  files: 20_000,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
} as const;

export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

/** SHA-256 over the main module and every module's name, type and bytes. */
export function bundleSha256(b: {
  mainModule: string;
  modules: readonly Module[];
}): string {
  return sha256Hex(
    canonicalJson({
      mainModule: b.mainModule,
      modules: [...b.modules]
        .sort((x, y) => (x.name < y.name ? -1 : 1))
        .map((m) => ({
          name: m.name,
          type: m.type,
          sha256: sha256Hex(m.bytes),
        })),
    }),
  );
}

/**
 * Refuses an asset path that is not plain relative segments of
 * [A-Za-z0-9._~@+-]: so no empty, absolute, backslash, "%", space or
 * non-ASCII segment, and no segment starting with "." (dotfiles,
 * dot-directories, "." and "..").
 */
export function assertAssetPath(path: unknown): asserts path is string {
  const ok =
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    path
      .split("/")
      .every((s) => /^[A-Za-z0-9._~@+-]+$/.test(s) && !s.startsWith("."));
  if (!ok)
    throw new Error(
      `asset path ${JSON.stringify(String(path)).slice(0, 80)} is not allowed (no dotfile, dot-directory, empty, absolute or backslash segment)`,
    );
}

/** The record's assets list for these files: checked paths, unique, sorted by path. */
export function assetEntries(
  files: readonly ReleaseAsset[],
): ReleaseAssetEntry[] {
  const out = files.map((f) => {
    assertAssetPath(f?.path);
    if (!(f.bytes instanceof Uint8Array))
      throw new Error(`asset ${f.path} has no bytes`);
    return {
      path: f.path,
      size: f.bytes.byteLength,
      sha256: sha256Hex(f.bytes),
    };
  });
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < out.length; i++)
    if (out[i]?.path === out[i - 1]?.path)
      throw new Error(`asset path ${out[i]?.path} appears twice`);
  return out;
}

export const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

/** sha256 over the sorted lines `name + "\0" + sha256(bytes)`, joined by "\n". */
export function migrationsSha256(files: readonly ReleaseFile[]): string {
  const lines = files.map((f) => {
    if (typeof f?.name !== "string" || !MIGRATION_RE.test(f.name))
      throw new Error(
        `unexpected migration file name ${JSON.stringify(String(f?.name)).slice(0, 80)}`,
      );
    if (!(f.bytes instanceof Uint8Array))
      throw new Error(`migration ${f.name} has no bytes`);
    return `${f.name}\0${sha256Hex(f.bytes)}`;
  });
  lines.sort();
  if (new Set(lines.map((l) => l.split("\0")[0])).size !== lines.length)
    throw new Error("a migration file name appears twice");
  return sha256Hex(lines.join("\n"));
}

/** Throws unless the assets list is within ASSET_LIMITS (count, each file, total). */
export function assertAssetLimits(
  entries: readonly { path: string; size: number }[],
): void {
  if (entries.length > ASSET_LIMITS.files)
    throw new Error(`more than ${ASSET_LIMITS.files} assets`);
  let total = 0;
  for (const a of entries) {
    if (a.size > ASSET_LIMITS.fileBytes)
      throw new Error(`asset ${a.path} is over 25 MiB`);
    total += a.size;
  }
  if (total > ASSET_LIMITS.totalBytes)
    throw new Error("assets are over 512 MiB in total");
}

/**
 * The record for one variant of one release, as the release workflow signs
 * it (scripts/ci/release-artifact.ts builds the same bytes). Refuses redline
 * for prod, a non-semver version, an asset path assertAssetPath refuses or
 * that does not fit a plain ustar header, and anything over ASSET_LIMITS.
 */
export function buildReleaseRecord(i: {
  env: Env;
  version: string;
  variant: BundleVariant;
  mainModule: string;
  modules: readonly Module[];
  assets: readonly ReleaseAsset[];
  template: Uint8Array;
  migrations: readonly ReleaseFile[];
  welcome: Uint8Array;
}): ReleaseRecord {
  if (i.env !== "staging" && i.env !== "prod")
    throw new Error(
      `env ${JSON.stringify(String(i.env))} is not staging or prod`,
    );
  if (i.variant !== "release" && i.variant !== "redline")
    throw new Error("variant must be release or redline");
  if (i.env === "prod" && i.variant === "redline")
    throw new Error("the redline bundle is never signed for prod");
  if (!isReleaseVersion(i.version))
    throw new Error(
      `version ${JSON.stringify(String(i.version)).slice(0, 40)} is not a release version`,
    );
  const assets = assetEntries(i.assets);
  assertAssetLimits(assets);
  for (const a of assets)
    if (!ustarFits(`assets/${a.path}`))
      throw new Error(`asset path ${a.path} does not fit a plain ustar header`);
  for (const m of i.modules) {
    assertAssetPath(m.name);
    if (!ustarFits(`modules/${m.name}`))
      throw new Error(`module ${m.name} does not fit a plain ustar header`);
  }
  return {
    env: i.env,
    version: i.version,
    variant: i.variant,
    sha256: bundleSha256(i),
    defines: { [TEST_HOOKS_DEFINE]: i.variant === "redline" },
    assets,
    templateSha256: sha256Hex(i.template),
    migrationsSha256: migrationsSha256(i.migrations),
    welcomeSha256: sha256Hex(i.welcome),
  };
}

/**
 * JSON.parse, but refuses a duplicate key at any depth and builds every
 * object with Object.create(null), so "__proto__" is just a key.
 */
export function parseStrictJson(text: string): unknown {
  let i = 0;
  const fail = (why = "invalid JSON"): never => {
    throw new Error(`${why} at offset ${i}`);
  };
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i] as string)) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail();
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) fail();
    // JSON.parse of the one literal checks escapes and control characters.
    const v = JSON.parse(text.slice(i, j + 1)) as string;
    i = j + 1;
    return v;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail("JSON nested too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const o = Object.create(null) as Record<string, unknown>;
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = str();
        if (Object.hasOwn(o, k))
          fail(`duplicate key ${JSON.stringify(k).slice(0, 40)}`);
        ws();
        if (text[i] !== ":") fail();
        i++;
        Object.defineProperty(o, k, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return o;
        }
        fail();
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return a;
        }
        fail();
      }
    }
    if (c === '"') return str();
    const m =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        text.slice(i, i + 64),
      );
    if (!m) return fail();
    i += m[0].length;
    if (/^[0-9A-Za-z.]/.test(text[i] ?? "")) fail();
    return JSON.parse(m[0]);
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail("trailing data after JSON");
  return v;
}

/** Domain separation: the signature is only valid for this purpose and env. */
export const RELEASE_RECORD_DOMAIN = "oa-release-v1";
/** The floor's own domain, so no release record verifies as a floor. */
export const FLOOR_DOMAIN = "oa-release-floor-v1";

/** The bytes the release workflow signs: "oa-release-v1\n" + env + "\n" + the record string. */
export const releaseRecordPayload = (env: Env, record: string): Buffer =>
  Buffer.from(`${RELEASE_RECORD_DOMAIN}\n${env}\n${record}`);

const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

function exactKeys(o: object, keys: readonly string[], what: string): void {
  const got = Object.keys(o).sort();
  const want = [...keys].sort();
  if (got.join("\0") !== want.join("\0"))
    throw new Error(
      `${what} has keys ${JSON.stringify(got).slice(0, 200)}; expected ${JSON.stringify(want)} (unexpected key or missing key)`,
    );
}

/**
 * Verifies `{ record: string, signature }` over domain + env + the exact
 * stored string, then parses it strictly; the parse must re-serialize to the
 * same string. Returns the parsed object (null prototype at every depth).
 */
function openSigned(
  stored: unknown,
  pubkey: string,
  domain: string,
  env: Env,
): Record<string, unknown> {
  const bad = () =>
    new Error(
      `the signature is missing or does not verify against the ${env} release key`,
    );
  const s = stored as { record?: unknown; signature?: unknown } | null;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw bad();
  if (Object.keys(s).sort().join(",") !== "record,signature") throw bad();
  const { record, signature } = s;
  if (
    typeof record !== "string" ||
    typeof signature !== "string" ||
    !SIG_RE.test(signature) ||
    typeof pubkey !== "string" ||
    !PUBKEY_RE.test(pubkey)
  )
    throw bad();
  let ok = false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pubkey },
      format: "jwk",
    });
    ok = verify(
      null,
      Buffer.from(`${domain}\n${env}\n${record}`),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw bad();
  const parsed = parseStrictJson(record);
  if (canonicalJson(parsed) !== record)
    throw new Error("the signed record string is not canonical JSON");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("the signed record is not an object");
  return parsed as Record<string, unknown>;
}

const RECORD_KEYS = [
  "assets",
  "defines",
  "env",
  "migrationsSha256",
  "sha256",
  "templateSha256",
  "variant",
  "version",
  "welcomeSha256",
] as const;

/**
 * The record of a stored signed release record, after the signature, the
 * strict parse and the exact shape check (no unknown key at any level,
 * `defines` a JSON boolean). Throws with the reason otherwise.
 */
export function openReleaseRecord(
  stored: unknown,
  pubkey: string,
  env: Env,
): ReleaseRecord {
  const r = openSigned(stored, pubkey, RELEASE_RECORD_DOMAIN, env);
  exactKeys(r, RECORD_KEYS, "the release record");
  const d = r.defines as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d))
    throw new Error("the release record has no defines object");
  exactKeys(d, [TEST_HOOKS_DEFINE], "defines");
  if (typeof d[TEST_HOOKS_DEFINE] !== "boolean")
    throw new Error(`${TEST_HOOKS_DEFINE} must be a boolean literal`);
  // N6: the record's own invariants, here, so no caller can forget them.
  if (r.env !== env)
    throw new Error(
      `the release record is for env ${String(r.env)}, not ${env}`,
    );
  if (r.variant !== "release" && r.variant !== "redline")
    throw new Error("the release record has no valid variant");
  if (d[TEST_HOOKS_DEFINE] !== (r.variant === "redline"))
    throw new Error(
      `${TEST_HOOKS_DEFINE} must be ${r.variant === "redline"} for the ${r.variant} variant`,
    );
  if (!isReleaseVersion(r.version))
    throw new Error("the release record has no valid version");
  for (const k of [
    "sha256",
    "templateSha256",
    "migrationsSha256",
    "welcomeSha256",
  ] as const)
    if (typeof r[k] !== "string" || !/^[0-9a-f]{64}$/.test(r[k] as string))
      throw new Error(`the release record has no valid ${k}`);
  if (!Array.isArray(r.assets))
    throw new Error("the release record has no assets list");
  for (const a of r.assets) {
    if (!a || typeof a !== "object" || Array.isArray(a))
      throw new Error("an assets entry is not an object");
    exactKeys(a, ["path", "sha256", "size"], "an assets entry");
    assertAssetPath(a.path);
    if (!Number.isSafeInteger(a.size) || a.size < 0)
      throw new Error(`asset ${a.path} has no valid size`);
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256))
      throw new Error(`asset ${a.path} has no valid sha256`);
  }
  return r as unknown as ReleaseRecord;
}

/** The verified record, or null when anything about it is wrong. */
export function verifyReleaseSignature(
  stored: unknown,
  pubkey: string,
  env: Env,
): ReleaseRecord | null {
  try {
    return openReleaseRecord(stored, pubkey, env);
  } catch {
    return null;
  }
}

/**
 * releases/floor.json in oa-<p>-releases: the oldest version create may
 * install and the versions it must refuse. `seq` only goes up; its anchor is
 * FLOOR_MIN_SEQ[env] in src/internal/gates.ts.
 */
export interface FloorRecord {
  env: Env;
  seq: number;
  minVersion: string;
  revoked: string[];
}

/** The floor of a stored signed floor, signed under FLOOR_DOMAIN for `env`. */
export function openFloor(
  stored: unknown,
  pubkey: string,
  env: Env,
): FloorRecord {
  const f = openSigned(stored, pubkey, FLOOR_DOMAIN, env);
  exactKeys(f, ["env", "minVersion", "revoked", "seq"], "the release floor");
  if (f.env !== env)
    throw new Error(`the release floor is for env ${String(f.env)}`);
  if (!Number.isSafeInteger(f.seq) || (f.seq as number) < 1)
    throw new Error("the release floor has no valid seq");
  if (!isReleaseVersion(f.minVersion))
    throw new Error("the release floor has no valid minVersion");
  const rv = f.revoked;
  if (
    !Array.isArray(rv) ||
    !rv.every(isReleaseVersion) ||
    new Set(rv).size !== rv.length
  )
    throw new Error("the release floor has no valid revoked list");
  return f as unknown as FloorRecord;
}

/** Why `version` may not be installed under this floor, or null. */
export function floorRefusal(
  f: FloorRecord,
  version: string,
  minSeq: number,
): string | null {
  if (f.seq < minSeq)
    return `the release floor seq ${f.seq} is below ${minSeq}`;
  if (compareVersions(version, f.minVersion) < 0)
    return `version ${version} is below the release floor ${f.minVersion}`;
  if (f.revoked.includes(version))
    return `version ${version} is revoked by the release floor`;
  return null;
}

const fileStamp = (st: Stats) => `f:${st.dev}:${st.ino}:${st.size}:${st.nlink}`;
const dirStamp = (st: Stats) => `d:${st.dev}:${st.ino}`;

/**
 * The one reader for every file of a build output (bundle outdir, assets,
 * template, migrations, welcome): regular files only, inside `dir`.
 * - realpath the root; refuse any entry whose realpath leaves it;
 * - open every file O_RDONLY|O_NOFOLLOW (and O_NONBLOCK, so a FIFO swapped
 *   in cannot hang) and take size, ino, dev and nlink from fstat on the
 *   handle; refuse anything not a regular file, and nlink > 1 (hardlink);
 * - record every directory (ino, dev) from a directory handle;
 * - walk again after reading and require the same files and directories
 *   with the same ino, dev and size.
 * `check` refuses a relative path (default assertAssetPath); `pick` keeps
 * only the entries it names (others are skipped, never opened, in both
 * walks: one file of a source directory); `afterRead` runs between the two
 * walks (tests).
 */
export async function readTreeHardened(
  dir: string,
  o: {
    check?: (rel: string) => void;
    pick?: (rel: string) => boolean;
    afterRead?: () => Promise<void>;
  } = {},
): Promise<ReleaseAsset[]> {
  const check = o.check ?? assertAssetPath;
  const root = await realpath(dir);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const inside = async (p: string, rel: string) => {
    const r = await realpath(p);
    if (r !== root && !r.startsWith(root + sep))
      throw new Error(`${rel} resolves outside ${dir} (symlink)`);
  };
  const openNoFollow = async (p: string, rel: string, extra: number) => {
    try {
      return await open(p, flags | extra);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ELOOP" || code === "EMLINK")
        throw new Error(`${rel} is a symlink; refusing to follow it`);
      if (code === "ENOTDIR") throw new Error(`${rel} is not a directory`);
      throw err;
    }
  };
  const walk = async (read: boolean) => {
    const seen = new Map<string, string>();
    const out: ReleaseAsset[] = [];
    const visit = async (rel: string): Promise<void> => {
      const p = rel ? join(root, rel) : root;
      const dh = await openNoFollow(p, rel || ".", constants.O_DIRECTORY);
      let entries: Dirent[];
      try {
        const st = await dh.stat();
        if (!st.isDirectory()) throw new Error(`${rel} is not a directory`);
        await inside(p, rel || ".");
        entries = await readdir(p, { withFileTypes: true });
        // The directory listed is still the one held open.
        if (dirStamp(await lstat(p)) !== dirStamp(st))
          throw new Error(`${dir}: the tree changed while it was read`);
        seen.set(`${rel}/`, dirStamp(st));
      } finally {
        await dh.close();
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (o.pick && !o.pick(r)) continue;
        check(r);
        if (e.isSymbolicLink())
          throw new Error(`${r} is a symlink; refusing to follow it`);
        if (e.isDirectory()) {
          await visit(r);
          continue;
        }
        if (!e.isFile()) throw new Error(`${r} is not a regular file`);
        // N4: opened by full path, so an intermediate directory swapped
        // after its listing is not seen here; the second walk's directory
        // and file stamps (dev, ino, size) are what catch it. Keep both walks.
        const q = join(root, r);
        const fh = await openNoFollow(q, r, constants.O_NONBLOCK);
        try {
          const st = await fh.stat();
          if (!st.isFile()) throw new Error(`${r} is not a regular file`);
          if (st.nlink > 1)
            throw new Error(
              `${r} has ${st.nlink} links (hardlink); refusing it`,
            );
          await inside(q, r);
          seen.set(r, fileStamp(st));
          if (read) {
            const bytes = new Uint8Array(await fh.readFile());
            if (bytes.byteLength !== st.size)
              throw new Error(`${dir}: the tree changed while it was read`);
            out.push({ path: r, bytes });
          }
        } finally {
          await fh.close();
        }
      }
    };
    await visit("");
    return { seen, out };
  };
  const first = await walk(true);
  await o.afterRead?.();
  const second = await walk(false);
  const same =
    first.seen.size === second.seen.size &&
    [...first.seen].every(([k, v]) => second.seen.get(k) === v);
  if (!same) throw new Error(`${dir}: the tree changed while it was read`);
  return first.out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

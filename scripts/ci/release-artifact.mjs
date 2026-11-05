// @ts-check
// The hosted release artifact (T3b): what hosted-build writes, hosted-check
// verifies and hosted-sign signs. Plain .mjs on purpose (JSDoc types, checked
// by tsc via checkJs): the signing jobs install nothing and run Node 22 from
// .nvmrc, so no strip-types. node:* imports only: this file is its own
// copy of the hardened reader, canonicalJson and the record builder of
// @oa/provision (a test pins identical bytes). Never import a package here.
//
// Artifact layout (paths in manifest.json):
//   release/<module>  redline/<module>  assets/<path>
//   template/wrangler.template.jsonc  migrations/<name>  welcome/welcome.md
//   config/release.json  config/redline.json
// Tar layout (one per env and variant): modules/<module> plus the rest as is.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

/** @typedef {"staging" | "prod"} Env */
/** @typedef {"release" | "redline"} Variant */
/** @typedef {{ path: string; bytes: Uint8Array }} File */
/** @typedef {{ name: string; type: "esm" | "wasm"; bytes: Uint8Array }} Mod */
/** @typedef {{ name: string; bytes: Uint8Array }} Migration */

export const MANIFEST = "manifest.json";
export const TEMPLATE_FILE = "template/wrangler.template.jsonc";
export const WELCOME_FILE = "welcome/welcome.md";
/** M1: the rendered dry-run configs, covered by manifest.json. */
export const CONFIG_FILE = Object.freeze({
  release: "config/release.json",
  redline: "config/redline.json",
});
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__";
export const ASSET_LIMITS = Object.freeze({
  files: 20_000,
  fileBytes: 25 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
});
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const MIGRATION_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** @param {Uint8Array | string} b */
export const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");

/**
 * JSON with object keys sorted at every level (as @oa/provision).
 * @param {unknown} v
 * @returns {string}
 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * @param {{ mainModule: string; modules: readonly Mod[] }} b
 * @returns {string}
 */
export function bundleSha256(b) {
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
 * @param {unknown} path
 * @returns {asserts path is string}
 */
export function assertAssetPath(path) {
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

/**
 * @param {readonly File[]} files
 * @returns {{ path: string; size: number; sha256: string }[]}
 */
export function assetEntries(files) {
  const out = files.map((f) => {
    assertAssetPath(f?.path);
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

/**
 * @param {readonly Migration[]} files
 * @returns {string}
 */
export function migrationsSha256(files) {
  const lines = files.map((f) => {
    if (!MIGRATION_RE.test(f.name))
      throw new Error(
        `unexpected migration file name ${JSON.stringify(f.name).slice(0, 80)}`,
      );
    return `${f.name}\0${sha256Hex(f.bytes)}`;
  });
  lines.sort();
  if (new Set(lines.map((l) => l.split("\0")[0])).size !== lines.length)
    throw new Error("a migration file name appears twice");
  return sha256Hex(lines.join("\n"));
}

const utf8 = new TextEncoder();

/**
 * Where a ustar path splits into prefix and name, or -1 (no split needed),
 * or null (does not fit): name <= 100 bytes, prefix <= 155, split at "/".
 * @param {Uint8Array} b
 * @returns {number | null}
 */
function ustarCut(b) {
  if (b.length <= 100) return -1;
  for (let i = b.length - 1; i > 0; i--)
    if (
      b[i] === 0x2f &&
      i <= 155 &&
      b.length - i - 1 <= 100 &&
      b.length - i - 1 > 0
    )
      return i;
  return null;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
export function ustarFits(path) {
  return ustarCut(utf8.encode(path)) !== null;
}

/**
 * The signed record of one variant: the same bytes as @oa/provision
 * buildReleaseRecord.
 * @param {{
 *   env: Env;
 *   version: string;
 *   variant: Variant;
 *   mainModule: string;
 *   modules: readonly Mod[];
 *   assets: readonly File[];
 *   template: Uint8Array;
 *   migrations: readonly Migration[];
 *   welcome: Uint8Array;
 *   testHooks?: boolean;
 * }} i `testHooks` (M1): the define value read from the variant's rendered
 *   config (testHooksOf); it must agree with the variant. Default: the variant.
 */
export function buildRecord(i) {
  if (i.env !== "staging" && i.env !== "prod")
    throw new Error(
      `env ${JSON.stringify(String(i.env))} is not staging or prod`,
    );
  if (i.variant !== "release" && i.variant !== "redline")
    throw new Error("variant must be release or redline");
  if (i.env === "prod" && i.variant === "redline")
    throw new Error("the redline bundle is never signed for prod");
  if (typeof i.version !== "string" || !SEMVER.test(i.version))
    throw new Error(
      `version ${JSON.stringify(String(i.version)).slice(0, 40)} is not a release version`,
    );
  const assets = assetEntries(i.assets);
  if (assets.length > ASSET_LIMITS.files)
    throw new Error(`more than ${ASSET_LIMITS.files} assets`);
  let total = 0;
  for (const a of assets) {
    if (a.size > ASSET_LIMITS.fileBytes)
      throw new Error(`asset ${a.path} is over 25 MiB`);
    total += a.size;
    if (!ustarFits(`assets/${a.path}`))
      throw new Error(`asset path ${a.path} does not fit a plain ustar header`);
  }
  if (total > ASSET_LIMITS.totalBytes)
    throw new Error("assets are over 512 MiB in total");
  for (const m of i.modules) {
    assertAssetPath(m.name);
    if (!ustarFits(`modules/${m.name}`))
      throw new Error(`module ${m.name} does not fit a plain ustar header`);
  }
  const hooks = i.testHooks ?? i.variant === "redline";
  if (hooks !== (i.variant === "redline"))
    throw new Error(
      `the ${i.variant} config defines ${TEST_HOOKS_DEFINE} ${hooks}; it must be ${i.variant === "redline"}`,
    );
  return {
    env: i.env,
    version: i.version,
    variant: i.variant,
    sha256: bundleSha256(i),
    defines: { [TEST_HOOKS_DEFINE]: hooks },
    assets,
    templateSha256: sha256Hex(i.template),
    migrationsSha256: migrationsSha256(i.migrations),
    welcomeSha256: sha256Hex(i.welcome),
  };
}

/**
 * The signed bytes: "oa-release-v1\n" + env + "\n" + the record string.
 * @param {Env} env
 * @param {string} record
 */
export const recordPayload = (env, record) =>
  Buffer.from(`oa-release-v1\n${env}\n${record}`);

// ---------- the two variants ----------

/** @param {"true" | "false"} v */
const defineEntry = (v) =>
  `${JSON.stringify(TEST_HOOKS_DEFINE)}:${JSON.stringify(v)}`;

/**
 * hosted-build: the two rendered dry-run configs (buildBundle `config`) must
 * be byte-identical once the one define value is normalized: release has
 * the define "false" and redline "true", each exactly once, and nothing else
 * differs. (The bundles themselves differ: esbuild tree-shakes the hooks out
 * of release.)
 * @param {string} release
 * @param {string} redline
 */
export function assertSameConfigButDefine(release, redline) {
  /** @param {string} s @param {string} x */
  const count = (s, x) => s.split(x).length - 1;
  const r = defineEntry("false");
  const d = defineEntry("true");
  if (count(release, r) !== 1 || count(release, d) !== 0)
    throw new Error(
      `the release config must define ${TEST_HOOKS_DEFINE} "false" once`,
    );
  if (count(redline, d) !== 1 || count(redline, r) !== 0)
    throw new Error(
      `the redline config must define ${TEST_HOOKS_DEFINE} "true" once`,
    );
  if (release.replace(r, d) !== redline)
    throw new Error(
      `the release and redline configs differ beyond the ${TEST_HOOKS_DEFINE} define`,
    );
}

/**
 * No /__test/ string may appear in the release bundle: the real build
 * tree-shakes the hook modules out. The one exception is the route-policy
 * table's doc key "ALL /__test/*" (apps/server/src/auth/route-policy.ts),
 * which is not a route; it is removed before the search.
 */
export const HOOK_PREFIX = "/__test/";
export const HOOK_DOC_KEY = '"ALL /__test/*"';

/**
 * Throws if any release module's bytes contain /__test/ beyond the doc key,
 * or if the doc key itself appears more than once across all modules (L2).
 * @param {readonly Mod[]} release
 */
export function assertNoHookRoutes(release) {
  let keys = 0;
  for (const m of release) {
    const parts = Buffer.from(m.bytes).toString("latin1").split(HOOK_DOC_KEY);
    keys += parts.length - 1;
    if (parts.join("").includes(HOOK_PREFIX))
      throw new Error(
        `release module ${m.name} contains a hook route (${HOOK_PREFIX})`,
      );
  }
  if (keys > 1)
    throw new Error(
      `the release bundle has ${keys} ${HOOK_DOC_KEY} entries; at most once is allowed`,
    );
}

/**
 * M1: the test-hooks define of a rendered config: "false" -> false, "true" -> true.
 * @param {string} config
 * @returns {boolean}
 */
export function testHooksOf(config) {
  /** @type {unknown} */
  let v;
  try {
    const c = /** @type {{ define?: Record<string, unknown> }} */ (
      JSON.parse(config)
    );
    v = c.define?.[TEST_HOOKS_DEFINE];
  } catch {
    throw new Error("a rendered config is not JSON");
  }
  if (v === "false") return false;
  if (v === "true") return true;
  throw new Error(
    `a rendered config has no "true"/"false" ${TEST_HOOKS_DEFINE} define`,
  );
}

// ---------- plain ustar, from in-memory bytes ----------

const BLOCK = 512;

/**
 * @param {string} path
 * @param {number} size
 * @returns {Uint8Array}
 */
function header(path, size) {
  const h = new Uint8Array(BLOCK);
  const b = utf8.encode(path);
  const cut = ustarCut(b);
  if (cut === null)
    throw new Error(`${path} does not fit a plain ustar header`);
  const name = cut < 0 ? b : b.subarray(cut + 1);
  const prefix = cut < 0 ? new Uint8Array() : b.subarray(0, cut);
  /** @param {number} off @param {string} s */
  const put = (off, s) => h.set(utf8.encode(s), off);
  h.set(name, 0);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  h.set(prefix, 345);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/**
 * A plain ustar of regular files, sorted by path; never a pax or GNU header.
 * @param {readonly File[]} files
 * @returns {Uint8Array}
 */
export function packUstar(files) {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  /** @type {Uint8Array[]} */
  const parts = [];
  for (const [k, f] of sorted.entries()) {
    assertAssetPath(f.path);
    if (k > 0 && sorted[k - 1]?.path === f.path)
      throw new Error(`${f.path} appears twice`);
    if (f.bytes.length > ASSET_LIMITS.fileBytes)
      throw new Error(`${f.path} is over 25 MiB`);
    parts.push(header(f.path, f.bytes.length));
    const data = new Uint8Array(Math.ceil(f.bytes.length / BLOCK) * BLOCK);
    data.set(f.bytes);
    parts.push(data);
  }
  parts.push(new Uint8Array(2 * BLOCK));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- the hardened reader (as @oa/provision readTreeHardened) ----------

/** @param {import("node:fs").Stats} st */
const fileStamp = (st) => `f:${st.dev}:${st.ino}:${st.size}:${st.nlink}`;
/** @param {import("node:fs").Stats} st */
const dirStamp = (st) => `d:${st.dev}:${st.ino}`;

/**
 * @param {string} dir
 * @param {{
 *   check?: (rel: string) => void;
 *   pick?: (rel: string) => boolean;
 *   afterRead?: () => Promise<void>;
 * }} [o] `afterRead` runs between the two walks (tests).
 * @returns {Promise<File[]>}
 */
export async function readTreeHardened(dir, o = {}) {
  const check = o.check ?? assertAssetPath;
  const root = await realpath(dir);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  /** @param {string} p @param {string} rel */
  const inside = async (p, rel) => {
    const r = await realpath(p);
    if (r !== root && !r.startsWith(root + sep))
      throw new Error(`${rel} resolves outside ${dir} (symlink)`);
  };
  /** @param {string} p @param {string} rel @param {number} extra */
  const openNoFollow = async (p, rel, extra) => {
    try {
      return await open(p, flags | extra);
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
      if (code === "ELOOP" || code === "EMLINK")
        throw new Error(`${rel} is a symlink; refusing to follow it`);
      if (code === "ENOTDIR") throw new Error(`${rel} is not a directory`);
      throw err;
    }
  };
  /** @param {boolean} read */
  const walk = async (read) => {
    /** @type {Map<string, string>} */
    const seen = new Map();
    /** @type {File[]} */
    const out = [];
    /** @param {string} rel @returns {Promise<void>} */
    const visit = async (rel) => {
      const p = rel ? join(root, rel) : root;
      const dh = await openNoFollow(p, rel || ".", constants.O_DIRECTORY);
      /** @type {import("node:fs").Dirent[]} */
      let entries;
      try {
        const st = await dh.stat();
        if (!st.isDirectory()) throw new Error(`${rel} is not a directory`);
        await inside(p, rel || ".");
        entries = await readdir(p, { withFileTypes: true });
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

// ---------- the artifact ----------

/**
 * What each variant was built from: hosted-guard's commit and the sha256 of
 * pnpm-lock.yaml at that build.
 * @typedef {{ bundleSha256: string; commit: string; lockfileSha256: string }} VariantInfo
 */

/**
 * @typedef {{
 *   version: string;
 *   mainModule: string;
 *   files: { path: string; size: number; sha256: string }[];
 *   variants: Record<Variant, VariantInfo>;
 * }} Manifest
 */

/**
 * @typedef {{
 *   manifest: Manifest;
 *   manifestSha256: string;
 *   release: Mod[];
 *   redline: Mod[];
 *   assets: File[];
 *   template: Uint8Array;
 *   migrations: Migration[];
 *   welcome: Uint8Array;
 *   configs: Record<Variant, string>;
 * }} Artifact `configs`: the rendered dry-run configs (buildBundle `config`).
 */

/**
 * @param {string} name
 * @returns {Mod["type"]}
 */
const modType = (name) => {
  if (name.endsWith(".wasm")) return "wasm";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "esm";
  throw new Error(`module ${name} is not .js, .mjs or .wasm`);
};

/**
 * hosted-build: writes the artifact and its manifest.json; returns the
 * manifest's sha256 and each variant's bundleSha256.
 * @param {string} out
 * @param {{
 *   version: string;
 *   mainModule: string;
 *   release: readonly Mod[];
 *   redline: readonly Mod[];
 *   assets: readonly File[];
 *   template: Uint8Array;
 *   migrations: readonly Migration[];
 *   welcome: Uint8Array;
 *   built: Record<Variant, { commit: string; lockfileSha256: string }>;
 *   configs: Record<Variant, string>;
 * }} a
 * @returns {Promise<{ manifestSha256: string; bundleSha256: Record<Variant, string> }>}
 */
export async function writeArtifact(out, a) {
  /** @type {File[]} */
  const files = [
    ...a.release.map((m) => ({ path: `release/${m.name}`, bytes: m.bytes })),
    ...a.redline.map((m) => ({ path: `redline/${m.name}`, bytes: m.bytes })),
    ...a.assets.map((f) => ({ path: `assets/${f.path}`, bytes: f.bytes })),
    { path: TEMPLATE_FILE, bytes: a.template },
    ...a.migrations.map((f) => ({
      path: `migrations/${f.name}`,
      bytes: f.bytes,
    })),
    { path: WELCOME_FILE, bytes: a.welcome },
    { path: CONFIG_FILE.release, bytes: utf8.encode(a.configs.release) },
    { path: CONFIG_FILE.redline, bytes: utf8.encode(a.configs.redline) },
  ];
  for (const f of files) {
    assertAssetPath(f.path);
    const p = join(out, f.path);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.bytes, { flag: "wx" });
  }
  const bundle = {
    release: bundleSha256({ mainModule: a.mainModule, modules: a.release }),
    redline: bundleSha256({ mainModule: a.mainModule, modules: a.redline }),
  };
  /** @type {Manifest} */
  const manifest = {
    version: a.version,
    mainModule: a.mainModule,
    files: assetEntries(files),
    variants: {
      release: { bundleSha256: bundle.release, ...a.built.release },
      redline: { bundleSha256: bundle.redline, ...a.built.redline },
    },
  };
  const bytes = utf8.encode(canonicalJson(manifest));
  await writeFile(join(out, MANIFEST), bytes, { flag: "wx" });
  return { manifestSha256: sha256Hex(bytes), bundleSha256: bundle };
}

/**
 * Reads the artifact with the hardened reader and re-hashes every file:
 * the set of files must be exactly manifest.json's, each with its size and
 * sha256, and each bundleSha256 must match its modules.
 * @param {string} dir
 * @returns {Promise<Artifact>}
 */
export async function readArtifact(dir) {
  const files = await readTreeHardened(dir);
  const mf = files.find((f) => f.path === MANIFEST);
  if (!mf) throw new Error(`no ${MANIFEST} in ${dir}`);
  const manifest = /** @type {Manifest} */ (
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(mf.bytes))
  );
  if (canonicalJson(manifest) !== new TextDecoder().decode(mf.bytes))
    throw new Error(`${MANIFEST} is not canonical JSON`);
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version))
    throw new Error(`${MANIFEST} has no valid version`);
  if (!Array.isArray(manifest.files))
    throw new Error(`${MANIFEST} has no files list`);
  const rest = files.filter((f) => f !== mf);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length || listed.size !== rest.length)
    throw new Error(
      `the artifact's files are not exactly ${MANIFEST}'s (an extra or missing file)`,
    );
  /** @type {Artifact} */
  const a = {
    manifest,
    manifestSha256: sha256Hex(mf.bytes),
    release: [],
    redline: [],
    assets: [],
    template: new Uint8Array(),
    migrations: [],
    welcome: new Uint8Array(),
    configs: { release: "", redline: "" },
  };
  let template = false;
  let welcome = false;
  for (const f of rest) {
    const m = listed.get(f.path);
    if (
      !m ||
      !HEX64.test(m.sha256) ||
      m.size !== f.bytes.length ||
      m.sha256 !== sha256Hex(f.bytes)
    )
      throw new Error(`${f.path} does not match ${MANIFEST}`);
    const [top, ...tail] = f.path.split("/");
    const name = tail.join("/");
    if (f.path === TEMPLATE_FILE) {
      a.template = f.bytes;
      template = true;
    } else if (f.path === WELCOME_FILE) {
      a.welcome = f.bytes;
      welcome = true;
    } else if (
      f.path === CONFIG_FILE.release ||
      f.path === CONFIG_FILE.redline
    ) {
      const v = f.path === CONFIG_FILE.release ? "release" : "redline";
      a.configs[v] = new TextDecoder("utf-8", { fatal: true }).decode(f.bytes);
    } else if ((top === "release" || top === "redline") && name)
      a[top].push({ name, type: modType(name), bytes: f.bytes });
    else if (top === "assets" && name)
      a.assets.push({ path: name, bytes: f.bytes });
    else if (top === "migrations" && MIGRATION_RE.test(name))
      a.migrations.push({ name, bytes: f.bytes });
    else throw new Error(`unexpected file ${f.path} in the artifact`);
  }
  if (!template || !welcome)
    throw new Error("the artifact has no template or welcome");
  if (!a.configs.release || !a.configs.redline)
    throw new Error("the artifact has no rendered configs");
  for (const v of /** @type {const} */ (["release", "redline"])) {
    const info = manifest.variants?.[v];
    if (
      !info ||
      bundleSha256({ mainModule: manifest.mainModule, modules: a[v] }) !==
        info.bundleSha256
    )
      throw new Error(
        `the ${v} modules do not match ${MANIFEST}'s bundleSha256`,
      );
    if (!/^[0-9a-f]{40}$/.test(info.commit) || !HEX64.test(info.lockfileSha256))
      throw new Error(
        `${MANIFEST} has no valid ${v} commit or lockfile sha256`,
      );
  }
  return a;
}

/**
 * @typedef {{
 *   env: Env;
 *   variant: Variant;
 *   version: string;
 *   recordString: string;
 *   recordSha256: string;
 *   tar: Uint8Array;
 *   tarSha256: string;
 *   base: string;
 * }} Prepared `base`: oa-release-<env>-<variant>-<version>.
 */

/**
 * hosted-sign (and hosted-attach): from the verified artifact, the record and
 * tar of every variant the env takes. Requires hosted-check's outputs (the
 * manifest's sha256 and the release bundleSha256 it checked); both variants
 * built from hosted-guard's commit with the same lockfile (the one checked
 * out here); no /__test/ route in release; the configs identical but for the
 * define, and defines taken from them (redline only for staging).
 * @param {Artifact} a
 * @param {{
 *   env: Env;
 *   version: string;
 *   manifestSha256: string;
 *   bundleSha256: string;
 *   commit: string;
 *   lockfileSha256: string;
 * }} o `commit`: hosted-guard's SHA; `lockfileSha256`: of the checked-out
 *   pnpm-lock.yaml.
 * @returns {Prepared[]}
 */
export function prepare(a, o) {
  if (o.env !== "staging" && o.env !== "prod")
    throw new Error("env must be staging or prod");
  if (!HEX64.test(o.manifestSha256) || o.manifestSha256 !== a.manifestSha256)
    throw new Error(`${MANIFEST} is not the one hosted-check verified`);
  const release = bundleSha256({
    mainModule: a.manifest.mainModule,
    modules: a.release,
  });
  if (!HEX64.test(o.bundleSha256) || o.bundleSha256 !== release)
    throw new Error("the release bundle is not the one hosted-check ran");
  if (o.version !== a.manifest.version)
    throw new Error(
      `version ${o.version} is not the artifact's ${a.manifest.version}`,
    );
  const { release: rv, redline: dv } = a.manifest.variants;
  if (rv.commit !== dv.commit)
    throw new Error(
      "the release and redline builds are from different commits",
    );
  if (rv.lockfileSha256 !== dv.lockfileSha256)
    throw new Error("the release and redline builds used different lockfiles");
  if (!/^[0-9a-f]{40}$/.test(o.commit) || rv.commit !== o.commit)
    throw new Error(
      `the builds are not from hosted-guard's commit ${o.commit.slice(0, 40)}`,
    );
  if (!HEX64.test(o.lockfileSha256) || rv.lockfileSha256 !== o.lockfileSha256)
    throw new Error(
      "the builds' lockfile is not the checked-out pnpm-lock.yaml",
    );
  assertNoHookRoutes(a.release);
  // M1: the configs the bundles were built from, re-checked here; defines
  // come from their define value, never from the directory label.
  assertSameConfigButDefine(a.configs.release, a.configs.redline);
  /** @type {Variant[]} */
  const variants = o.env === "prod" ? ["release"] : ["release", "redline"];
  return variants.map((variant) => {
    const modules = a[variant];
    const record = buildRecord({
      env: o.env,
      version: o.version,
      variant,
      mainModule: a.manifest.mainModule,
      modules,
      assets: a.assets,
      template: a.template,
      migrations: a.migrations,
      welcome: a.welcome,
      testHooks: testHooksOf(a.configs[variant]),
    });
    const recordString = canonicalJson(record);
    // Packed from the bytes just hashed into the record, never re-read.
    const tar = packUstar([
      ...modules.map((m) => ({ path: `modules/${m.name}`, bytes: m.bytes })),
      ...a.assets.map((f) => ({ path: `assets/${f.path}`, bytes: f.bytes })),
      { path: TEMPLATE_FILE, bytes: a.template },
      ...a.migrations.map((f) => ({
        path: `migrations/${f.name}`,
        bytes: f.bytes,
      })),
      { path: WELCOME_FILE, bytes: a.welcome },
    ]);
    return {
      env: o.env,
      variant,
      version: o.version,
      recordString,
      recordSha256: sha256Hex(recordString),
      tar,
      tarSha256: sha256Hex(tar),
      base: `oa-release-${o.env}-${variant}-${o.version}`,
    };
  });
}

/**
 * sha256 of one file (pnpm-lock.yaml), read with the hardened reader.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function fileSha256(path) {
  const name = basename(path);
  const [f] = await readTreeHardened(dirname(path), {
    pick: (r) => r === name,
  });
  if (!f) throw new Error(`${path} is missing`);
  return sha256Hex(f.bytes);
}

/**
 * The .sig.json bytes: the stored form { record, signature }.
 * @param {Prepared} p
 * @param {string} signature
 */
export const sigJson = (p, signature) =>
  utf8.encode(JSON.stringify({ record: p.recordString, signature }));

/**
 * Parses --flag value pairs; refuses any flag not in `known` and any repeat.
 * @param {readonly string[]} argv
 * @param {readonly string[]} known
 * @returns {Record<string, string>}
 */
export function parseArgs(argv, known) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = /** @type {string} */ (argv[i]);
    const v = argv[i + 1];
    if (
      !k.startsWith("--") ||
      !known.includes(k.slice(2)) ||
      v === undefined ||
      Object.hasOwn(out, k.slice(2))
    )
      throw new Error(`unexpected argument ${JSON.stringify(k).slice(0, 40)}`);
    out[k.slice(2)] = v;
  }
  return out;
}

/**
 * The PEM private key on stdin (never argv, a file or a log), size-capped.
 * @returns {Promise<string>}
 */
export async function readKeyFromStdin() {
  const pem = await readStdinText();
  if (pem.trim() === "") throw new Error("no signing key on stdin");
  return pem;
}

/**
 * Raw stdin (at most 64 KiB), possibly empty: never echoed.
 * @returns {Promise<string>}
 */
export async function readStdinText() {
  if (process.stdin.isTTY)
    throw new Error("the signing key must come on stdin");
  /** @type {Buffer[]} */
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    const b = /** @type {Buffer} */ (c);
    n += b.length;
    if (n > 64 * 1024) throw new Error("stdin is too large for a signing key");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs a CLI main: errors to stderr as "<name>: FAIL: <message>", exit 1.
 * @param {string} name
 * @param {() => Promise<void>} main
 */
export async function runMain(name, main) {
  await main().catch((/** @type {unknown} */ e) => {
    const msg = (e instanceof Error ? e.message : String(e))
      .replace(/\s+/g, " ")
      .slice(0, 300);
    process.stderr.write(`${name}: FAIL: ${msg}\n`);
    process.exit(1);
  });
}

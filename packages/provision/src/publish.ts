// The release files in R2 (oa-<p>-releases), T3b. CI signs and never
// uploads: publishRelease runs on the laptop, verifies the signed tar from the
// GitHub release against RELEASE_PUBKEY[env] and copies exactly the verified
// bytes, create-only. r2ReleaseReader is the ReleaseReader create uses; it
// never reads the local checkout.
//
// H-S3: every write, and every read whose etag or bytes decide a write, goes
// through R2's S3 API (r2s3.ts, the env's R2 API token): only that endpoint
// enforces conditional PutObject. Listings and r2ReleaseReader stay on the
// REST routes with the provisioning token: they never write, and create needs
// no R2 write credential.
//
// Layout, per version and variant:
//   releases/<version>/<variant>/record.sig.json      (written last)
//   releases/<version>/<variant>/modules/<name>
//   releases/<version>/<variant>/assets/<path>
//   releases/<version>/<variant>/template/wrangler.template.jsonc
//   releases/<version>/<variant>/migrations/<name>
//   releases/<version>/<variant>/welcome/welcome.md
//   releases/floor.json                               (the signed floor)
import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import { type Cf, CfError, type Module } from "./cf.js";
import {
  FLOOR_MIN_SEQ,
  RELEASE_PUBKEY,
  RELEASE_PUBKEY_PLACEHOLDER,
} from "./internal/gates.js";
import { parseTemplate } from "./metadata.js";
import {
  assertOwnResource,
  type Env,
  ForeignResource,
  platformNames,
} from "./names.js";
import { canonicalJson } from "./platform.js";
import type { R2Releases } from "./r2s3.js";
import {
  ASSET_LIMITS,
  assertAssetLimits,
  assertAssetPath,
  assetEntries,
  type BundleVariant,
  bundleSha256,
  compareVersions,
  type FloorRecord,
  floorRefusal,
  isReleaseVersion,
  MIGRATION_RE,
  migrationsSha256,
  openFloor,
  openReleaseRecord,
  parseStrictJson,
  type ReleaseAsset,
  type ReleaseAssetEntry,
  type ReleaseFile,
  type ReleaseReader,
  type ReleaseRecord,
  sha256Hex,
  TEST_HOOKS_DEFINE,
} from "./release.js";
import { parseUstar } from "./tar.js";

export const FLOOR_KEY = "releases/floor.json";
export const RECORD_FILE = "record.sig.json";
export const TEMPLATE_FILE = "template/wrangler.template.jsonc";
export const WELCOME_FILE = "welcome/welcome.md";
/** Small JSON and text objects (record, floor, template, welcome). */
const SMALL_MAX = 16 * 1024 * 1024;

export class PublishRefused extends Error {
  override name = "PublishRefused";
}

const assertVariant = (v: unknown): BundleVariant => {
  if (v !== "release" && v !== "redline")
    throw new Error("variant must be release or redline");
  return v;
};

/** The R2 key of `rel` in one release variant; refuses a malformed version or variant. */
export function releaseKey(
  version: string,
  variant: BundleVariant,
  rel: string,
): string {
  if (!isReleaseVersion(version))
    throw new Error(
      `version ${JSON.stringify(String(version)).slice(0, 40)} is not a release version`,
    );
  return `releases/${version}/${assertVariant(variant)}/${rel}`;
}

const decode = (b: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(b);
const parseStored = (b: Uint8Array) => parseStrictJson(decode(b));

/** The main module the bundle step names: the template's `main`, as .js. */
const mainModuleOf = (template: Uint8Array) => {
  const t = parseTemplate(decode(template));
  return `${basename(t.main, extname(t.main))}.js`;
};

const moduleOf = (name: string, bytes: Uint8Array): Module => {
  assertAssetPath(name);
  const ext = extname(name);
  const type =
    ext === ".wasm" ? "wasm" : ext === ".js" || ext === ".mjs" ? "esm" : null;
  if (!type) throw new Error(`module ${name} is not .js, .mjs or .wasm`);
  return { name, type, bytes };
};

function pubkeyOf(env: Env): string {
  const k = RELEASE_PUBKEY[env];
  if (typeof k !== "string" || k === RELEASE_PUBKEY_PLACEHOLDER)
    throw new PublishRefused(
      `RELEASE_PUBKEY.${env} is still the placeholder; the key ceremony must set it first`,
    );
  return k;
}

function bucketOf(env: Env): string {
  if (env !== "staging" && env !== "prod") throw new ForeignResource("", env);
  const bucket = platformNames(env).releases;
  assertOwnResource(bucket, env);
  return bucket;
}

/** The S3 client must be bound to this env's releases bucket. */
function r2Of(r2: R2Releases, env: Env): R2Releases {
  const bucket = bucketOf(env);
  if (r2?.env !== env || r2.bucket !== bucket)
    throw new PublishRefused(
      `the R2 S3 client is for ${String(r2?.env)} (${String(r2?.bucket)}), not ${env} (${bucket})`,
    );
  return r2;
}

const is412 = (e: unknown) => e instanceof CfError && e.status === 412;

const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));

/** One page of a listing: the objects under `prefix` from `cursor` on. */
type ListPage = (
  prefix: string,
  cursor: string | undefined,
) => Promise<{
  objects: { key: string; size: number }[];
  truncated: boolean;
  cursor?: string;
}>;

/** Every object under `prefix`, paginated, refused past `max`. */
function listAll(cf: Cf, bucket: string, prefix: string, max: number) {
  return listPages((p, c) => cf.r2ObjectList(bucket, p, c), prefix, max);
}

async function listPages(listPage: ListPage, prefix: string, max: number) {
  const out: { key: string; size: number; name: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page <= Math.ceil(max / 1000) + 1; page++) {
    const r = await listPage(prefix, cursor);
    for (const x of r.objects) {
      if (!x.key.startsWith(prefix))
        throw new Error(`R2 listing for ${prefix} returned ${x.key}`);
      out.push({ ...x, name: x.key.slice(prefix.length) });
    }
    if (out.length > max)
      throw new Error(`more than ${max} objects under ${prefix} (limit)`);
    if (!r.truncated) return out;
    cursor = r.cursor;
  }
  throw new Error(`R2 listing for ${prefix} did not end`);
}

/** S3 clients whose R2 conditionals passed probeR2Conditionals, per env (this process only). */
const PROBED = new WeakMap<R2Releases, Set<Env>>();

/**
 * M2 / H-S3: prove R2's S3 endpoint enforces the conditional headers before
 * relying on them. On a throwaway key: an If-None-Match: * PUT lands, a second
 * one answers 412, an If-Match PUT with a wrong etag answers 412, and one with
 * the current etag lands. Any other answer (a 2xx where 412 is expected
 * above all) refuses. Cleans up the key. publishRelease and publishFloor
 * refuse to run unless this passed for the same client and env in this
 * process.
 */
export async function probeR2Conditionals(
  r2: R2Releases,
  env: Env,
): Promise<void> {
  const s3 = r2Of(r2, env);
  const bucket = s3.bucket;
  const key = `probe/${randomBytes(16).toString("hex")}`;
  const one = new TextEncoder().encode("oa-probe-1");
  const two = new TextEncoder().encode("oa-probe-2");
  const must412 = async (what: string, put: () => Promise<unknown>) => {
    try {
      await put();
    } catch (e) {
      if (is412(e)) return;
      throw e;
    }
    throw new PublishRefused(
      `R2 ignored ${what} on ${bucket}: conditional writes are not enforced, so publishing is refused`,
    );
  };
  try {
    const first = await s3.put(key, one, { ifNoneMatch: "*" });
    await must412("If-None-Match: *", () =>
      s3.put(key, two, { ifNoneMatch: "*" }),
    );
    const etag = first.etag || (await s3.head(key))?.etag;
    if (!etag) throw new PublishRefused(`R2 probe: ${key} has no etag`);
    const wrong = etag === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
    await must412("a wrong If-Match", () =>
      s3.put(key, two, { ifMatch: wrong }),
    );
    await s3.put(key, two, { ifMatch: etag });
    const got = await s3.get(key, { maxBytes: 64 });
    if (!got || !same(got.bytes, two))
      throw new PublishRefused("R2 probe: the If-Match write did not land");
  } finally {
    await s3.deleteProbe(key).catch(() => {});
  }
  const s = PROBED.get(s3) ?? new Set<Env>();
  s.add(env);
  PROBED.set(s3, s);
}

function assertProbed(r2: R2Releases, env: Env): R2Releases {
  const s3 = r2Of(r2, env);
  if (!PROBED.get(s3)?.has(env))
    throw new PublishRefused(
      `run probeR2Conditionals(r2, "${env}") first: R2 conditional writes must be proven in this process before publishing`,
    );
  return s3;
}

/** The env's floor, verified, checked against FLOOR_MIN_SEQ and for `version`. */
async function checkFloor(
  r2: R2Releases,
  env: Env,
  version: string,
): Promise<FloorRecord> {
  const got = await r2.get(FLOOR_KEY, { maxBytes: SMALL_MAX });
  if (!got)
    throw new PublishRefused(
      `the ${env} release floor (${FLOOR_KEY}) is missing; publishFloor first`,
    );
  let f: FloorRecord;
  try {
    if (got.bytes.length > SMALL_MAX) throw new Error("too large");
    f = openFloor(parseStored(got.bytes), pubkeyOf(env), env);
  } catch (e) {
    throw new PublishRefused(
      `the ${env} release floor: ${(e as Error).message}`,
    );
  }
  const why = floorRefusal(f, version, FLOOR_MIN_SEQ[env]);
  if (why) throw new PublishRefused(why);
  return f;
}

/**
 * Verifies a signed release from the GitHub release (the tar and its
 * .sig.json, Task 8 downloads them) and copies exactly the verified bytes to
 * oa-<p>-releases under releases/<version>/<variant>/, every object with
 * If-None-Match: *, the record last. Refuses before any write: a signature
 * not by RELEASE_PUBKEY[env], another env, version or variant, redline for
 * prod, a tar with anything but plain regular files, a file set other than
 * exactly the record's, a version under the floor, and a version that is
 * already published (its record exists). A partial version (objects present
 * and byte-identical to the tar, no record) is resumed; any other object
 * there is refused. A 412 on a create-once PUT (the object appeared since the
 * listing, or a lost reply of our own write) is accepted only when the object
 * now holds exactly the tar's bytes; otherwise it refuses. Writes and the
 * reads they rest on go through `r2` (S3); `cf` only lists. Needs
 * probeR2Conditionals(r2, env) first.
 */
export async function publishRelease(o: {
  cf: Cf;
  r2: R2Releases;
  env: Env;
  version: string;
  files: { tar: Uint8Array; sig: Uint8Array };
}): Promise<{ variant: BundleVariant; keys: string[] }> {
  const { cf, env, version } = o;
  const bucket = bucketOf(env);
  const r2 = assertProbed(o.r2, env);
  if (!isReleaseVersion(version))
    throw new PublishRefused(`version ${version} is not a release version`);
  const pubkey = pubkeyOf(env);
  const want = `${version} (${env})`;
  let rec: ReleaseRecord;
  try {
    if (!(o.files?.sig instanceof Uint8Array) || o.files.sig.length > SMALL_MAX)
      throw new Error("no .sig.json bytes");
    rec = openReleaseRecord(parseStored(o.files.sig), pubkey, env);
  } catch (e) {
    throw new PublishRefused(
      `release ${want}: the .sig.json: ${(e as Error).message}`,
    );
  }
  if (rec.env !== env)
    throw new PublishRefused(
      `release ${want}: the record is for env ${rec.env}`,
    );
  if (rec.version !== version)
    throw new PublishRefused(
      `release ${want}: the record is for version ${String(rec.version)}`,
    );
  const variant = rec.variant;
  if (variant !== "release" && variant !== "redline")
    throw new PublishRefused(`release ${want}: unknown variant`);
  if (env === "prod" && variant === "redline")
    throw new PublishRefused(
      `release ${want}: the redline bundle is never published to prod`,
    );
  if (rec.defines[TEST_HOOKS_DEFINE] !== (variant === "redline"))
    throw new PublishRefused(
      `release ${want}: ${TEST_HOOKS_DEFINE} does not match the variant`,
    );
  const refuse = (what: string): never => {
    throw new PublishRefused(
      `release ${want} (${variant}): the ${what} do not match the signed record`,
    );
  };

  // Limits from the signed record, before the tar is read.
  let files: ReleaseAsset[];
  try {
    for (const a of rec.assets) assertAssetPath(a.path);
    assertAssetLimits(rec.assets);
    if (!(o.files.tar instanceof Uint8Array)) throw new Error("no tar bytes");
    files = parseUstar(o.files.tar);
  } catch (e) {
    throw new PublishRefused(
      `release ${want} (${variant}): ${(e as Error).message}`,
    );
  }

  // Exactly the record's files: sorted by kind, then each checked.
  const modules: Module[] = [];
  const assets: ReleaseAsset[] = [];
  const migrations: ReleaseFile[] = [];
  let template: Uint8Array | undefined;
  let welcome: Uint8Array | undefined;
  try {
    for (const f of files) {
      const [top, ...rest] = f.path.split("/");
      const name = rest.join("/");
      if (f.path === TEMPLATE_FILE) template = f.bytes;
      else if (f.path === WELCOME_FILE) welcome = f.bytes;
      else if (top === "modules" && name) modules.push(moduleOf(name, f.bytes));
      else if (top === "assets" && name)
        assets.push({ path: name, bytes: f.bytes });
      else if (top === "migrations" && name && MIGRATION_RE.test(name))
        migrations.push({ name, bytes: f.bytes });
      else throw new Error(`unexpected file ${f.path} in the tar`);
    }
  } catch (e) {
    throw new PublishRefused(
      `release ${want} (${variant}): ${(e as Error).message}`,
    );
  }
  if (!template)
    throw new PublishRefused(
      `release ${want}: the tar has no ${TEMPLATE_FILE}`,
    );
  if (!welcome)
    throw new PublishRefused(`release ${want}: the tar has no ${WELCOME_FILE}`);
  if (sha256Hex(template) !== rec.templateSha256) refuse("template");
  if (sha256Hex(welcome) !== rec.welcomeSha256) refuse("welcome");
  if (migrationsSha256(migrations) !== rec.migrationsSha256)
    refuse("migrations");
  let mainModule: string;
  try {
    mainModule = mainModuleOf(template);
  } catch (e) {
    throw new PublishRefused(`release ${want}: ${(e as Error).message}`);
  }
  if (bundleSha256({ mainModule, modules }) !== rec.sha256) refuse("modules");
  let got: string;
  try {
    got = canonicalJson(assetEntries(assets));
  } catch (e) {
    throw new PublishRefused(`release ${want}: ${(e as Error).message}`);
  }
  if (got !== canonicalJson(rec.assets))
    refuse("assets (an extra, missing or changed file)");

  await checkFloor(r2, env, version);

  // Never overwrite. A record means published; anything else present must be
  // a byte-identical object of this tar (a resumed partial publish).
  const prefix = releaseKey(version, variant, "");
  const present = await listAll(cf, bucket, prefix, ASSET_LIMITS.files + 2000);
  if (present.some((x) => x.name === RECORD_FILE))
    throw new PublishRefused(
      `release ${version} (${variant}) is already published to ${bucket}; a version is never overwritten`,
    );
  const byName = new Map(files.map((f) => [f.path, f]));
  const done = new Set<string>();
  for (const x of present) {
    const f = byName.get(x.name);
    if (!f)
      throw new PublishRefused(
        `release ${version} (${variant}): ${x.key} is in ${bucket} but not in the tar; refusing to resume`,
      );
    let cur: { bytes: Uint8Array } | null = null;
    if (x.size === f.bytes.length)
      cur = await r2.get(x.key, { maxBytes: f.bytes.length }).catch(() => null);
    if (!cur || !same(cur.bytes, f.bytes))
      throw new PublishRefused(
        `release ${version} (${variant}): ${x.key} differs from the tar; refusing to resume`,
      );
    done.add(f.path);
  }
  /** Create-once; a 412 is "already exists": byte-identical resumes, else refuse. */
  const createOnce = async (key: string, bytes: Uint8Array, what: string) => {
    try {
      await r2.put(key, bytes, { ifNoneMatch: "*" });
    } catch (e) {
      if (!is412(e)) throw e;
      const cur = await r2
        .get(key, { maxBytes: bytes.length })
        .catch(() => null);
      if (cur && same(cur.bytes, bytes)) return;
      throw new PublishRefused(
        `release ${version} (${variant}): ${key} already exists in ${bucket} ${what}; a version is never overwritten`,
      );
    }
  };
  const keys: string[] = [];
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (!done.has(f.path))
      await createOnce(prefix + f.path, f.bytes, "and differs from the tar");
    keys.push(prefix + f.path);
  }
  // The record last: a reader that finds it finds every file.
  await createOnce(
    prefix + RECORD_FILE,
    o.files.sig,
    "with another record (already published)",
  );
  keys.push(prefix + RECORD_FILE);
  return { variant, keys };
}

/**
 * Replaces releases/floor.json with a new signed floor (create-only when
 * there is none, else If-Match on the current etag). The new floor must
 * verify for `env`, have seq >= FLOOR_MIN_SEQ[env] and above the current
 * seq, a minVersion the same or higher, and keep every revoked version.
 * Reads and writes go through `r2` (S3), so the etag is the one S3 checks. A
 * 412 refuses ("floor seq exists"): someone else wrote the floor meanwhile;
 * it is never retried as success. Needs probeR2Conditionals(r2, env) first.
 */
export async function publishFloor(o: {
  r2: R2Releases;
  env: Env;
  floor: Uint8Array;
}): Promise<FloorRecord> {
  const { env } = o;
  const r2 = assertProbed(o.r2, env);
  const pubkey = pubkeyOf(env);
  let next: FloorRecord;
  try {
    if (!(o.floor instanceof Uint8Array) || o.floor.length > SMALL_MAX)
      throw new Error("no floor bytes");
    next = openFloor(parseStored(o.floor), pubkey, env);
  } catch (e) {
    throw new PublishRefused(`the new ${env} floor: ${(e as Error).message}`);
  }
  if (next.seq < FLOOR_MIN_SEQ[env])
    throw new PublishRefused(
      `the new ${env} floor seq ${next.seq} is below FLOOR_MIN_SEQ ${FLOOR_MIN_SEQ[env]}`,
    );
  const write = async (cond: { ifNoneMatch: "*" } | { ifMatch: string }) => {
    try {
      await r2.put(FLOOR_KEY, o.floor, cond);
    } catch (e) {
      if (!is412(e)) throw e;
      throw new PublishRefused(
        `floor seq exists: the ${env} floor (${FLOOR_KEY}) changed while seq ${next.seq} was being published (HTTP 412); check it and re-run`,
      );
    }
  };
  const cur = await r2.get(FLOOR_KEY, { maxBytes: SMALL_MAX });
  if (!cur) {
    await write({ ifNoneMatch: "*" });
    return next;
  }
  let old: FloorRecord;
  try {
    old = openFloor(parseStored(cur.bytes), pubkey, env);
  } catch (e) {
    throw new PublishRefused(
      `the current ${env} floor does not verify (${(e as Error).message}); fix it by hand`,
    );
  }
  if (next.seq <= old.seq)
    throw new PublishRefused(
      `the floor seq must go up (current ${old.seq}, new ${next.seq})`,
    );
  if (compareVersions(next.minVersion, old.minVersion) < 0)
    throw new PublishRefused(
      `the floor minVersion may not go down (${old.minVersion} -> ${next.minVersion})`,
    );
  const missing = old.revoked.filter((v) => !next.revoked.includes(v));
  if (missing.length > 0)
    throw new PublishRefused(
      `the new floor must keep every revoked version (dropped ${missing.join(", ")})`,
    );
  if (!cur.etag)
    throw new PublishRefused(`the current ${env} floor has no etag`);
  await write({ ifMatch: cur.etag });
  return next;
}

/**
 * The #435 ReleaseReader over R2, through `cf` (account routes only, the
 * env's releases bucket). Listings are paginated and capped; assets are
 * capped by ASSET_LIMITS and matched to the signed record (names and sizes)
 * before any download, and each object's size is checked before its hash.
 * `assets` returns the record's list only; `assetBytes` downloads one file,
 * checked against the entry of the last verified record for its release.
 */
export function r2ReleaseReader(cf: Cf, env: Env): ReleaseReader {
  const bucket = bucketOf(env);
  return releaseReaderOver(
    {
      bucket,
      // L6: the GET is aborted as soon as the body passes `max` (the listed or record size).
      get: async (key, max) =>
        (await cf.r2ObjectGet(bucket, key, { maxBytes: max }))?.bytes ?? null,
      listPage: (prefix, cursor) => cf.r2ObjectList(bucket, prefix, cursor),
    },
    env,
  );
}

/**
 * The part of a Workers R2Bucket binding r2BindingReleaseReader uses; a
 * real `R2Bucket` (the env's releases bucket) satisfies it.
 */
export interface R2ReleaseBucket {
  get(key: string): Promise<{
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    body?: { cancel(): Promise<void> };
  } | null>;
  list(o: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

/**
 * r2ReleaseReader over an R2 binding instead of the REST API (the hosted
 * provisioner Worker): the same keys, record checks, listings and limits.
 * An object over the size it may have (the listed or record size) is
 * refused from its metadata, before its body is read.
 */
export function r2BindingReleaseReader(
  bucket: R2ReleaseBucket,
  env: Env,
): ReleaseReader {
  const name = bucketOf(env);
  return releaseReaderOver(
    {
      bucket: name,
      async get(key, max) {
        const o = await bucket.get(key);
        if (!o) return null;
        if (o.size > max) {
          await o.body?.cancel().catch(() => {});
          throw new Error(`release object ${key}: size over ${max} bytes`);
        }
        const bytes = new Uint8Array(await o.arrayBuffer());
        if (bytes.length > max)
          throw new Error(`release object ${key}: size over ${max} bytes`);
        return bytes;
      },
      async listPage(prefix, cursor) {
        const r = await bucket.list({
          prefix,
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return {
          objects: r.objects.map((x) => ({ key: x.key, size: x.size })),
          truncated: r.truncated,
          ...(r.truncated ? { cursor: r.cursor } : {}),
        };
      },
    },
    env,
  );
}

/** Where a ReleaseReader reads from: the env's releases bucket, by REST or binding. */
interface ReleaseStore {
  /** The bucket name, for messages. */
  bucket: string;
  /** The object's bytes, refused past `max`; null when there is none. */
  get(key: string, max: number): Promise<Uint8Array | null>;
  listPage: ListPage;
}

function releaseReaderOver(store: ReleaseStore, env: Env): ReleaseReader {
  const { bucket } = store;
  const get = async (key: string, max: number): Promise<Uint8Array> => {
    const o = await store.get(key, max);
    if (!o) throw new Error(`release object ${key} is missing from ${bucket}`);
    return o;
  };
  const list = (prefix: string, max: number) =>
    listPages(store.listPage, prefix, max);
  const record = async (version: string, variant: BundleVariant) => {
    const key = releaseKey(version, variant, RECORD_FILE);
    const o = await store.get(key, SMALL_MAX);
    if (!o) return null;
    return parseStored(o);
  };
  const template = (version: string, variant: BundleVariant) =>
    get(releaseKey(version, variant, TEMPLATE_FILE), SMALL_MAX);
  /** The verified record's assets, by path, for one release. */
  const entries = new Map<string, Map<string, ReleaseAssetEntry>>();
  const verified = async (version: string, variant: BundleVariant) => {
    const signed = await record(version, variant);
    if (!signed)
      throw new Error(`no release record for ${version} (${variant})`);
    const rec = openReleaseRecord(signed, pubkeyOf(env), env);
    // L7: the record at this path must be for this version and variant.
    if (rec.version !== version || rec.variant !== variant)
      throw new Error(
        `the release record at ${version} (${variant}) is for ${rec.version} (${rec.variant})`,
      );
    assertAssetLimits(rec.assets);
    entries.set(
      releaseKey(version, variant, ""),
      new Map(rec.assets.map((a) => [a.path, a])),
    );
    return rec;
  };
  return {
    record: async (version, variant) =>
      (await record(version, variant)) as Awaited<
        ReturnType<ReleaseReader["record"]>
      >,
    async modules(version, variant) {
      const prefix = releaseKey(version, variant, "modules/");
      const listed = await list(prefix, 1000);
      let total = 0;
      for (const x of listed) {
        if (x.size > ASSET_LIMITS.fileBytes)
          throw new Error(`module ${x.name} is over 25 MiB`);
        total += x.size;
      }
      if (total > ASSET_LIMITS.totalBytes)
        throw new Error("modules are over the 512 MiB total limit");
      const mainModule = mainModuleOf(await template(version, variant));
      const modules: Module[] = [];
      for (const x of listed) {
        const bytes = await get(x.key, x.size);
        if (bytes.length !== x.size)
          throw new Error(
            `module ${x.name}: size ${bytes.length}, listed ${x.size}`,
          );
        modules.push(moduleOf(x.name, bytes));
      }
      return { mainModule, modules };
    },
    async assets(version, variant) {
      const rec = await verified(version, variant);
      const prefix = releaseKey(version, variant, "assets/");
      const listed = await list(prefix, ASSET_LIMITS.files);
      const sizes = new Map(rec.assets.map((a) => [a.path, a.size]));
      if (
        listed.length !== rec.assets.length ||
        !listed.every((x) => sizes.get(x.name) === x.size)
      )
        throw new Error(
          `release ${version} (${variant}): the assets in ${bucket} do not match the record (an extra, missing or resized file)`,
        );
      return rec.assets;
    },
    async assetBytes(version, variant, path) {
      const at = releaseKey(version, variant, "");
      if (!entries.has(at)) await verified(version, variant);
      const a = entries.get(at)?.get(path);
      if (!a)
        throw new Error(
          `asset ${String(path).slice(0, 80)} is not in the ${version} (${variant}) record`,
        );
      const bytes = await get(
        releaseKey(version, variant, "assets/") + a.path,
        a.size,
      );
      if (bytes.length !== a.size)
        throw new Error(
          `asset ${a.path}: size ${bytes.length}, the record says ${a.size}`,
        );
      if (sha256Hex(bytes) !== a.sha256)
        throw new Error(`asset ${a.path}: sha256 does not match the record`);
      return bytes;
    },
    template,
    async migrations(version, variant) {
      const prefix = releaseKey(version, variant, "migrations/");
      const out: ReleaseFile[] = [];
      for (const x of await list(prefix, 1000)) {
        if (!MIGRATION_RE.test(x.name))
          throw new Error(`unexpected migration ${x.name}`);
        if (x.size > ASSET_LIMITS.fileBytes)
          throw new Error(`migration ${x.name} is over 25 MiB`);
        out.push({ name: x.name, bytes: await get(x.key, x.size) });
      }
      return out;
    },
    welcome: (version, variant) =>
      get(releaseKey(version, variant, WELCOME_FILE), SMALL_MAX),
    async floor() {
      const o = await store.get(FLOOR_KEY, SMALL_MAX);
      if (!o) return null;
      return parseStored(o);
    },
  };
}

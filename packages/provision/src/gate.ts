// The release gate of a hosted job (design v7 5.2 step 4, 5.4) and the
// release catalog ProvisionerRpc.releases() serves (2.6, R16): which
// versions oa-<p>-releases holds, which variants of each verify against the
// env's release key, and which the signed floor admits. Reads only; no
// Cloudflare writes. The key and the floor anchor stay in internal/gates.ts.
import { FLOOR_MIN_SEQ, RELEASE_PUBKEY } from "./internal/gates.js";
import { ProvisionRefused } from "./jobs.js";
import type { Env } from "./names.js";
import { type R2ReleaseBucket, RECORD_FILE, releaseKey } from "./publish.js";
import {
  type BundleVariant,
  compareVersions,
  type FloorRecord,
  floorRefusal,
  openFloor,
  openReleaseRecord,
  type ReleaseReader,
} from "./release.js";

/** A stable release version (no prerelease or build suffix). */
const STABLE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const VARIANTS: readonly BundleVariant[] = ["release", "redline"];
/** The most versions one listing walks (a bucket holds a few dozen). */
const MAX_VERSIONS = 500;

/** One version in the catalog (the shape of @oa/shared's Release). */
export interface CatalogRelease {
  version: string;
  publishedAt: number | null;
  /** The variants whose signed record verifies for this env. */
  variants: BundleVariant[];
  /** The floor admits it (minVersion, revoked, seq). */
  installable: boolean;
  /** The newest installable version with a release variant (one at most). */
  latest: boolean;
}

/**
 * The part of an R2 binding the catalog lists with: a delimiter listing of
 * `releases/` (one prefix per version) and the record objects' upload time.
 */
export interface R2CatalogBucket extends R2ReleaseBucket {
  list(o: {
    prefix: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
  }): Promise<{
    objects: { key: string; size: number; uploaded?: Date }[];
    truncated: boolean;
    cursor?: string;
    delimitedPrefixes?: string[];
  }>;
}

/** The stable versions under releases/ (the floor object is not one). */
export async function bucketVersions(b: R2CatalogBucket): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await b.list({
      prefix: "releases/",
      delimiter: "/",
      limit: 1000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const p of r.delimitedPrefixes ?? []) {
      const v = p.slice("releases/".length).replace(/\/$/, "");
      if (STABLE.test(v)) out.add(v);
      if (out.size > MAX_VERSIONS)
        throw new Error(`more than ${MAX_VERSIONS} release versions`);
    }
    if (!r.truncated) return [...out].sort(compareVersions);
    cursor = r.cursor;
  }
  throw new Error("the release listing did not end");
}

/** The env's floor, verified; null when it is missing or does not verify. */
async function floorOf(
  release: ReleaseReader,
  env: Env,
): Promise<FloorRecord | null> {
  const got = await release.floor();
  if (got === null || got === undefined) return null;
  try {
    return openFloor(structuredClone(got), RELEASE_PUBKEY[env], env);
  } catch {
    return null;
  }
}

/**
 * Whether `version`'s `variant` has a record that verifies for `env`. A read
 * that throws is rethrown (the step retries it), unless `tolerant` (the
 * catalog: a malformed object is a variant that does not verify).
 */
async function verifies(
  release: ReleaseReader,
  env: Env,
  version: string,
  variant: BundleVariant,
  tolerant = false,
): Promise<"verified" | "absent" | "unverified"> {
  let got: unknown;
  try {
    got = await release.record(version, variant);
  } catch (e) {
    if (tolerant) return "unverified";
    throw e;
  }
  if (!got) return "absent";
  try {
    const r = openReleaseRecord(structuredClone(got), RELEASE_PUBKEY[env], env);
    return r.version === version && r.variant === variant
      ? "verified"
      : "unverified";
  } catch {
    return "unverified";
  }
}

const admits = (f: FloorRecord | null, env: Env, version: string) =>
  f !== null && floorRefusal(f, version, FLOOR_MIN_SEQ[env]) === null;

/** The most catalog versions read at once (#1029). */
export const CATALOG_CONCURRENCY = 8;

/** `f` over `items` with at most `limit` in flight, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  f: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
  return out;
}

/**
 * The catalog of `versions`, newest first, at most CATALOG_CONCURRENCY
 * versions read at once (#1029). `only` reads that one version and no
 * other (the presence check of create and upgrade, 3.5): [] when it has no
 * verified record; below the floor or revoked it is listed, not
 * installable (release_gate refuses it); its `latest` is false.
 */
export async function releaseCatalog(o: {
  release: ReleaseReader;
  env: Env;
  versions: string[];
  /** A version's publish time (its release record's upload), or null. */
  publishedAt?: (version: string) => Promise<number | null>;
  only?: string;
}): Promise<CatalogRelease[]> {
  const floor = await floorOf(o.release, o.env);
  const wanted =
    o.only === undefined ? o.versions : o.versions.filter((v) => v === o.only);
  const read = await mapLimit(
    [...wanted].sort(compareVersions).reverse(),
    CATALOG_CONCURRENCY,
    async (version): Promise<CatalogRelease | null> => {
      const variants: BundleVariant[] = [];
      for (const v of VARIANTS)
        if ((await verifies(o.release, o.env, version, v, true)) === "verified")
          variants.push(v);
      if (variants.length === 0) return null;
      return {
        version,
        publishedAt: (await o.publishedAt?.(version)) ?? null,
        variants,
        installable: admits(floor, o.env, version),
        latest: false,
      };
    },
  );
  const out = read.filter((r): r is CatalogRelease => r !== null);
  if (o.only !== undefined) return out;
  const latest = out.find(
    (r) => r.installable && r.variants.includes("release"),
  );
  if (latest) latest.latest = true;
  return out;
}

/** The earliest upload time of a version's record objects, from the bucket. */
export function bucketPublishedAt(
  b: R2CatalogBucket,
): (version: string) => Promise<number | null> {
  return async (version) => {
    let at: number | null = null;
    for (const v of VARIANTS) {
      const key = releaseKey(version, v, RECORD_FILE);
      const r = await b.list({ prefix: key, limit: 1 });
      const t = r.objects.find((x) => x.key === key)?.uploaded?.getTime();
      if (typeof t === "number" && (at === null || t < at)) at = t;
    }
    return at;
  };
}

/**
 * The release gate (design v7 5.2 step 4): `version`, or the newest
 * installable one with the variant, must have a record that verifies and a
 * floor that admits it. The variant is `redline` iff `testHooks` (its
 * record's TEST_HOOKS_DEFINE is then true; openReleaseRecord checks the
 * pairing). `above`: upgrade's `from`; the version must be strictly newer.
 * Refusals: `release_not_published` (no such record), `release_unverified`
 * (signature, shape or floor), `downgrade_refused`.
 */
export async function releaseGate(o: {
  release: ReleaseReader;
  env: Env;
  version: string | null;
  testHooks: boolean;
  /** The published versions (bucketVersions); read only when version is null. */
  versions: () => Promise<string[]>;
  above?: string;
}): Promise<{ version: string; bundle: BundleVariant }> {
  const bundle: BundleVariant = o.testHooks ? "redline" : "release";
  let version = o.version;
  if (version === null) {
    const floor = await floorOf(o.release, o.env);
    const all = (await o.versions()).sort(compareVersions).reverse();
    for (const v of all) {
      if (!admits(floor, o.env, v)) continue;
      if ((await verifies(o.release, o.env, v, bundle)) === "verified") {
        version = v;
        break;
      }
    }
    if (version === null)
      throw new ProvisionRefused(
        `no installable ${bundle} release is published`,
        "release_not_published",
      );
  }
  if (!STABLE.test(version))
    throw new ProvisionRefused(
      `version ${version.slice(0, 40)} is not a release version`,
      "release_not_published",
    );
  if (o.above !== undefined && compareVersions(version, o.above) <= 0)
    throw new ProvisionRefused(
      `version ${version} is not above ${o.above}`,
      "downgrade_refused",
    );
  const state = await verifies(o.release, o.env, version, bundle);
  if (state === "absent")
    throw new ProvisionRefused(
      `no ${bundle} release record for ${version}`,
      "release_not_published",
    );
  if (state === "unverified")
    throw new ProvisionRefused(
      `the ${bundle} release record for ${version} does not verify`,
      "release_unverified",
    );
  const floor = await floorOf(o.release, o.env);
  if (floor === null)
    throw new ProvisionRefused(
      `the ${o.env} release floor is missing or does not verify`,
      "release_unverified",
    );
  const why = floorRefusal(floor, version, FLOOR_MIN_SEQ[o.env]);
  if (why) throw new ProvisionRefused(why, "release_unverified");
  return { version, bundle };
}

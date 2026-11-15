// The release pin of the bus package (#2543). A server build proves, with the
// updater's own check (packages/bus-daemon/src/update: the same pins, the same
// offline Sigstore verification and Node floor), the @open-artifacts/bus
// release that goes with this server, and records its version and sha512. The
// first install in llms.txt then checks the bytes it runs against that pin.
// Trust is Sigstore and the pins, not npm and not one workflow's outputs.
//
// A server whose own version has no published release, a build that is
// offline, or one that is refused gets no pin and says why. A pre-release
// (x.y.z-suffix) pins the newest stable release below it.
import { ReleaseError } from "../../../packages/bus-daemon/src/update/errors.ts";
import {
  type FetchedRelease,
  fetchRelease,
} from "../../../packages/bus-daemon/src/update/fetch.ts";
import {
  compareVersions,
  isVersion,
  PINS,
} from "../../../packages/bus-daemon/src/update/pins.ts";
import {
  type VerifiedRelease,
  verifyRelease,
} from "../../../packages/bus-daemon/src/update/verify.ts";

/**
 * The oldest release a release build may fall back to (#2543). Each release
 * raises it to the latest published stable, so a fallback never reaches an
 * old release that a later one replaced.
 */
export const BUS_PIN_MIN = "0.188.0";
/** A release build falls back at most this many stable releases below its own. */
export const BUS_PIN_MAX_BACK = 3;

export type BusPkg = { version: string; integrity: string };
export type PinResult =
  | {
      pin: BusPkg;
      log: string;
      why: string;
      /** Set when the pin is an older release than this server's own. */
      fallbackFor?: string;
    }
  | {
      pin: null;
      log: string;
      why: string;
      /** The failure may only be the registry lagging behind a release: worth a retry. */
      retryable: boolean;
    };

const SERVER_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * The release to pin for a server at `serverVersion`: itself when stable;
 * for a pre-release, the newest stable of `published` below it. null: none.
 */
export function pinVersionFor(
  serverVersion: string,
  published: readonly string[],
): string | null {
  const m = SERVER_VERSION.exec(serverVersion);
  if (!m) return null;
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  if (m[4] === undefined) return base;
  const below = published
    .filter(isVersion)
    .filter((v) => compareVersions(v, base) < 0)
    .sort(compareVersions);
  return below.at(-1) ?? null;
}

/** npm's integrity form of a sha512 given as hex. */
export const integrityOf = (sha512Hex: string): string =>
  `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;

/** The published versions of the package, from the registry (no redirect, size capped). */
export async function publishedVersions(
  doFetch: typeof fetch = fetch,
): Promise<string[]> {
  const res = await doFetch(
    `${PINS.registry}/${PINS.packageName.replace("/", "%2F")}`,
    {
      redirect: "error",
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (res.status !== 200) throw new Error(`registry answered ${res.status}`);
  const text = await res.text();
  if (text.length > 20 * 1024 * 1024)
    throw new Error("registry list too large");
  const j = JSON.parse(text) as { versions?: Record<string, unknown> };
  return Object.keys(j.versions ?? {});
}

export type PinDeps = {
  versions?: () => Promise<string[]>;
  fetchRelease?: (v: string) => Promise<FetchedRelease>;
  verifyRelease?: (r: FetchedRelease) => VerifiedRelease;
};

const why = (e: unknown): string =>
  e instanceof ReleaseError
    ? `${e.code}: ${e.message.replace(/^[a-z_]+: /, "")}`
    : e instanceof Error
      ? e.message
      : String(e);

/** Verifies the release for `serverVersion`; never throws. */
export async function resolvePin(
  serverVersion: string,
  deps: PinDeps = {},
): Promise<PinResult> {
  let target: string | null;
  try {
    const stable = SERVER_VERSION.exec(serverVersion)?.[4] === undefined;
    target = pinVersionFor(
      serverVersion,
      stable ? [] : await (deps.versions ?? publishedVersions)(),
    );
  } catch (e) {
    return none(`could not list the published releases (${why(e)})`, true);
  }
  if (target === null)
    return none(
      `no published stable release at or below server version ${serverVersion}`,
      false,
    );
  return resolvePinFor(target, deps, serverVersion);
}

/** Verifies release `target` itself. */
async function resolvePinFor(
  target: string,
  deps: PinDeps,
  serverVersion = target,
): Promise<PinResult> {
  try {
    const rel = await (deps.fetchRelease ?? fetchRelease)(target);
    const ok = (deps.verifyRelease ?? verifyRelease)(rel);
    const pin = { version: ok.version, integrity: integrityOf(ok.sha512) };
    return {
      pin,
      why: "",
      log: `bus pin: ${PINS.packageName}@${pin.version} ${pin.integrity} (verified: Sigstore provenance, repo id ${PINS.repoId}, ${PINS.workflowPath}@${PINS.ref}; server ${serverVersion})`,
    };
  } catch (e) {
    // Not on npm yet (or the registry unreachable) may be lag; a refusal is not.
    const lag =
      !(e instanceof ReleaseError) ||
      e.code === "fetch_failed" ||
      e.code === "no_attestation";
    return none(
      `${PINS.packageName}@${target} was not verified (${why(e)})`,
      lag,
    );
  }
}

const none = (reason: string, retryable: boolean): PinResult => ({
  pin: null,
  why: reason,
  retryable,
  log: `bus pin: none (${reason}). This build tells agents the bus cannot be installed from it.`,
});

/**
 * The release run's version (BUS_PIN_REQUIRED=1): a missing pin fails the
 * build, after `tries` attempts `waitMs` apart while the failure may only be
 * the registry lagging behind the release (not yet published or listed). A
 * refusal fails at once.
 */
export async function resolvePinRequired(
  serverVersion: string,
  deps: PinDeps = {},
  o: {
    tries?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<PinResult> {
  const tries = o.tries ?? 10;
  const waitMs = o.waitMs ?? 30_000;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let r = await resolvePin(serverVersion, deps);
  for (let n = 1; n < tries && r.pin === null && r.retryable; n++) {
    o.log?.(
      `${r.log} Attempt ${n} of ${tries}; trying again in ${waitMs / 1000} s.`,
    );
    await sleep(waitMs);
    r = await resolvePin(serverVersion, deps);
  }
  return r;
}

/**
 * The release run: the pin of this server's own release (with retries for
 * registry lag). If that cannot be verified, the newest of at most
 * BUS_PIN_MAX_BACK stable releases below it, never below `min`, that
 * verifies; the result says it is a fallback and for which version. None
 * verifies: no pin (the build fails).
 */
export async function resolvePinWithFallback(
  serverVersion: string,
  deps: PinDeps = {},
  o: Parameters<typeof resolvePinRequired>[2] & {
    min?: string;
    maxBack?: number;
  } = {},
): Promise<PinResult> {
  const own = await resolvePinRequired(serverVersion, deps, o);
  if (own.pin !== null) return own;
  const m = SERVER_VERSION.exec(serverVersion);
  if (!m) return own;
  const base = `${m[1]}.${m[2]}.${m[3]}`;
  const min = o.min ?? BUS_PIN_MIN;
  let published: string[];
  try {
    published = await (deps.versions ?? publishedVersions)();
  } catch (e) {
    return {
      ...own,
      why: `${own.why}; could not list releases to fall back to (${why(e)})`,
    };
  }
  const tried =
    SERVER_VERSION.exec(serverVersion)?.[4] === undefined
      ? base
      : pinVersionFor(serverVersion, published);
  const below = published
    .filter(isVersion)
    .filter((v) => compareVersions(v, base) < 0 && v !== tried)
    .sort(compareVersions)
    .reverse()
    .slice(0, o.maxBack ?? BUS_PIN_MAX_BACK)
    .filter((v) => compareVersions(v, min) >= 0);
  for (const v of below) {
    const r = await resolvePinFor(v, deps);
    if (r.pin === null) continue;
    const reason = `own ${serverVersion} not verified: ${own.why}`;
    return {
      pin: r.pin,
      fallbackFor: serverVersion,
      why: `pinned ${v} as a fallback (${reason})`,
      log: `::warning::bus pin fell back to ${v} (${reason})\n${r.log}`,
    };
  }
  return {
    ...own,
    why: `${own.why}; no release at or above ${min} within ${o.maxBack ?? BUS_PIN_MAX_BACK} below ${base} verified either`,
  };
}

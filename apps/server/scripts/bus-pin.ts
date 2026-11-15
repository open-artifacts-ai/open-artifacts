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

export type BusPkg = { version: string; integrity: string };
export type PinResult =
  | { pin: BusPkg; log: string; why: string }
  | { pin: null; log: string; why: string };

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
    return none(`could not list the published releases (${why(e)})`);
  }
  if (target === null)
    return none(
      `no published stable release at or below server version ${serverVersion}`,
    );
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
    return none(`${PINS.packageName}@${target} was not verified (${why(e)})`);
  }
}

const none = (reason: string): PinResult => ({
  pin: null,
  why: reason,
  log: `bus pin: none (${reason}). This build tells agents the bus cannot be installed from it.`,
});

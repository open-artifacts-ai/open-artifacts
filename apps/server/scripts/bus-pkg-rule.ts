// The release pin of the bus package (#2543): the version and sha512 (npm's
// integrity form) of the tarball the release run packed. The workflow passes
// them from pack-npm's job outputs as BUS_PKG_VERSION and BUS_PKG_SHA512;
// nothing else sets them. Unset (a dev or self-built server): no pin, and
// llms.txt says so instead of showing an install line.
export type BusPkg = { version: string; integrity: string };

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// sha512 is 64 bytes: 88 base64 characters, the last two "==".
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The pin from the environment; null when both are unset or empty; throws on half a pin or a bad one. */
export function busPkgFromEnv(env: {
  BUS_PKG_VERSION?: string | undefined;
  BUS_PKG_SHA512?: string | undefined;
}): BusPkg | null {
  const version = env.BUS_PKG_VERSION?.trim() ?? "";
  const integrity = env.BUS_PKG_SHA512?.trim() ?? "";
  if (version === "" && integrity === "") return null;
  if (!VERSION.test(version))
    throw new Error(`BUS_PKG_VERSION is not x.y.z: ${JSON.stringify(version)}`);
  if (!INTEGRITY.test(integrity))
    throw new Error("BUS_PKG_SHA512 is not a sha512-<base64> integrity");
  return { version, integrity };
}

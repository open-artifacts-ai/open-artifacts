import { compareVersions } from "@oa/provision/versions";

// R4 and R5 refuse an explicit release newer than the platform's own
// (release_ahead_of_platform, #1382), and every explicit release while the
// platform has none (R16 `platform: null`). Pickers disable those items.

/**
 * Whether R16's `platform` rules `version` out. `undefined` (releases still
 * loading) rules nothing out; `null` (no stable platform release) rules out all.
 */
export const aheadOfPlatform = (
  version: string,
  platform: string | null | undefined,
) =>
  platform === null ||
  (platform !== undefined && compareVersions(version, platform) > 0);

/** The reason beside a release that is newer than the platform. */
export const aheadReason = (platform: string) =>
  `Newer than the platform (${platform}). Not deployed yet.`;

/** The newest of `versions`, if any. */
export const newestVersion = (versions: string[]) =>
  versions.reduce<string | undefined>(
    (best, v) =>
      best === undefined || compareVersions(v, best) > 0 ? v : best,
    undefined,
  );

// Everything the updater trusts, as constants. Nothing here is read from the
// environment, install.json, machine.json or any setting, and a test greps the
// update/ sources to keep it so. A change to a pin is a reviewed code change.

export const PINS = {
  registry: "https://registry.npmjs.org",
  registryHost: "registry.npmjs.org",
  packageName: "@open-artifacts/bus",
  // The npm purl name of the package (the in-toto subject name is
  // `pkg:npm/%40open-artifacts/bus@<version>`).
  purlName: "pkg:npm/%40open-artifacts/bus",
  repoUrl: "https://github.com/open-artifacts-ai/open-artifacts",
  // Ids survive a rename of the repository or the organisation (#2473); the
  // URL is only a second check.
  repoId: "1424382782",
  ownerId: "344620586",
  ownerUrl: "https://github.com/open-artifacts-ai",
  workflowPath: ".github/workflows/release-please.yml",
  // Exactly this ref, not a tag: the release workflow publishes from main.
  ref: "refs/heads/main",
  trigger: "push",
  oidcIssuer: "https://token.actions.githubusercontent.com",
  runnerEnvironment: "github-hosted",
  builderId: "https://github.com/actions/runner/github-hosted",
  predicateType: "https://slsa.dev/provenance/v1",
  statementType: "https://in-toto.io/Statement/v1",
  payloadType: "application/vnd.in-toto+json",
  tarballName: "bus",
} as const;

export type Pins = { readonly [K in keyof typeof PINS]: string };

// A release carries `oaBus.commit` in its package.json from the first release
// that includes PR 0 (#2552); a tag field is never read. Until then it is optional; once
// present it must match. PR 6 sets this to that first release; "999.0.0" means
// "not required for any release that exists today".
export const MIN_COMMIT_VERSION = "999.0.0";

// Strict x.y.z: no prefix, suffix, leading zeros, whitespace or non-ASCII digits.
export const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const LIMITS = {
  maxVersionLength: 32,
  maxTarballBytes: 20 * 1024 * 1024,
  maxUnpackedBytes: 100 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxEntries: 2000,
  maxAttestationBytes: 1024 * 1024,
  maxRedirects: 3,
  timeoutMs: 60_000,
} as const;

export function isVersion(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= LIMITS.maxVersionLength &&
    VERSION_RE.test(v)
  );
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

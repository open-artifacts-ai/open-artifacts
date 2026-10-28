// T19's version gate (no Playwright, no env reads: tested in
// test/t19-gate.test.ts). A flow that ships in a later release skips on an
// older rl-a, but only on an unpinned run: the gate run (T19_EXPECT_VERSION
// set) tests one release candidate, so a flow it can't run is a failure.

/** Semver order of two x.y.z versions (a prerelease suffix is ignored). */
export const below = (v: string, min: string): boolean => {
  const n = (s: string) => (s.split(/[-+]/)[0] ?? "").split(".").map(Number);
  const [a, b] = [n(v), n(min)];
  for (let i = 0; i < 3; i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/**
 * Whether `flow` (needing `min`) runs on rl-a at `version`: null to run, or
 * the reason to skip. Pinned (`pin` non-empty) and too old, it throws.
 */
export function gate(
  flow: string,
  min: string,
  version: string,
  pin: string | undefined,
): string | null {
  if (!below(version, min)) return null;
  if (pin)
    throw new Error(`T19 gate: ${flow} needs ${min}, rl-a is ${version}`);
  return `needs ${min}`;
}

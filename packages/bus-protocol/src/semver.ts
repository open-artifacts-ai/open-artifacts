/**
 * `a >= b` on numeric major.minor.patch. Build metadata (`+...`) is ignored;
 * a pre-release (`-...`) ranks below its release, and two pre-releases of the
 * same version compare equal. Malformed input (either side) returns false, so
 * a version gate fails closed: an additive wire field is withheld.
 *
 * The pattern for version-gating an additive field once a daemon is
 * published: the hub stores `hello.client_version` and sends the field only
 * when `semverGte(client_version, <first version that decodes it>)`.
 */
export function semverGte(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return false;
  for (let i = 0; i < 3; i++)
    if (x.n[i] !== y.n[i]) return (x.n[i] as number) > (y.n[i] as number);
  return !x.pre || y.pre;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parse(v: string): { n: number[]; pre: boolean } | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  const n = [m[1], m[2], m[3]].map(Number);
  if (!n.every(Number.isSafeInteger)) return null;
  return { n, pre: m[4] !== undefined };
}

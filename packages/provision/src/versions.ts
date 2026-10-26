// Release version order, with no Node import, so the scheduler (workerd)
// can share it (@oa/provision/versions).
export const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Semver order (prerelease below its release); throws on a non-semver string. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(String(a));
  const pb = SEMVER.exec(String(b));
  if (!pa || !pb)
    throw new Error(
      `not a release version: ${JSON.stringify(String(pa ? b : a)).slice(0, 40)}`,
    );
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined)
    return ra === rb ? 0 : ra === undefined ? 1 : -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const u = xa[i];
    const v = xb[i];
    if (u === undefined) return -1;
    if (v === undefined) return 1;
    const nu = /^\d+$/.test(u);
    const nv = /^\d+$/.test(v);
    if (nu && nv && Number(u) !== Number(v))
      return Math.sign(Number(u) - Number(v));
    if (nu !== nv) return nu ? -1 : 1;
    if (u !== v) return u < v ? -1 : 1;
  }
  return 0;
}

export const isReleaseVersion = (v: unknown): v is string =>
  typeof v === "string" && SEMVER.test(v);

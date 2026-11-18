// #2624: the first bus release with `oa-bus skill` is the lowest release whose
// CHANGELOG section cites #2624. Read at build time by emit-version.ts, so no
// one has to guess the version the merge queue will land in.

/** The lowest x.y.z release whose CHANGELOG section cites `ref`, or null. */
export function firstReleaseCiting(
  changelog: string,
  ref: string,
): string | null {
  const cite = new RegExp(`${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  let best: number[] | null = null;
  for (const part of changelog.split(/\n(?=## \[)/)) {
    const v = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(part);
    if (!v || !cite.test(part)) continue;
    const n = [Number(v[1]), Number(v[2]), Number(v[3])];
    if (best === null || cmp(n, best) < 0) best = n;
  }
  return best === null ? null : best.join(".");
}

const cmp = (a: number[], b: number[]): number => {
  for (let i = 0; i < 3; i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
};

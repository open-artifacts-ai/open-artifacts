// Seeded property-test helpers: every run draws the same cases, so a failure
// names its seed and case index and replays exactly.

/** Fixed seed for the 4.1 hash-compare property tests. */
export const PROP_SEED = 0x4f41_0401;
export const PROP_CASES = 1000;
/**
 * Worst measured wall time of one case of the costliest PROP_CASES loop (the
 * bearer property in tokens.test.ts), on a loaded host: the provisioning
 * package run with its files in parallel plus 4 CPU hogs, load average 23-63
 * on 24 cores, 20 runs of 10.1-27.5 s per 1000 cases. Two real local-D1
 * queries per case dominate (7-12 ms each under that load); its four SHA-256
 * digests cost about 0.02 ms each. The mint property makes no real D1 query
 * per case, so this bounds it too.
 */
export const PROP_CASE_MS = 28;
/**
 * Slack over PROP_CASE_MS for a runner slower than the worst one measured;
 * the measured runs already spread 2.7x.
 */
export const PROP_HEADROOM = 3;
/**
 * Per-test timeout for a PROP_CASES loop, from its own work: cases x worst
 * per-case cost x headroom (84 s). A hang still fails in under 2 minutes.
 */
export const PROP_TIMEOUT_MS = PROP_CASES * PROP_CASE_MS * PROP_HEADROOM;

/** mulberry32: a small deterministic PRNG in [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";

export const pick = (r: () => number, s: string) =>
  s[Math.floor(r() * s.length)] as string;
export const draw = (r: () => number, alphabet: string, n: number) =>
  Array.from({ length: n }, () => pick(r, alphabet)).join("");

/** A well-formed 43-char base64url secret (an oat_ body or a sid). */
export const secret43 = (r: () => number) => draw(r, B64URL, 43);

/**
 * A stored hash that differs from `h`: one changed hex digit, upper-cased,
 * truncated, extended, a shared prefix with a new tail, or wholly new. Never
 * equal to `h` (the caller asserts it too).
 */
export function otherHash(r: () => number, h: string): string {
  for (;;) {
    const i = Math.floor(r() * h.length);
    const k = Math.floor(r() * 6);
    let c: string;
    if (k === 0) {
      const d = HEX.replace(h[i] as string, "");
      c = h.slice(0, i) + pick(r, d) + h.slice(i + 1);
    } else if (k === 1) c = h.toUpperCase();
    else if (k === 2) c = h.slice(0, i);
    else if (k === 3) c = h + pick(r, HEX);
    else if (k === 4) c = h.slice(0, i) + draw(r, HEX, h.length - i);
    else c = draw(r, HEX, h.length);
    if (c !== h) return c;
  }
}

/** A different hex digit for the last position (deterministic). */
export const flipLast = (h: string) =>
  h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

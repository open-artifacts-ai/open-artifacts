// Seeded property-test helpers: every run draws the same cases, so a failure
// names its seed and case index and replays exactly.

/** Fixed seed for the 4.1 hash-compare property tests. */
export const PROP_SEED = 0x4f41_0401;
export const PROP_CASES = 1000;
/**
 * Per-test timeout for a PROP_CASES loop. Each case is CPU-bound (two sha256
 * lookups, no I/O wait): about 1.2 s locally, over vitest's 5 s default on a
 * busy CI runner. 60 s leaves 50x headroom without hiding a hang.
 */
export const PROP_TIMEOUT_MS = 60_000;

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

import { ANCHOR_LIMITS, type BlockHint, type TextAnchor } from "./anchor.js";

// Pure text anchoring over a flat string (UTF-16 offsets, as in JS strings).
// No DOM, no dependencies. The runtime maps DOM ranges to these offsets.

/** Characters of context kept on each side of the quote. */
export const CONTEXT_CHARS = 32;
/** Shortest context probe tried when the full context was edited. */
const MIN_PROBE = 8;
/** Occurrence lists are capped so a degenerate needle stays linear. */
const MAX_OCCURRENCES = 20000;

/**
 * Partial-match threshold: a surviving piece of the quote counts only if it is
 * at least max(8, 30% of the quote) characters. A quote of 8 or fewer
 * characters therefore has no partial state: it is whole or collapsed.
 */
export function minSurvivingChars(exactLength: number): number {
  return Math.max(8, Math.ceil(exactLength * 0.3));
}

export type Resolution =
  | { state: "exact"; start: number; end: number }
  | { state: "partial"; start: number; end: number }
  | { state: "collapsed"; at: number }
  | { state: "orphan" };

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Move an offset off the middle of a surrogate pair (toward `dir`). */
function snap(text: string, i: number, dir: 1 | -1): number {
  if (
    i > 0 &&
    i < text.length &&
    isLow(text.charCodeAt(i)) &&
    isHigh(text.charCodeAt(i - 1))
  ) {
    return i + (dir === 1 ? 1 : -1);
  }
  return i;
}

/**
 * Build an anchor for text[start, end). Offsets are clamped and moved off
 * surrogate pairs. A quote longer than the schema cap is cut to the cap; the
 * context then follows the cut end so the anchor stays self-consistent.
 */
export function createTextAnchor(
  text: string,
  start: number,
  end: number,
  version: number,
  block?: BlockHint,
): TextAnchor {
  let s = snap(text, Math.max(0, Math.min(start, text.length)), -1);
  let e = snap(text, Math.max(s, Math.min(end, text.length)), 1);
  if (e - s > ANCHOR_LIMITS.exact) e = snap(text, s + ANCHOR_LIMITS.exact, -1);
  if (e <= s) throw new RangeError("createTextAnchor: empty selection");
  s = Math.max(0, s);
  const ps = snap(text, Math.max(0, s - CONTEXT_CHARS), 1);
  const se = snap(text, Math.min(text.length, e + CONTEXT_CHARS), -1);
  const anchor: TextAnchor = {
    kind: "text",
    version,
    exact: text.slice(s, e),
    prefix: text.slice(ps, s),
    suffix: text.slice(e, se),
  };
  if (block && Object.keys(block).length > 0) anchor.block = block;
  return anchor;
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < MAX_OCCURRENCES) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

const commonSuffix = (a: string, aEnd: number, b: string): number => {
  let n = 0;
  while (
    n < b.length &&
    n < aEnd &&
    a.charCodeAt(aEnd - 1 - n) === b.charCodeAt(b.length - 1 - n)
  )
    n++;
  return n;
};
const commonPrefix = (a: string, aStart: number, b: string): number => {
  let n = 0;
  while (
    n < b.length &&
    aStart + n < a.length &&
    a.charCodeAt(aStart + n) === b.charCodeAt(n)
  )
    n++;
  return n;
};

/** Newline offsets, built once per resolve and only when a tie needs them. */
function lineOf(text: string): (offset: number) => number {
  let nl: number[] | null = null;
  return (offset) => {
    if (!nl) {
      nl = [];
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
        nl.push(i);
    }
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/** Best whole-quote match: context score, then block line, then earliest. */
function pickExact(
  text: string,
  starts: number[],
  len: number,
  prefix: string,
  suffix: string,
  line: number | undefined,
): number {
  let best = starts[0];
  let bestScore = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  const getLine = lineOf(text);
  for (const s of starts) {
    const score =
      commonSuffix(text, s, prefix) + commonPrefix(text, s + len, suffix);
    if (score < bestScore) continue;
    const dist = line === undefined ? 0 : Math.abs(getLine(s) - line);
    if (score > bestScore || dist < bestDist) {
      best = s;
      bestScore = score;
      bestDist = dist;
    }
  }
  return best;
}

/** Whitespace runs collapsed to one space, with a map back to text offsets. */
function normalize(text: string): { norm: string; map: Int32Array } {
  const map = new Int32Array(text.length + 1);
  const out: string[] = [];
  let n = 0;
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const ws = /\s/.test(text[i]);
    if (ws && inWs) continue;
    inWs = ws;
    out.push(ws ? " " : text[i]);
    map[n++] = i;
  }
  map[n] = text.length;
  return { norm: out.join(""), map };
}
const squash = (s: string) => s.replace(/\s+/g, " ");

/** Probe lengths for edited context: the full string, then 16, then 8 chars. */
function probes(n: number): number[] {
  const out = [n];
  for (const p of [16, MIN_PROBE])
    if (p < out[out.length - 1] && p <= n) out.push(p);
  return out;
}

/** Offsets where the prefix ends; "" means the document start. */
function findBefore(text: string, prefix: string): number[] {
  if (prefix === "") return [0];
  for (const len of probes(prefix.length)) {
    const hits = occurrences(text, prefix.slice(prefix.length - len));
    if (hits.length) return hits.map((h) => h + len);
  }
  return [];
}
/** Offsets where the suffix starts; "" means the document end. */
function findAfter(text: string, suffix: string): number[] {
  if (suffix === "") return [text.length];
  for (const len of probes(suffix.length)) {
    const hits = occurrences(text, suffix.slice(0, len));
    if (hits.length) return hits;
  }
  return [];
}

/** Longest common substring of region and needle; earliest in region on ties. */
function longestCommon(
  text: string,
  from: number,
  to: number,
  needle: string,
): { start: number; len: number } {
  const m = needle.length;
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  let bestLen = 0;
  let bestEnd = from;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    for (let j = 1; j <= m; j++) {
      if (c === needle.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1;
        cur[j] = v;
        if (v > bestLen) {
          bestLen = v;
          bestEnd = i + 1;
        }
      } else cur[j] = 0;
    }
    [prev, cur] = [cur, prev];
  }
  return { start: bestEnd - bestLen, len: bestLen };
}

/**
 * Re-find an anchor in `text`. Deterministic; the work is one indexOf scan for
 * the quote, then a bounded local comparison (at most about 3 quote lengths
 * of text against the quote), never a whole-document DP.
 *
 * - exact: the whole quote is present (also when only whitespace runs changed).
 *   Several matches are told apart by prefix/suffix agreement, then by
 *   block.line, then the earliest.
 * - partial: no whole quote, but a piece of at least minSurvivingChars(...)
 *   sits where the prefix/suffix say the quote was.
 *   Among several context pairs, the one whose gap is closest to the quote's
 *   old length wins (a replacement is usually about as long), then the earliest.
 * - collapsed: nothing of the quote, but the old spot is found from the
 *   prefix and/or suffix. `at` is the offset where the quote used to start.
 * - orphan: neither quote nor spot.
 * block.path and block.page are not used here (flat text has no blocks).
 */
export function resolveTextAnchor(
  text: string,
  anchor: TextAnchor,
): Resolution {
  const { exact, prefix, suffix } = anchor;
  const len = exact.length;
  if (len === 0) return { state: "orphan" };

  const hits = occurrences(text, exact);
  if (hits.length) {
    const s = pickExact(text, hits, len, prefix, suffix, anchor.block?.line);
    return { state: "exact", start: s, end: s + len };
  }

  // Whitespace-only edits: compare with runs of whitespace collapsed.
  const { norm, map } = normalize(text);
  const nExact = squash(exact);
  const nHits = occurrences(norm, nExact);
  if (nHits.length) {
    const nLen = nExact.length;
    const s = pickExact(
      norm,
      nHits,
      nLen,
      squash(prefix),
      squash(suffix),
      undefined,
    );
    const start = map[s];
    const end = map[s + nLen - 1] + 1;
    return { state: "exact", start, end };
  }

  const ends = findBefore(text, prefix); // offsets where the prefix ends
  const starts = findAfter(text, suffix); // offsets where the suffix starts
  const window = 3 * len + 64;

  let from = -1;
  let to = -1;
  let at = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of ends) {
    // first suffix start at or after p (starts is ascending)
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    const miss =
      lo < starts.length ? Math.abs(starts[lo] - p - len) : window + 1;
    if (lo < starts.length && starts[lo] - p <= window && miss < bestGap) {
      bestGap = miss;
      from = p;
      to = starts[lo];
    }
  }
  if (from === -1) {
    if (ends.length) {
      at = ends[0];
      from = at;
      to = Math.min(text.length, at + window);
    } else if (starts.length) {
      at = starts[0];
      to = at;
      from = Math.max(0, at - window);
    } else return { state: "orphan" };
  } else at = from;

  if (to > from) {
    const { start, len: n } = longestCommon(text, from, to, exact);
    let s = start;
    let e = start + n;
    s = snap(text, s, 1);
    e = snap(text, e, -1);
    if (e - s >= minSurvivingChars(len))
      return { state: "partial", start: s, end: e };
  }
  return { state: "collapsed", at };
}

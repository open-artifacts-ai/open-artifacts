import { ANCHOR_LIMITS, type BlockHint, type TextAnchor } from "./anchor.js";

// Pure text anchoring over a flat string (UTF-16 offsets, as in JS strings).
// No DOM, no dependencies. The runtime maps DOM ranges to these offsets.

/** Characters of context kept on each side of the quote. */
export const CONTEXT_CHARS = 32;
/** Shortest context probe tried when the full context was edited. */
const MIN_PROBE = 8;
/** Quotes shorter than this need context agreement or word boundaries to count as exact. */
const SHORT_QUOTE = 16;
/** Most char comparisons the partial-match step may spend on one anchor. */
const LCS_BUDGET = 2_000_000;
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

/** Non-space characters of the matched context. */
const solid = (s: string) => s.replace(/\s+/g, "").length;

const WORD = /[\p{L}\p{N}_]/u;
/** A quote that starts or ends on a word character must not be inside a longer word. */
function bounded(hay: string, s: number, e: number): boolean {
  const first = hay[s];
  const last = hay[e - 1];
  if (first && WORD.test(first) && s > 0 && WORD.test(hay[s - 1])) return false;
  if (last && WORD.test(last) && e < hay.length && WORD.test(hay[e]))
    return false;
  return true;
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
 * A resolver for one text. Build it once per text version: the whitespace-
 * normalized copy and the line index are made lazily, once, and shared by
 * every anchor resolved through it.
 */
export function createTextResolver(
  text: string,
): (anchor: TextAnchor) => Resolution {
  let normed: { norm: string; map: Int32Array } | undefined;
  const getNorm = () => {
    if (!normed) normed = normalize(text);
    return normed;
  };
  const getLine = lineOf(text);

  return (anchor) => {
    const { exact, prefix, suffix } = anchor;
    const len = exact.length;
    if (len === 0) return { state: "orphan" };
    const wantLine = anchor.block?.line;
    const short = len < SHORT_QUOTE;
    const need = Math.min(3, solid(prefix) + solid(suffix));

    // Where the context says the quote was. An empty side says nothing; a
    // short probe counts only if unique or nearest the block line hint.
    const nearest = (hits: number[]): number | undefined => {
      if (wantLine === undefined) return undefined;
      let best: number | undefined;
      let bestD = Number.POSITIVE_INFINITY;
      for (const h of hits) {
        const d = Math.abs(getLine(h) - wantLine);
        if (d < bestD) {
          best = h;
          bestD = d;
        }
      }
      return best;
    };
    const locate = (
      needleOf: (len: number) => string,
      full: number,
      endOf: (hit: number, len: number) => number,
    ) => {
      for (const l of probes(full)) {
        const hits = occurrences(text, needleOf(l));
        if (!hits.length) continue;
        if (l === full && l >= 16) return hits.map((h) => endOf(h, l));
        if (hits.length === 1) return [endOf(hits[0], l)];
        const n = nearest(hits);
        if (n !== undefined) return [endOf(n, l)];
      }
      return [];
    };
    let spots: { ends: number[]; starts: number[] } | undefined;
    const getSpots = () => {
      if (spots) return spots;
      let ends = prefix
        ? locate(
            (l) => prefix.slice(prefix.length - l),
            prefix.length,
            (h, l) => h + l,
          )
        : [];
      let starts = suffix
        ? locate(
            (l) => suffix.slice(0, l),
            suffix.length,
            (h) => h,
          )
        : [];
      starts.sort((a, b) => a - b);
      if (prefix === "" && starts.length === 0) ends = [0];
      if (suffix === "" && ends.length === 0) starts = [text.length];
      spots = { ends, starts };
      return spots;
    };

    // 1. The whole quote, as written or with whitespace runs collapsed.
    let hay = text;
    let hlen = len;
    let pre = prefix;
    let suf = suffix;
    let map: Int32Array | undefined;
    let hits = occurrences(text, exact);
    if (!hits.length) {
      const n = getNorm();
      const nExact = squash(exact);
      hits = occurrences(n.norm, nExact);
      if (hits.length) {
        hay = n.norm;
        hlen = nExact.length;
        pre = squash(prefix);
        suf = squash(suffix);
        map = n.map;
      }
    }
    if (hits.length) {
      let best: { s: number; score: number; dist: number } | undefined;
      for (const s of hits) {
        const ps = commonSuffix(hay, s, pre);
        const ss = commonPrefix(hay, s + hlen, suf);
        const score =
          solid(pre.slice(pre.length - ps)) + solid(suf.slice(0, ss));
        if (short && score < need && !bounded(hay, s, s + hlen)) continue;
        const dist =
          wantLine === undefined
            ? 0
            : Math.abs(getLine(map ? map[s] : s) - wantLine);
        if (
          !best ||
          score > best.score ||
          (score === best.score && dist < best.dist)
        ) {
          best = { s, score, dist };
        }
      }
      if (best) {
        const weak = short && best.score < need;
        const elsewhere =
          weak && (getSpots().ends.length > 0 || getSpots().starts.length > 0);
        if (!elsewhere) {
          const { s } = best;
          if (!map) return { state: "exact", start: s, end: s + hlen };
          return { state: "exact", start: map[s], end: map[s + hlen - 1] + 1 };
        }
      }
    }

    // 2. Locate the old spot from the context.
    const { ends, starts } = getSpots();
    const window = 2 * len + 64;
    let from = -1;
    let to = -1;
    let at = -1;
    let paired = false;
    let bestMiss = Number.POSITIVE_INFINITY;
    for (const p of ends) {
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] < p) lo = mid + 1;
        else hi = mid;
      }
      if (lo === starts.length) continue;
      const gap = starts[lo] - p;
      const miss = Math.abs(gap - len);
      if (gap <= 3 * len + 64 && miss < bestMiss) {
        bestMiss = miss;
        from = p;
        to = starts[lo];
        paired = true;
      }
    }
    if (!paired) {
      const cap = Math.min(window, Math.floor(LCS_BUDGET / len));
      if (ends.length) {
        from = ends[0];
        to = Math.min(text.length, from + cap);
      } else if (starts.length) {
        to = starts[0];
        from = Math.max(0, to - cap);
      } else return { state: "orphan" };
      at = ends.length ? ends[0] : starts[0];
    } else at = from;

    // 3. What survives of the quote near that spot (skipped over budget).
    if (to > from && (to - from) * len <= LCS_BUDGET) {
      const { start, len: n } = longestCommon(text, from, to, exact);
      const s = snap(text, start, 1);
      const e = snap(text, start + n, -1);
      if (e - s >= minSurvivingChars(len))
        return { state: "partial", start: s, end: e };
    }
    return { state: "collapsed", at };
  };
}

/**
 * Re-find an anchor in `text` (use createTextResolver for many anchors on one
 * text). Deterministic; one indexOf scan for the quote, then a bounded local
 * comparison, never a whole-document DP.
 *
 * - exact: the whole quote is present (also when only whitespace runs changed).
 *   Several matches are told apart by prefix/suffix agreement, then by
 *   block.line, then the earliest. A short quote (under 16 chars) that agrees
 *   with none of its context, while that context is found elsewhere, is not
 *   taken: it is probably other text (the same word in another place), so the
 *   result is partial or collapsed at the context. A short quote inside a
 *   longer word ("art" in "start") never counts as a whole-quote match unless
 *   its context agrees.
 * - partial: no whole quote, but a piece of at least minSurvivingChars(...)
 *   sits where the prefix/suffix say the quote was. Among several context
 *   pairs, the one whose gap is closest to the quote's old length wins. The
 *   comparison spends at most 2M char comparisons; over that it is skipped and
 *   the result is collapsed.
 * - collapsed: nothing of the quote, but the old spot is found from the
 *   prefix and/or suffix. `at` is the offset where the quote used to start.
 *   An empty prefix or suffix (a document edge) says nothing while the other
 *   side can be found. A shortened (16 or 8 char) context probe counts only
 *   if it is unique, or nearest the block.line hint.
 * - orphan: neither quote nor spot.
 * block.path and block.page are not used here (flat text has no blocks).
 */
export function resolveTextAnchor(
  text: string,
  anchor: TextAnchor,
): Resolution {
  return createTextResolver(text)(anchor);
}

import type { Node as PMNode } from "prosemirror-model";

/**
 * The text a person sees in a doc, with no Markdown symbols: every non-empty
 * textblock's text in document order, one line break between blocks. Kept as
 * one string plus a small table per block (not one entry per character), so
 * building it for a doc at the size cap takes a few milliseconds.
 */
export interface VisibleText {
  text: string;
  /** Index in `text` where each block's text starts. */
  starts: number[];
  /** ProseMirror position of each block's first character. */
  at: number[];
  /** Each block's text length. */
  lens: number[];
  /** A rule or empty block lies between this block and the one before it. */
  hiddenBefore: boolean[];
}

/** posAt value of a line break between two blocks. */
export const BREAK = -1;
/** posAt value of a line break with a rule or empty block between its blocks. */
export const HIDDEN_BREAK = -2;

export function visibleText(doc: PMNode): VisibleText {
  const parts: string[] = [];
  const starts: number[] = [];
  const at: number[] = [];
  const lens: number[] = [];
  const hiddenBefore: boolean[] = [];
  let length = 0;
  // A rule or an empty block shows no text; a quote spanning one would
  // delete it unseen, so its break is marked and matches over it are refused.
  let hidden = false;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      if (node.isBlock && node.isLeaf) hidden = true;
      return true;
    }
    // Slice-1 textblocks hold only text nodes, so character i sits at pos+1+i.
    const text = node.textContent;
    if (text.length === 0) {
      hidden = true;
      return false;
    }
    if (parts.length > 0) {
      parts.push("\n");
      length += 1;
    }
    hiddenBefore.push(hidden && parts.length > 0);
    hidden = false;
    starts.push(length);
    at.push(pos + 1);
    lens.push(text.length);
    parts.push(text);
    length += text.length;
    return false;
  });
  return { text: parts.join(""), starts, at, lens, hiddenBefore };
}

// The block holding text index i: the last one starting at or before i.
function blockOf(vt: VisibleText, i: number): number {
  let lo = 0;
  let hi = vt.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vt.starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The ProseMirror position of the character at text index i, or BREAK or
 * HIDDEN_BREAK for a line break between blocks.
 */
export function posAt(vt: VisibleText, i: number): number {
  const b = blockOf(vt, i);
  const offset = i - vt.starts[b];
  if (offset < vt.lens[b]) return vt.at[b] + offset;
  return vt.hiddenBefore[b + 1] ? HIDDEN_BREAK : BREAK;
}

/**
 * Line endings to "\n", and line breaks at either end dropped together with
 * the spaces around them ("target.\n " is "target.").
 */
export function normalizeQuote(quote: string): string {
  return quote
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*\n\s*/, "")
    .replace(/\s*\n[ \t]*$/, "");
}

/** The most matches counted; more than this is ambiguous all the same. */
const MAX_MATCHES = 50;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A run of line breaks in a quote, with the spaces around it, matches one or
// more line breaks in the doc: an agent copying from the Markdown sees a blank
// line between blocks where the visible text has one break.
function pattern(text: string): string {
  return text
    .split(/[ \t]*\n\s*/)
    .map(escapeRegExp)
    .join("\\n+");
}

export interface QuoteMatch {
  /** ProseMirror range of the quoted text. */
  from: number;
  to: number;
}

export type QuoteLookup =
  | { kind: "found"; match: QuoteMatch }
  | { kind: "not_found"; closest: string | null; withoutContext: number }
  | { kind: "ambiguous"; matches: number }
  | { kind: "spans_hidden" };

interface Span {
  index: number;
  end: number;
}

// Every place the quote's text occurs, overlapping ones too, at most
// MAX_MATCHES that pass `accept`. A quote with no line break is a plain
// substring; one with breaks matches a run of breaks as one (see pattern()).
function matchesOf(
  text: string,
  quote: string,
  accept: (index: number, end: number) => boolean,
): Span[] {
  const out: Span[] = [];
  if (!quote.includes("\n")) {
    for (
      let at = text.indexOf(quote);
      at >= 0;
      at = text.indexOf(quote, at + 1)
    ) {
      if (accept(at, at + quote.length))
        out.push({ index: at, end: at + quote.length });
      if (out.length >= MAX_MATCHES) break;
    }
    return out;
  }
  const re = new RegExp(pattern(quote), "gu");
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    // Overlapping matches count too ("aa" twice in "aaa").
    re.lastIndex = m.index + 1;
    if (m[0].length === 0) continue;
    const end = m.index + m[0].length;
    if (accept(m.index, end)) out.push({ index: m.index, end });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

// A prefix or suffix is checked at a match, not searched for: a plain compare
// when it has no line break, else a regex over a bounded slice beside it.
function endsAt(text: string, index: number, prefix: string): boolean {
  if (!prefix.includes("\n")) {
    return (
      index >= prefix.length && text.startsWith(prefix, index - prefix.length)
    );
  }
  const room = prefix.length * 4 + 64;
  const re = new RegExp(`(?:${pattern(prefix)})$`, "u");
  return re.test(text.slice(Math.max(0, index - room), index));
}

function startsAt(text: string, end: number, suffix: string): boolean {
  if (!suffix.includes("\n")) return text.startsWith(suffix, end);
  const room = suffix.length * 4 + 64;
  const re = new RegExp(`^(?:${pattern(suffix)})`, "u");
  return re.test(text.slice(end, end + room));
}

/**
 * Find a quote in the visible text. `prefix` must end right before the quote
 * and `suffix` must start right after it; both are optional and pick one of
 * several matches.
 */
export function findQuote(
  doc: PMNode,
  quote: string,
  prefix?: string,
  suffix?: string,
): QuoteLookup {
  const vt = visibleText(doc);
  const { text } = vt;
  const q = normalizeQuote(quote);
  const pre = prefix ? prefix.replace(/\r\n?/g, "\n") : "";
  const suf = suffix ? suffix.replace(/\r\n?/g, "\n") : "";
  // A match must start and end on a character, never on a block break.
  const onText = (index: number, end: number) =>
    posAt(vt, index) >= 0 && posAt(vt, end - 1) >= 0;
  const found = matchesOf(
    text,
    q,
    (index, end) =>
      (!pre || endsAt(text, index, pre)) &&
      (!suf || startsAt(text, end, suf)) &&
      onText(index, end),
  );
  if (found.length === 1) {
    const { index, end } = found[0];
    const last = blockOf(vt, end - 1);
    for (let b = blockOf(vt, index) + 1; b <= last; b++) {
      if (vt.hiddenBefore[b]) return { kind: "spans_hidden" };
    }
    return {
      kind: "found",
      match: { from: posAt(vt, index), to: posAt(vt, end - 1) + 1 },
    };
  }
  if (found.length > 1) return { kind: "ambiguous", matches: found.length };
  if (pre || suf) {
    // The quote is there, but not with this prefix or suffix: show where it is.
    const bare = matchesOf(text, q, onText);
    if (bare.length > 0) {
      const { index, end } = bare[0];
      return {
        kind: "not_found",
        closest: around(text, index, end, 30),
        withoutContext: bare.length,
      };
    }
  }
  return {
    kind: "not_found",
    closest: closestText(text, q),
    withoutContext: 0,
  };
}

function around(text: string, start: number, end: number, pad: number) {
  return widen(
    text,
    Math.max(0, start - pad),
    Math.min(text.length, end + pad),
  );
}

// Grow [start, end) to whole words, so the closest text reads naturally.
function widen(text: string, start: number, end: number): string {
  let s = start;
  let e = end;
  while (s > 0 && /\S/.test(text[s - 1]) && start - s < 40) s--;
  while (e < text.length && /\S/.test(text[e]) && e - end < 40) e++;
  return text.slice(s, e).trim();
}

const SEED = 6;
const SEEDS = 8;
const HITS_PER_SEED = 16;
const FALLBACK_SCAN = 64_000;

// How many character pairs of the quote sit in hay[start, start + n).
function overlapAt(
  hay: string,
  start: number,
  n: number,
  want: Map<string, number>,
): number {
  const have = new Map<string, number>();
  let overlap = 0;
  for (let i = start; i < start + n - 1; i++) {
    const b = hay.slice(i, i + 2);
    const h = have.get(b) ?? 0;
    if (h < (want.get(b) ?? 0)) overlap++;
    have.set(b, h + 1);
  }
  return overlap;
}

/**
 * The stretch of the doc's visible text most like the quote, by shared
 * character pairs (Dice coefficient) over windows as long as the quote. Only
 * windows around short pieces of the quote found in the text are scored (a few
 * dozen, each at most the quote's length, which is capped), so the cost is a
 * handful of substring searches however long the doc is. A quote with no piece
 * in the doc is scored against the first stretch of it. Null for an empty doc.
 */
export function closestText(text: string, quote: string): string | null {
  if (text.length === 0) return null;
  const hay = text.toLowerCase();
  const needle = quote.toLowerCase();
  const n = needle.length;
  if (n < 2 || hay.length <= n) {
    const i = n > 0 ? hay.indexOf(needle) : -1;
    if (i >= 0) return around(text, i, i + n, 30);
    return widen(text, 0, Math.min(text.length, Math.max(n, 1)));
  }
  const want = new Map<string, number>();
  for (let i = 0; i < n - 1; i++) {
    const b = needle.slice(i, i + 2);
    want.set(b, (want.get(b) ?? 0) + 1);
  }
  const starts = new Set<number>();
  const seed = Math.min(SEED, n);
  const last = n - seed;
  for (let k = 0; k < SEEDS; k++) {
    const offset = Math.round((last * k) / (SEEDS - 1));
    const piece = needle.slice(offset, offset + seed);
    let hit = hay.indexOf(piece);
    for (let c = 0; hit >= 0 && c < HITS_PER_SEED; c++) {
      starts.add(Math.min(Math.max(0, hit - offset), hay.length - n));
      hit = hay.indexOf(piece, hit + 1);
    }
  }
  let best = -1;
  let bestStart = 0;
  if (starts.size > 0) {
    for (const start of [...starts].sort((a, b) => a - b)) {
      const overlap = overlapAt(hay, start, n, want);
      if (overlap > best) {
        best = overlap;
        bestStart = start;
      }
    }
  } else {
    const window = hay.slice(0, FALLBACK_SCAN + n);
    const have = new Map<string, number>();
    let overlap = 0;
    const add = (b: string) => {
      const h = have.get(b) ?? 0;
      if (h < (want.get(b) ?? 0)) overlap++;
      have.set(b, h + 1);
    };
    const remove = (b: string) => {
      const h = (have.get(b) ?? 0) - 1;
      have.set(b, h);
      if (h < (want.get(b) ?? 0)) overlap--;
    };
    for (let i = 0; i < n - 1; i++) add(window.slice(i, i + 2));
    best = overlap;
    for (let start = 1; start + n <= window.length; start++) {
      remove(window.slice(start - 1, start + 1));
      add(window.slice(start + n - 2, start + n));
      if (overlap > best) {
        best = overlap;
        bestStart = start;
      }
    }
  }
  return trimWords(widen(text, bestStart, bestStart + n), want, n);
}

function dice(text: string, want: Map<string, number>, n: number): number {
  const have = new Map<string, number>();
  let overlap = 0;
  const t = text.toLowerCase();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    const h = have.get(b) ?? 0;
    if (h < (want.get(b) ?? 0)) overlap++;
    have.set(b, h + 1);
  }
  return (2 * overlap) / (Math.max(t.length - 1, 0) + (n - 1));
}

// The window is as long as the quote, so it can take in a word at either
// end that the quote lacks. Drop end words while that scores better.
function trimWords(text: string, want: Map<string, number>, n: number): string {
  let words = text.split(/(?<=\s)(?=\S)/);
  let score = dice(text, want, n);
  for (;;) {
    let improved = false;
    for (const next of [words.slice(1), words.slice(0, -1)]) {
      if (next.length === 0) continue;
      const s = dice(next.join(""), want, n);
      if (s > score) {
        score = s;
        words = next;
        improved = true;
        break;
      }
    }
    if (!improved) return words.join("").trim();
  }
}

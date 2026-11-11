import type { Node as PMNode } from "prosemirror-model";

/**
 * The text a person sees in a doc, with no Markdown symbols: every non-empty
 * textblock's text in document order, one line break between blocks. `pos`
 * holds the ProseMirror position of each character, or -1 for a line break
 * that separates two blocks.
 */
export interface VisibleText {
  text: string;
  pos: number[];
}

/** pos value of a line break between two blocks. */
export const BREAK = -1;
/** pos value of a line break with a rule or empty block between its blocks. */
export const HIDDEN_BREAK = -2;

export function visibleText(doc: PMNode): VisibleText {
  const parts: string[] = [];
  const pos: number[] = [];
  // A rule or an empty block shows no text; a quote spanning one would
  // delete it unseen, so its break is marked and matches over it are refused.
  let hidden = false;
  doc.descendants((node, at) => {
    if (!node.isTextblock) {
      if (node.isBlock && node.isLeaf) hidden = true;
      return true;
    }
    // Slice-1 textblocks hold only text nodes, so character i sits at at+1+i.
    const text = node.textContent;
    if (text.length === 0) {
      hidden = true;
      return false;
    }
    if (parts.length > 0) {
      parts.push("\n");
      pos.push(hidden ? HIDDEN_BREAK : BREAK);
    }
    hidden = false;
    parts.push(text);
    for (let i = 0; i < text.length; i++) pos.push(at + 1 + i);
    return false;
  });
  return { text: parts.join(""), pos };
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

function matchesOf(
  text: string,
  source: string,
): { index: number; end: number }[] {
  const re = new RegExp(source, "gu");
  const out: { index: number; end: number }[] = [];
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    if (m[0].length === 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push({ index: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES) break;
    // Overlapping matches count too ("aa" twice in "aaa").
    re.lastIndex = m.index + 1;
  }
  return out;
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
  const { text, pos } = visibleText(doc);
  const q = normalizeQuote(quote);
  const body = pattern(q);
  const before = prefix
    ? `(?<=${pattern(prefix.replace(/\r\n?/g, "\n"))})`
    : "";
  const after = suffix ? `(?=${pattern(suffix.replace(/\r\n?/g, "\n"))})` : "";
  // A match must start and end on a character, never on a block break.
  const found = matchesOf(text, before + body + after).filter(
    (m) => pos[m.index] >= 0 && pos[m.end - 1] >= 0,
  );
  if (found.length === 1) {
    const { index, end } = found[0];
    if (pos.slice(index, end).some((p) => p === HIDDEN_BREAK)) {
      return { kind: "spans_hidden" };
    }
    return { kind: "found", match: { from: pos[index], to: pos[end - 1] + 1 } };
  }
  if (found.length > 1) return { kind: "ambiguous", matches: found.length };
  if (before || after) {
    // The quote is there, but not with this prefix or suffix: show where it is.
    const bare = matchesOf(text, body);
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

/**
 * The stretch of the doc's visible text most like the quote, by shared
 * character pairs (Dice coefficient) over a sliding window as long as the
 * quote. Linear in the doc's length. Null for an empty doc.
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
  // Window [start, start + n) holds the n - 1 pairs starting at start .. start + n - 2.
  for (let i = 0; i < n - 1; i++) add(hay.slice(i, i + 2));
  let best = overlap;
  let bestStart = 0;
  for (let start = 1; start + n <= hay.length; start++) {
    remove(hay.slice(start - 1, start + 1));
    add(hay.slice(start + n - 2, start + n));
    if (overlap > best) {
      best = overlap;
      bestStart = start;
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

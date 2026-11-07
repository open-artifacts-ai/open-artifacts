// Map a DOM Range inside `root` to and from flat text offsets (#682). The flat
// text is every text node under root in document order, concatenated, minus
// script, style, noscript, template and textarea contents; it is
// the string @oa/shared's createTextAnchor/resolveTextAnchor work on.

// Text that is never page content: code, templates and form values.
const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "textarea",
]);

function skipped(node: Node): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) {
    // localName: lowercase for HTML and SVG elements alike.
    if (SKIPPED.has((p as Element).localName)) return true;
  }
  return false;
}

// Elements that break a line. The server builds the text it checks a quote
// against with a space on both sides of these and of br (apps/server
// comment-anchor.ts BLOCKS), so the flat text does the same: a quote across two
// list items then reads "one two", on both sides, and not "onetwo".
const BREAKS =
  "p,div,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,hr,tr,td,th,table,section,article,header,footer,nav,aside,main,blockquote,pre,figure,figcaption,form,fieldset,address";
const BREAK_TAGS = new Set([...BREAKS.split(","), "br"]);

/**
 * Text nodes in document order. `brk[i]` is true when a break element (br, hr,
 * an empty block, or the start of any block) lies between text node i-1 and i.
 */
function collect(root: Node): { nodes: Text[]; brk: boolean[] } {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 1 | 4 /* ELEMENT | TEXT */);
  const nodes: Text[] = [];
  const brk: boolean[] = [];
  let seen = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (BREAK_TAGS.has((n as Element).localName)) seen = true;
    } else if (!skipped(n)) {
      nodes.push(n as Text);
      brk.push(seen);
      seen = false;
    }
  }
  return { nodes, brk };
}

const breakOf = (n: Node): Element | null =>
  n.parentElement?.closest(BREAKS) ?? null;

/**
 * The text nodes under a root with their flat start offsets. Where two
 * consecutive text nodes sit in different blocks and neither side already has
 * whitespace there, the flat text holds one extra space that belongs to no
 * node, so offsets are not always contiguous. Build it once per text version;
 * every offset-to-range lookup is then a binary search.
 */
export type TextIndex = { text: string; nodes: Text[]; starts: number[] };

export function indexText(root: Node): TextIndex {
  const { nodes, brk } = collect(root);
  const starts: number[] = [];
  const parts: string[] = [];
  let pos = 0;
  let prev: Text | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i];
    if (
      prev &&
      !/\s$/.test(prev.data) &&
      !/^\s/.test(t.data) &&
      (brk[i] || breakOf(prev) !== breakOf(t))
    ) {
      parts.push(" ");
      pos++;
    }
    starts.push(pos);
    parts.push(t.data);
    pos += t.data.length;
    prev = t;
  }
  return { text: parts.join(""), nodes, starts };
}

export function flatText(root: Node): string {
  return indexText(root).text;
}

const PRECEDING = 2;

// Flat-text offset of a DOM boundary point.
function pointOffset(index: TextIndex, node: Node, offset: number): number {
  const { nodes, starts } = index;
  if (node.nodeType === 3) {
    const i = nodes.indexOf(node as Text);
    return i < 0 ? index.text.length : starts[i] + offset;
  }
  const boundary = node.childNodes[offset] ?? null;
  let k = 0;
  for (const t of nodes) {
    const before = boundary
      ? (boundary.compareDocumentPosition(t) & PRECEDING) !== 0
      : node.contains(t) || (node.compareDocumentPosition(t) & PRECEDING) !== 0;
    if (!before) break;
    k++;
  }
  return k === 0 ? 0 : endOf(index, k - 1);
}

/** Offsets of a range, or null if it is not inside root. */
export function rangeToOffsets(
  root: Node,
  range: Range,
  index?: TextIndex,
): { start: number; end: number } | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const idx = index ?? indexText(root);
  return {
    start: pointOffset(idx, range.startContainer, range.startOffset),
    end: pointOffset(idx, range.endContainer, range.endOffset),
  };
}

function endOf(i: TextIndex, k: number) {
  return i.starts[k] + i.nodes[k].data.length;
}

/** A Range for text offsets in an index, or null if they fall outside its text. */
export function rangeFromIndex(
  index: TextIndex,
  start: number,
  end: number,
): Range | null {
  const { nodes, starts } = index;
  if (start < 0 || end < start || nodes.length === 0) return null;
  // Start: the node where the text begins (the first with start < its end).
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endOf(index, mid) <= start) lo = mid + 1;
    else hi = mid;
  }
  const si = lo;
  // End: the node where the text ends (the first with end <= its end).
  lo = 0;
  hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endOf(index, mid) < end) lo = mid + 1;
    else hi = mid;
  }
  const ei = lo;
  if (si >= nodes.length || ei >= nodes.length) return null;
  const doc = nodes[si].ownerDocument;
  const r = doc.createRange();
  // An offset on a separator (no node of its own) snaps into the nearest node.
  r.setStart(nodes[si], Math.max(0, start - starts[si]));
  r.setEnd(nodes[ei], Math.max(0, end - starts[ei]));
  return r;
}

/** The text node holding the character at flat offset `offset`, or null. */
export function nodeAtIndex(index: TextIndex, offset: number): Text | null {
  let lo = 0;
  let hi = index.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (endOf(index, mid) <= offset) lo = mid + 1;
    else hi = mid;
  }
  return offset >= 0 && lo < index.nodes.length ? index.nodes[lo] : null;
}

/** A Range for text offsets under root (walks the DOM; prefer rangeFromIndex). */
export function offsetsToRange(
  root: Node,
  start: number,
  end: number,
): Range | null {
  return rangeFromIndex(indexText(root), start, end);
}

export function textNodeAt(root: Node, offset: number): Text | null {
  return nodeAtIndex(indexText(root), offset);
}

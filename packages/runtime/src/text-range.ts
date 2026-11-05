// Map a DOM Range inside `root` to and from flat text offsets (#682). The flat
// text is every text node under root in document order, concatenated, minus
// script, style, noscript, template and textarea contents; it is
// the string @oa/shared's createTextAnchor/resolveTextAnchor work on.

// Text that is never page content: code, templates and form values.
const SKIPPED = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "TEXTAREA",
]);

function skipped(node: Node): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (SKIPPED.has(p.nodeName.toUpperCase())) return true;
  }
  return false;
}

function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!skipped(n)) out.push(n as Text);
  }
  return out;
}

/**
 * The text nodes under a root with their flat start offsets. Build it once per
 * text version; every offset-to-range lookup is then a binary search.
 */
export type TextIndex = { text: string; nodes: Text[]; starts: number[] };

export function indexText(root: Node): TextIndex {
  const nodes = textNodes(root);
  const starts: number[] = [];
  let pos = 0;
  for (const t of nodes) {
    starts.push(pos);
    pos += t.data.length;
  }
  return { text: nodes.map((t) => t.data).join(""), nodes, starts };
}

export function flatText(root: Node): string {
  return indexText(root).text;
}

const PRECEDING = 2;

// Flat-text offset of a DOM boundary point.
function pointOffset(nodes: Text[], node: Node, offset: number): number {
  let sum = 0;
  if (node.nodeType === 3) {
    for (const t of nodes) {
      if (t === node) return sum + offset;
      sum += t.data.length;
    }
    return sum;
  }
  const boundary = node.childNodes[offset] ?? null;
  for (const t of nodes) {
    const before = boundary
      ? (boundary.compareDocumentPosition(t) & PRECEDING) !== 0
      : node.contains(t) || (node.compareDocumentPosition(t) & PRECEDING) !== 0;
    if (!before) break;
    sum += t.data.length;
  }
  return sum;
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
  const nodes = index?.nodes ?? textNodes(root);
  return {
    start: pointOffset(nodes, range.startContainer, range.startOffset),
    end: pointOffset(nodes, range.endContainer, range.endOffset),
  };
}

const endOf = (i: TextIndex, k: number) => i.starts[k] + i.nodes[k].data.length;

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
  r.setStart(nodes[si], start - starts[si]);
  r.setEnd(nodes[ei], end - starts[ei]);
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

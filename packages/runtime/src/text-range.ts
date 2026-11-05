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
    if (SKIPPED.has(p.nodeName)) return true;
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

export function flatText(root: Node): string {
  return textNodes(root)
    .map((t) => t.data)
    .join("");
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
): { start: number; end: number } | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const nodes = textNodes(root);
  return {
    start: pointOffset(nodes, range.startContainer, range.startOffset),
    end: pointOffset(nodes, range.endContainer, range.endOffset),
  };
}

/** A Range for text offsets, or null if they fall outside root's text. */
export function offsetsToRange(
  root: Node,
  start: number,
  end: number,
): Range | null {
  if (start < 0 || end < start) return null;
  const doc = root.ownerDocument ?? (root as Document);
  const nodes = textNodes(root);
  let pos = 0;
  let sNode: Text | null = null;
  let sOff = 0;
  let eNode: Text | null = null;
  let eOff = 0;
  for (const t of nodes) {
    const len = t.data.length;
    // Start prefers the node where the text begins; end prefers the node where it ends.
    if (!sNode && start < pos + len) {
      sNode = t;
      sOff = start - pos;
    }
    if (end <= pos + len && (end > pos || (end === pos && start === end))) {
      eNode = t;
      eOff = end - pos;
      break;
    }
    pos += len;
  }
  if (!sNode || !eNode) return null;
  const r = doc.createRange();
  r.setStart(sNode, sOff);
  r.setEnd(eNode, eOff);
  return r;
}

/** The text node holding the character at flat offset `offset`, or null. */
export function textNodeAt(root: Node, offset: number): Text | null {
  let pos = 0;
  for (const t of textNodes(root)) {
    if (offset < pos + t.data.length) return offset >= pos ? t : null;
    pos += t.data.length;
  }
  return null;
}

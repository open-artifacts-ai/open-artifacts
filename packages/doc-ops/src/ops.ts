import { docSchema, type ImportChange, markdownToDoc } from "@oa/doc-schema";
import {
  Fragment,
  type Mark,
  type NodeType,
  type Node as PMNode,
  type ResolvedPos,
} from "prosemirror-model";
import { findWrapping, Transform } from "prosemirror-transform";
import { findQuote, normalizeQuote } from "./text.ts";

/** Most operations one edit_doc call may carry. */
export const MAX_OPS = 50;

export const INLINE_MARKS = [
  "bold",
  "italic",
  "strike",
  "code",
  "link",
] as const;
export const BLOCK_FORMATS = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
] as const;
export type InlineMark = (typeof INLINE_MARKS)[number];
export type BlockFormat = (typeof BLOCK_FORMATS)[number];

/** Picks one of several matches: text right before and right after the quote. */
export interface QuoteContext {
  prefix?: string;
  suffix?: string;
}

/**
 * One agent operation. Quotes are the text people see, without Markdown
 * symbols; a quote may span blocks, with a line break between them.
 *
 * - replace: the quoted text becomes `with` (Markdown). Inline Markdown keeps
 *   the marks the whole quote shared (replacing a word in bold text stays
 *   bold). Block Markdown splits the block at the quote.
 * - insert: Markdown before or after a quote, or at the start or end of the
 *   doc. Next to a quote that ends (after) or starts (before) inside a block,
 *   inline Markdown goes into the sentence and block Markdown splits it. At a
 *   block's edge the Markdown becomes new blocks beside it; a list next to an
 *   item of the same kind of list adds items to that list.
 * - delete: removes the quoted text; blocks it covers whole go too.
 * - format: an inline mark on the quoted range (`remove: true` takes it off;
 *   link needs `href`), or a block format on every block the quote touches.
 */
export type DocOp =
  | ({ op: "replace"; quote: string; with: string } & QuoteContext)
  | ({ op: "insert"; after: string; markdown: string } & QuoteContext)
  | ({ op: "insert"; before: string; markdown: string } & QuoteContext)
  | { op: "insert"; at: "start" | "end"; markdown: string }
  | ({ op: "delete"; quote: string } & QuoteContext)
  | ({
      op: "format";
      quote: string;
      mark: InlineMark | BlockFormat;
      href?: string;
      remove?: boolean;
    } & QuoteContext);

export type DocOpErrorCode =
  | "quote_not_found"
  | "quote_ambiguous"
  | "doc_too_large"
  | "too_many_ops"
  | "invalid_op";

/** Why an edit was refused, with the next step in `message`. Nothing applied. */
export interface DocOpError {
  code: DocOpErrorCode;
  message: string;
  /** Index of the operation that failed, when one did. */
  opIndex?: number;
  /** quote_not_found: the doc's current text closest to the quote. */
  closest?: string | null;
  /** quote_ambiguous: how many places the quote matches. */
  matches?: number;
  /** doc_too_large: the limit and the size, in bytes. */
  limitBytes?: number;
  sizeBytes?: number;
  /** too_many_ops: the most one call may carry. */
  maxOps?: number;
}

/** What a Markdown import inside an operation changed, by operation. */
export interface OpImportChange extends ImportChange {
  opIndex: number;
}

export type PlanResult =
  | { ok: true; doc: PMNode; changes: OpImportChange[] }
  | { ok: false; error: DocOpError };

class OpFailure extends Error {
  constructor(readonly detail: Omit<DocOpError, "opIndex">) {
    super(detail.message);
  }
}

function invalid(message: string): OpFailure {
  return new OpFailure({ code: "invalid_op", message });
}

const nodes = docSchema.nodes;
const ITEM_OF: Record<string, NodeType> = {
  bulletList: nodes.listItem,
  orderedList: nodes.listItem,
  taskList: nodes.taskItem,
};

function isList(node: PMNode): boolean {
  return node.type.name in ITEM_OF;
}

function isItem(node: PMNode): boolean {
  return node.type === nodes.listItem || node.type === nodes.taskItem;
}

/**
 * Apply operations, in order, to a doc. Each sees the doc as the ones before
 * it left it. Returns the new doc, or the first failure and no doc: all apply
 * or none do.
 */
export function applyOpsToDoc(doc: PMNode, ops: unknown): PlanResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_op",
        message: "Send ops as a non-empty list of operations.",
      },
    };
  }
  if (ops.length > MAX_OPS) {
    return {
      ok: false,
      error: {
        code: "too_many_ops",
        message: `One call takes at most ${MAX_OPS} operations; this one has ${ops.length}. Split them across calls.`,
        maxOps: MAX_OPS,
      },
    };
  }
  const tr = new Transform(doc);
  const changes: OpImportChange[] = [];
  for (let i = 0; i < ops.length; i++) {
    try {
      const op = validate(ops[i]);
      const ctx: OpContext = {
        tr,
        md: (src) => {
          const parsed = markdownToDoc(src);
          for (const c of parsed.changes) changes.push({ ...c, opIndex: i });
          return parsed.doc;
        },
      };
      applyOp(ctx, op);
    } catch (e) {
      const detail =
        e instanceof OpFailure
          ? e.detail
          : {
              code: "invalid_op" as const,
              message: `The doc cannot hold this change (${e instanceof Error ? e.message : String(e)}). Try a quote that covers whole blocks, or plainer Markdown.`,
            };
      return {
        ok: false,
        error: { ...detail, message: `Op ${i}: ${detail.message}`, opIndex: i },
      };
    }
  }
  try {
    tr.doc.check();
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "invalid_op",
        message: `The edits leave the doc invalid (${(e as Error).message}). Nothing was applied.`,
      },
    };
  }
  return { ok: true, doc: tr.doc, changes };
}

// --- validation -------------------------------------------------------------

function str(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw invalid(
      `${name} must be ${allowEmpty ? "a" : "a non-empty"} string.`,
    );
  }
  return value;
}

function quoteOf(value: unknown, name: string): string {
  if (typeof value !== "string" || normalizeQuote(value) === "") {
    throw invalid(`${name} must be a quote: the text to find, not empty.`);
  }
  return value;
}

function context(o: Record<string, unknown>): QuoteContext {
  const out: QuoteContext = {};
  if (o.prefix !== undefined) out.prefix = str(o.prefix, "prefix", true);
  if (o.suffix !== undefined) out.suffix = str(o.suffix, "suffix", true);
  return out;
}

function validate(raw: unknown): DocOp {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("Each operation is an object with an op field.");
  }
  const o = raw as Record<string, unknown>;
  switch (o.op) {
    case "replace":
      return {
        op: "replace",
        quote: quoteOf(o.quote, "quote"),
        with: str(o.with, "with", true),
        ...context(o),
      };
    case "delete":
      return { op: "delete", quote: quoteOf(o.quote, "quote"), ...context(o) };
    case "insert": {
      const markdown = str(o.markdown, "markdown");
      const anchors = ["after", "before", "at"].filter(
        (k) => o[k] !== undefined,
      );
      if (anchors.length !== 1) {
        throw invalid(
          'insert takes exactly one of after (a quote), before (a quote) or at ("start" or "end").',
        );
      }
      if (o.at !== undefined) {
        if (o.at !== "start" && o.at !== "end") {
          throw invalid('at must be "start" or "end".');
        }
        return { op: "insert", at: o.at, markdown };
      }
      if (o.after !== undefined) {
        return {
          op: "insert",
          after: quoteOf(o.after, "after"),
          markdown,
          ...context(o),
        };
      }
      return {
        op: "insert",
        before: quoteOf(o.before, "before"),
        markdown,
        ...context(o),
      };
    }
    case "format": {
      const mark = o.mark;
      if (
        !(INLINE_MARKS as readonly unknown[]).includes(mark) &&
        !(BLOCK_FORMATS as readonly unknown[]).includes(mark)
      ) {
        throw invalid(
          `mark must be one of ${[...INLINE_MARKS, ...BLOCK_FORMATS].join(", ")}.`,
        );
      }
      const out: DocOp = {
        op: "format",
        quote: quoteOf(o.quote, "quote"),
        mark: mark as InlineMark | BlockFormat,
        ...context(o),
      };
      if (o.remove !== undefined) {
        if (typeof o.remove !== "boolean")
          throw invalid("remove must be true or false.");
        if (!(INLINE_MARKS as readonly unknown[]).includes(mark))
          throw invalid("remove works with inline marks only.");
        out.remove = o.remove;
      }
      if (mark === "link" && !out.remove) out.href = str(o.href, "href");
      return out;
    }
    default:
      throw invalid("op must be one of replace, insert, delete or format.");
  }
}

// --- applying ---------------------------------------------------------------

interface OpContext {
  tr: Transform;
  /** Parse Markdown with the doc schema, recording what the import changed. */
  md: (src: string) => PMNode;
}

function locate(
  tr: Transform,
  quote: string,
  ctx: QuoteContext,
): { from: number; to: number } {
  const found = findQuote(tr.doc, quote, ctx.prefix, ctx.suffix);
  if (found.kind === "found") return found.match;
  if (found.kind === "ambiguous") {
    throw new OpFailure({
      code: "quote_ambiguous",
      message: `The quote matches ${found.matches} places. Add a prefix (text right before it) or a suffix (text right after it) to pick one, or quote more text.`,
      matches: found.matches,
    });
  }
  const where =
    found.withoutContext > 0
      ? `The quote appears ${found.withoutContext} time(s), but not with this prefix or suffix. Check them against closest.`
      : "The quote is not in the doc as it is now; someone may have changed it. Read the doc again or retry with the text in closest.";
  throw new OpFailure({
    code: "quote_not_found",
    message: where,
    closest: found.closest,
  });
}

function applyOp(ctx: OpContext, op: DocOp): void {
  switch (op.op) {
    case "replace":
      replace(ctx, op);
      break;
    case "delete":
      remove(ctx, op);
      break;
    case "insert":
      insert(ctx, op);
      break;
    case "format":
      format(ctx, op);
      break;
  }
}

// A one-paragraph Markdown parse is inline content; anything else is blocks.
// Markdown drops the spaces at either end of a paragraph, but inside a sentence
// they matter (insert " brown" after "quick"), so put them back.
function inlineOf(parsed: PMNode, src: string): Fragment | null {
  if (parsed.childCount !== 1 || parsed.firstChild?.type !== nodes.paragraph) {
    return null;
  }
  let content = parsed.firstChild.content;
  if (content.size === 0) return content;
  const lead = /^[ \t]+/.exec(src)?.[0];
  const trail = /[ \t]+$/.exec(src)?.[0];
  if (lead) content = Fragment.from(docSchema.text(lead)).append(content);
  if (trail) content = content.append(Fragment.from(docSchema.text(trail)));
  return content;
}

function commonMarks(doc: PMNode, from: number, to: number): readonly Mark[] {
  let common: readonly Mark[] | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) {
      common =
        common === null
          ? node.marks
          : common.filter((m) => m.isInSet(node.marks));
    }
    return true;
  });
  return common ?? [];
}

// Add marks to text that has none of that type; the Markdown's own marks win.
function withMarks(content: Fragment, marks: readonly Mark[]): Fragment {
  if (marks.length === 0) return content;
  const out: PMNode[] = [];
  content.forEach((node) => {
    let set = node.marks;
    for (const m of marks) {
      if (!set.some((s) => s.type === m.type)) set = m.addToSet(set);
    }
    out.push(node.mark(set));
  });
  return Fragment.from(out);
}

function inCode($from: ResolvedPos, $to: ResolvedPos): boolean {
  return $from.sameParent($to) && $from.parent.type.spec.code === true;
}

function coversWholeBlocks($from: ResolvedPos, $to: ResolvedPos): boolean {
  return (
    $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size
  );
}

function replace(
  { tr, md }: OpContext,
  op: Extract<DocOp, { op: "replace" }>,
): void {
  const { from, to } = locate(tr, op.quote, op);
  const $from = tr.doc.resolve(from);
  const $to = tr.doc.resolve(to);
  if (inCode($from, $to)) {
    // Code is literal: no Markdown inside a code block.
    if (op.with === "") tr.delete(from, to);
    else tr.replaceWith(from, to, docSchema.text(op.with));
    return;
  }
  const parsed = md(op.with);
  const inline = inlineOf(parsed, op.with);
  if (inline !== null) {
    if (inline.size === 0) {
      deleteRange(tr, from, to);
      return;
    }
    tr.replaceWith(from, to, withMarks(inline, commonMarks(tr.doc, from, to)));
    return;
  }
  tr.delete(from, to);
  placeBlocks(tr, from, parsed.content);
}

function deleteRange(tr: Transform, from: number, to: number): void {
  const whole = wholeNodes(tr.doc.resolve(from), tr.doc.resolve(to));
  if (!whole) {
    tr.delete(from, to);
    return;
  }
  // Whole blocks go, not just their text, so no empty lines are left. A doc
  // needs one block: emptying it leaves one empty paragraph.
  if (whole.from === 0 && whole.to === tr.doc.content.size) {
    tr.replaceWith(0, whole.to, nodes.paragraph.create());
  } else {
    tr.delete(whole.from, whole.to);
  }
}

/**
 * When a text range covers whole blocks, the node range to delete: the
 * children of the blocks' shared parent that it covers, grown to that parent
 * while the parent would be left empty (a list item, a quote, a list).
 * Null when the range starts or ends inside a block's text.
 */
function wholeNodes(
  $from: ResolvedPos,
  $to: ResolvedPos,
): { from: number; to: number } | null {
  if (!coversWholeBlocks($from, $to)) return null;
  let d = $from.sharedDepth($to.pos);
  // The range must start at the start of the shared parent's child that holds
  // $from, and end at the end of the one that holds $to.
  for (let k = d + 1; k < $from.depth; k++) {
    if ($from.index(k) !== 0) return null;
  }
  for (let k = d + 1; k < $to.depth; k++) {
    if ($to.index(k) !== $to.node(k).childCount - 1) return null;
  }
  // Both ends in the same textblock: that block is the node to delete.
  if (d === $from.depth) d--;
  let from = $from.before(d + 1);
  let to = $to.after(d + 1);
  while (d > 0 && from === $from.start(d) && to === $to.end(d)) {
    from = $from.before(d);
    to = $to.after(d);
    d--;
  }
  return { from, to };
}

function remove({ tr }: OpContext, op: Extract<DocOp, { op: "delete" }>): void {
  const { from, to } = locate(tr, op.quote, op);
  deleteRange(tr, from, to);
}

function insert(
  { tr, md }: OpContext,
  op: Extract<DocOp, { op: "insert" }>,
): void {
  if ("at" in op) {
    const blocks = md(op.markdown).content;
    const doc = tr.doc;
    const blank =
      doc.childCount === 1 &&
      doc.firstChild?.type === nodes.paragraph &&
      doc.firstChild.content.size === 0;
    if (blank) tr.replaceWith(0, doc.content.size, blocks);
    else tr.insert(op.at === "start" ? 0 : doc.content.size, blocks);
    return;
  }
  const after = "after" in op;
  const { from, to } = locate(tr, after ? op.after : op.before, op);
  const at = after ? to : from;
  const $at = tr.doc.resolve(at);
  const mid =
    $at.parentOffset > 0 && $at.parentOffset < $at.parent.content.size;
  if (mid && $at.parent.type.spec.code === true) {
    tr.insert(at, docSchema.text(op.markdown));
    return;
  }
  const parsed = md(op.markdown);
  const inline = inlineOf(parsed, op.markdown);
  if (mid && inline !== null) {
    tr.insert(at, inline);
    return;
  }
  placeBlocks(tr, at, parsed.content);
}

/**
 * Put blocks at a text position: before its textblock at the start, after it
 * at the end, in place of it when it is empty, and in the middle split it and
 * go between the halves.
 */
function placeBlocks(tr: Transform, pos: number, blocks: Fragment): void {
  const $p = tr.doc.resolve(pos);
  const block = $p.parent;
  if (block.content.size === 0) {
    const index = $p.index($p.depth - 1);
    if ($p.node($p.depth - 1).canReplace(index, index + 1, blocks)) {
      tr.replaceWith($p.before(), $p.after(), blocks);
      return;
    }
    insertBlocks(tr, $p, "after", blocks);
    return;
  }
  const off = $p.parentOffset;
  if (off === 0 || off === block.content.size) {
    insertBlocks(tr, $p, off === 0 ? "before" : "after", blocks);
    return;
  }
  // Spaces at the split would start or end a block; drop them.
  const text = block.textContent;
  const trail = off - text.slice(0, off).trimEnd().length;
  const lead = text.slice(off).length - text.slice(off).trimStart().length;
  if (trail + lead > 0) {
    tr.delete(pos - trail, pos + lead);
    placeBlocks(tr, pos - trail, blocks);
    return;
  }
  tr.split(pos);
  insertBlocks(tr, tr.doc.resolve(pos + 2), "before", blocks);
}

/**
 * Insert blocks before or after the textblock at $p, at the deepest level that
 * can hold them. A list beside an item's first line, of that item's kind of
 * list, adds its items to the list instead of nesting.
 */
function insertBlocks(
  tr: Transform,
  $p: ResolvedPos,
  side: "before" | "after",
  blocks: Fragment,
): void {
  const d0 = $p.depth;
  const only = blocks.childCount === 1 ? blocks.firstChild : null;
  if (
    only &&
    isList(only) &&
    d0 >= 3 &&
    $p.index(d0 - 1) === 0 &&
    isItem($p.node(d0 - 1)) &&
    $p.node(d0 - 2).type === only.type
  ) {
    const pos = side === "after" ? $p.after(d0 - 1) : $p.before(d0 - 1);
    tr.insert(pos, only.content);
    return;
  }
  for (let d = d0; d > 0; d--) {
    const parent = $p.node(d - 1);
    const index = $p.index(d - 1);
    // Before an item's first line would push that line down; go outside.
    if (side === "before" && isItem(parent) && index === 0) continue;
    const at = side === "after" ? index + 1 : index;
    if (parent.canReplace(at, at, blocks)) {
      tr.insert(side === "after" ? $p.after(d) : $p.before(d), blocks);
      return;
    }
  }
  throw invalid("There is no place for these blocks here.");
}

function format({ tr }: OpContext, op: Extract<DocOp, { op: "format" }>): void {
  const { from, to } = locate(tr, op.quote, op);
  const mark = op.mark;
  if ((INLINE_MARKS as readonly string[]).includes(mark)) {
    const type = docSchema.marks[mark];
    if (op.remove) tr.removeMark(from, to, type);
    else
      tr.addMark(
        from,
        to,
        type.create(mark === "link" ? { href: op.href } : null),
      );
    return;
  }
  const $from = tr.doc.resolve(from);
  const $to = tr.doc.resolve(to);
  switch (mark) {
    case "paragraph":
      setBlocks(tr, from, to, nodes.paragraph, {});
      return;
    case "heading1":
    case "heading2":
    case "heading3":
      setBlocks(tr, from, to, nodes.heading, {
        level: Number(mark.slice(-1)),
      });
      return;
    case "codeBlock":
      setBlocks(tr, from, to, nodes.codeBlock, {});
      return;
    case "blockquote": {
      const range = $from.blockRange($to);
      const wrap = range && findWrapping(range, nodes.blockquote);
      if (!range || !wrap) throw invalid("These blocks cannot be quoted.");
      tr.wrap(range, wrap);
      return;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      toList(tr, $from, $to, nodes[mark]);
      return;
  }
}

function setBlocks(
  tr: Transform,
  from: number,
  to: number,
  type: NodeType,
  attrs: Record<string, unknown>,
): void {
  const full = type.create(attrs).attrs;
  const steps = tr.steps.length;
  tr.setBlockType(from, to, type, attrs);
  const map = tr.mapping.slice(steps);
  let changed = false;
  tr.doc.nodesBetween(map.map(from), map.map(to), (node) => {
    if (node.isTextblock && node.hasMarkup(type, full)) changed = true;
    return !node.isTextblock;
  });
  if (!changed) {
    throw invalid(
      `A ${type.name} cannot go here (a list item's first line stays a paragraph).`,
    );
  }
}

function toList(
  tr: Transform,
  $from: ResolvedPos,
  $to: ResolvedPos,
  listType: NodeType,
): void {
  // Already in one list: change that list's kind.
  for (let d = Math.min($from.depth, $to.depth); d > 0; d--) {
    const node = $from.node(d);
    if (
      isList(node) &&
      $to.node(d) === node &&
      $from.before(d) === $to.before(d)
    ) {
      if (node.type === listType) return;
      const itemType = ITEM_OF[listType.name];
      const items: PMNode[] = [];
      node.forEach((item) => {
        items.push(
          item.type === itemType ? item : itemType.create(null, item.content),
        );
      });
      const start = $from.before(d);
      tr.replaceWith(
        start,
        start + node.nodeSize,
        listType.create(
          listType === nodes.orderedList ? { start: 1 } : null,
          items,
        ),
      );
      return;
    }
  }
  // Each touched block becomes an item. An item starts with a paragraph, so a
  // heading or code block gives its text to one; any other block (a quote, a
  // list, a rule) joins the item before it.
  const range = $from.blockRange($to);
  if (!range) throw invalid(`These blocks cannot become a ${listType.name}.`);
  const itemType = ITEM_OF[listType.name];
  const items: PMNode[][] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) {
    const block = range.parent.child(i);
    if (block.type === nodes.paragraph) items.push([block]);
    else if (block.isTextblock) {
      items.push([
        nodes.paragraph.create(
          null,
          block.textContent ? docSchema.text(block.textContent) : null,
        ),
      ]);
    } else if (items.length > 0) items[items.length - 1].push(block);
    else items.push([nodes.paragraph.create(), block]);
  }
  const list = listType.create(
    null,
    items.map((content) => itemType.create(null, content)),
  );
  if (
    !range.parent.canReplace(
      range.startIndex,
      range.endIndex,
      Fragment.from(list),
    )
  ) {
    throw invalid(`These blocks cannot become a ${listType.name} here.`);
  }
  tr.replaceWith(range.start, range.end, list);
}

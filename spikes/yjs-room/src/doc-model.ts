/**
 * The doc shape slice 1 would store: a y-prosemirror style XmlFragment named
 * "default" (Tiptap's default), one XmlElement per block, each holding one
 * XmlText. Only paragraphs and headings here; enough to measure the costs.
 */
import * as Y from "yjs";

export const FRAGMENT = "default";

export function blocks(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(FRAGMENT);
}

export function makeBlock(kind: "paragraph" | "heading", text: string) {
  const el = new Y.XmlElement(kind);
  if (kind === "heading") el.setAttribute("level", "2");
  const t = new Y.XmlText();
  t.insert(0, text);
  el.insert(0, [t]);
  return el;
}

export function blockText(el: Y.XmlElement): Y.XmlText {
  return el.get(0) as Y.XmlText;
}

/** Plain text of one block (no marks). */
export function plain(t: Y.XmlText): string {
  let s = "";
  for (const d of t.toDelta() as { insert: unknown }[]) {
    if (typeof d.insert === "string") s += d.insert;
  }
  return s;
}

/** The text people see: blocks joined by "\n". Offsets index into it. */
export interface TextIndex {
  text: string;
  starts: number[];
  els: Y.XmlElement[];
}

export function textIndex(doc: Y.Doc): TextIndex {
  const els = blocks(doc).toArray() as Y.XmlElement[];
  const parts: string[] = [];
  const starts: number[] = [];
  let pos = 0;
  for (const el of els) {
    const s = plain(blockText(el));
    starts.push(pos);
    parts.push(s);
    pos += s.length + 1;
  }
  return { text: parts.join("\n"), starts, els };
}

export type Quote = { quote: string; prefix?: string; suffix?: string };
export type Op =
  | ({ op: "replace"; with: string } & Quote)
  | ({ op: "delete" } & Quote)
  | ({ op: "insert_after"; markdown: string } & Quote)
  | ({ op: "format"; mark: "bold" | "italic" } & Quote);

type EditCode = "quote_not_found" | "quote_ambiguous" | "quote_spans_blocks";

export class EditError extends Error {
  readonly code: EditCode;
  readonly op: number;
  constructor(code: EditCode, op: number) {
    super(code);
    this.code = code;
    this.op = op;
  }
}

interface Resolved {
  op: Op;
  block: number;
  offset: number;
  length: number;
}

function locate(ix: TextIndex, q: Quote, n: number): [number, number] {
  const needle = (q.prefix ?? "") + q.quote + (q.suffix ?? "");
  const at = ix.text.indexOf(needle);
  if (at < 0) throw new EditError("quote_not_found", n);
  if (ix.text.indexOf(needle, at + 1) >= 0)
    throw new EditError("quote_ambiguous", n);
  const start = at + (q.prefix?.length ?? 0);
  // binary search the block containing `start`
  let lo = 0;
  let hi = ix.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((ix.starts[mid] ?? 0) <= start) lo = mid;
    else hi = mid - 1;
  }
  const end = start + q.quote.length;
  const next = ix.starts[lo + 1] ?? Number.POSITIVE_INFINITY;
  if (end >= next) throw new EditError("quote_spans_blocks", n);
  return [lo, start - (ix.starts[lo] ?? 0)];
}

/**
 * edit_doc: resolve every quote against the current text first (so a bad
 * op fails the call before anything applies), then apply all ops in one
 * Yjs transaction, last position first so earlier offsets stay valid.
 * Markdown is treated as plain paragraphs split on blank lines; a real
 * parser costs more, see RESULTS.md.
 */
export function editDoc(doc: Y.Doc, ops: Op[], origin: unknown = "agent") {
  const ix = textIndex(doc);
  const resolved: Resolved[] = ops.map((op, n) => {
    const [block, offset] = locate(ix, op, n);
    return { op, block, offset, length: op.quote.length };
  });
  resolved.sort((a, b) => b.block - a.block || b.offset - a.offset);
  doc.transact(() => {
    const frag = blocks(doc);
    for (const r of resolved) {
      const el = ix.els[r.block];
      if (!el) continue;
      const t = blockText(el);
      switch (r.op.op) {
        case "replace":
          t.delete(r.offset, r.length);
          t.insert(r.offset, r.op.with);
          break;
        case "delete":
          t.delete(r.offset, r.length);
          break;
        case "format":
          t.format(r.offset, r.length, { [r.op.mark]: {} });
          break;
        case "insert_after": {
          const paras = r.op.markdown.split(/\n{2,}/);
          frag.insert(
            r.block + 1,
            paras.map((p) =>
              p.startsWith("## ")
                ? makeBlock("heading", p.slice(3))
                : makeBlock("paragraph", p),
            ),
          );
          break;
        }
      }
    }
  }, origin);
  return resolved.length;
}

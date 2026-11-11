import type { Node as PMNode } from "prosemirror-model";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import { type DocJSON, toDocNode } from "./json.ts";
import { docSchema } from "./schema.ts";

/** The Y.Doc field that holds a doc: Tiptap Collaboration's default. */
export const DOC_FRAGMENT = "default";

/** The doc's fragment in a Y.Doc, created if missing. */
export function docFragment(ydoc: Y.Doc): Y.XmlFragment {
  return ydoc.getXmlFragment(DOC_FRAGMENT);
}

/**
 * Write a doc into an empty Y.XmlFragment, for a doc's first content (an
 * import or a new doc). Refuses a fragment that already has content: later
 * edits go through Yjs transactions so collaborators' changes merge.
 */
export function docToYXmlFragment(
  doc: PMNode | DocJSON,
  fragment: Y.XmlFragment,
): Y.XmlFragment {
  if (fragment.length > 0) {
    throw new Error("docToYXmlFragment needs an empty fragment");
  }
  const node = toDocNode(doc);
  return prosemirrorToYXmlFragment(node, fragment);
}

/**
 * Read a Y.XmlFragment as a doc node checked against the schema.
 *
 * y-prosemirror deletes any Y element it cannot build against the schema
 * (createNodeFromYElement and createTextNodesFromYText catch the error and
 * call `_item.delete`). So the live fragment is never read: it is copied into
 * a fresh Y.Doc, and if the read deleted anything in the copy this throws,
 * leaving the live doc untouched.
 */
export function yXmlFragmentToDoc(fragment: Y.XmlFragment): PMNode {
  if (fragment.length === 0) {
    const empty = docSchema.topNodeType.createAndFill();
    if (!empty) throw new Error("Could not build an empty doc");
    empty.check();
    return empty;
  }
  const source = fragment.doc;
  if (!source) {
    throw new Error(
      "yXmlFragmentToDoc needs a fragment that belongs to a Y.Doc",
    );
  }
  let key: string | null = null;
  for (const [name, type] of source.share) {
    if ((type as unknown) === fragment) key = name;
  }
  if (key === null) {
    throw new Error(
      "yXmlFragmentToDoc: the fragment is not a top-level field of its Y.Doc",
    );
  }
  const copy = new Y.Doc();
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
    let deleted = false;
    copy.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.deleteSet.clients.size > 0) deleted = true;
    });
    const copied = copy.getXmlFragment(key);
    const node = yXmlFragmentToProseMirrorRootNode(copied, docSchema);
    if (deleted) throw UNREADABLE;
    node.check();
    // y-prosemirror also drops things without deleting them (embeds, unknown
    // attributes). Writing the node back must give the same content.
    node.descendants((n) => {
      if (n.isText && (typeof n.text !== "string" || n.text === "")) {
        throw UNREADABLE;
      }
    });
    const back = scratch.getXmlFragment("check");
    prosemirrorToYXmlFragment(node, back);
    if (canonical(back) !== canonical(copied)) throw UNREADABLE;
    return node;
  } catch (e) {
    if (e === UNREADABLE) throw new Error(UNREADABLE.message);
    throw new Error(UNREADABLE.message, { cause: e });
  } finally {
    copy.destroy();
    scratch.destroy();
  }
}

const UNREADABLE = new Error(
  "The doc has content the schema can't read. Nothing was changed.",
);

// Attributes Tiptap's own extensions add to what the doc writes (link target,
// rel and class; null-valued element attributes). They carry no content.
const TIPTAP_MARK_EXTRAS = new Set(["target", "rel", "class"]);

function stripTiptap(value: unknown, inMark = false): unknown {
  if (Array.isArray(value)) return value.map((v) => stripTiptap(v, inMark));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([k, v]) => v !== null && !(inMark && TIPTAP_MARK_EXTRAS.has(k)),
        )
        .map(([k, v]) => [k, stripTiptap(v, inMark)]),
    );
  }
  return value;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return value;
}

// A structural form of a Y tree: elements with attributes, text deltas with
// embeds and formats. Two trees with the same form hold the same content.
function canonical(fragment: Y.XmlFragment): string {
  type Run = { insert: unknown; attributes?: Record<string, unknown> };
  const attrsOf = (d: Run) =>
    d.attributes
      ? sorted(
          Object.fromEntries(
            Object.entries(d.attributes).map(([k, v]) => [
              k,
              stripTiptap(v, true),
            ]),
          ),
        )
      : undefined;
  // Consecutive Y.XmlText siblings read as one run of text (an empty one as
  // nothing), and adjacent inserts with equal formats are one insert.
  const children = (list: unknown[]): unknown[] => {
    const out: unknown[] = [];
    let runs: { insert: unknown; attributes?: unknown }[] = [];
    const flush = () => {
      if (runs.length > 0) out.push({ text: runs });
      runs = [];
    };
    for (const node of list) {
      if (node instanceof Y.XmlText) {
        for (const d of node.toDelta() as Run[]) {
          const attributes = attrsOf(d);
          const last = runs[runs.length - 1];
          if (
            last &&
            typeof last.insert === "string" &&
            typeof d.insert === "string" &&
            JSON.stringify(last.attributes) === JSON.stringify(attributes)
          ) {
            last.insert += d.insert;
          } else {
            runs.push({ insert: d.insert, attributes });
          }
        }
      } else {
        flush();
        out.push(walk(node));
      }
    }
    flush();
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (node instanceof Y.XmlElement) {
      return {
        name: node.nodeName,
        attrs: sorted(stripTiptap(node.getAttributes())),
        children: children(node.toArray()),
      };
    }
    return { other: String(node) };
  };
  return JSON.stringify(sorted(children(fragment.toArray())));
}

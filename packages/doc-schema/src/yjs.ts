import type { Node as PMNode } from "prosemirror-model";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import { type DocJSON, docFromJSON } from "./json.ts";
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
  const node = "check" in doc ? (doc as PMNode) : docFromJSON(doc as DocJSON);
  node.check();
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
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  let deleted = false;
  copy.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.deleteSet.clients.size > 0) deleted = true;
  });
  const node = yXmlFragmentToProseMirrorRootNode(
    copy.getXmlFragment(key),
    docSchema,
  );
  const lost = deleted;
  copy.destroy();
  if (lost) {
    throw new Error(
      "The doc has content the schema can't read. Nothing was changed.",
    );
  }
  node.check();
  return node;
}

import type { Node as PMNode } from "prosemirror-model";
import {
  prosemirrorToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import type * as Y from "yjs";
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

/** Read a Y.XmlFragment as a doc node checked against the schema. */
export function yXmlFragmentToDoc(fragment: Y.XmlFragment): PMNode {
  const doc =
    fragment.length === 0
      ? docSchema.topNodeType.createAndFill()
      : yXmlFragmentToProseMirrorRootNode(fragment, docSchema);
  if (!doc) throw new Error("Could not build an empty doc");
  doc.check();
  return doc;
}

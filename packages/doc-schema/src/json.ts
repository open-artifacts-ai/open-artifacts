import { Node as PMNode } from "prosemirror-model";
import { docSchema } from "./schema.ts";

/** ProseMirror JSON for a doc, as Tiptap's editor.getJSON() returns it. */
export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/**
 * JSON to a doc node, checked against the schema. Throws a RangeError on a
 * node, mark or attribute outside the content set.
 */
export function docFromJSON(json: DocJSON): PMNode {
  const doc = PMNode.fromJSON(docSchema, json);
  if (doc.type !== docSchema.topNodeType) {
    throw new RangeError(`Expected a doc node, got ${doc.type.name}`);
  }
  doc.check();
  return doc;
}

/**
 * A doc node or JSON as a node of docSchema. A node from another schema is
 * rebuilt from its JSON, so its marks and attributes are checked against
 * docSchema, not the schema it came from.
 */
export function toDocNode(doc: PMNode | DocJSON): PMNode {
  if (doc instanceof PMNode || "check" in doc) {
    const node = doc as PMNode;
    if (node.type.schema !== docSchema)
      return docFromJSON(node.toJSON() as DocJSON);
    node.check();
    return node;
  }
  return docFromJSON(doc as DocJSON);
}

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
 * A doc node or JSON as a doc node of docSchema. A PMNode is always rebuilt
 * from its JSON: ProseMirror lets a node of this schema carry marks of another
 * schema (a paragraph with no mark set), and check() validates each mark
 * against its own type, so only a rebuild checks every node, mark and
 * attribute against docSchema. A root that isn't a doc is refused.
 */
export function toDocNode(doc: PMNode | DocJSON): PMNode {
  const json =
    doc instanceof PMNode || "check" in doc
      ? ((doc as PMNode).toJSON() as DocJSON)
      : (doc as DocJSON);
  return docFromJSON(json);
}

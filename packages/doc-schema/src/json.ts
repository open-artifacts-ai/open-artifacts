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

import {
  docFragment,
  docToMarkdown,
  docToYXmlFragment,
  markdownToDoc,
} from "@oa/doc-schema";
import * as Y from "yjs";
import { applyOpsToDoc } from "../src/index.ts";

/** A Y.Doc holding the Markdown, as the room would after an import. */
export function ydocOf(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  docToYXmlFragment(markdownToDoc(markdown).doc, docFragment(ydoc));
  return ydoc;
}

/** Apply ops to Markdown and return the result as Markdown, or throw. */
export function edit(markdown: string, ops: unknown[]): string {
  const result = applyOpsToDoc(markdownToDoc(markdown).doc, ops);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return docToMarkdown(result.doc);
}

/** The error from applying ops to Markdown, or throw if they applied. */
export function failure(markdown: string, ops: unknown) {
  const result = applyOpsToDoc(markdownToDoc(markdown).doc, ops);
  if (result.ok) throw new Error(`applied: ${docToMarkdown(result.doc)}`);
  return result.error;
}

/** Two replicas kept in sync both ways, like two browsers on one room. */
export function connect(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  a.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== b) Y.applyUpdate(b, u, a);
  });
  b.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== a) Y.applyUpdate(a, u, b);
  });
}

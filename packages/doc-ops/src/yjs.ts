import { docFragment, docToMarkdown, yXmlFragmentToDoc } from "@oa/doc-schema";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { applyOpsToDoc, type DocOpError, type OpImportChange } from "./ops.ts";

/** Starting cap on a doc's stored Yjs state (design: about 2 MB). */
export const MAX_DOC_BYTES = 2 * 1024 * 1024;

export interface EditOptions {
  /** Cap on the doc's Yjs state, in bytes. Defaults to MAX_DOC_BYTES. */
  maxBytes?: number;
  /** Transaction origin, so the room can tell an agent's edit from others. */
  origin?: unknown;
}

export type EditResult =
  | { ok: true; applied: number; changes: OpImportChange[] }
  | { ok: false; error: DocOpError };

function tooLarge(size: number, limit: number): EditResult {
  return {
    ok: false,
    error: {
      code: "doc_too_large",
      message: `The doc would be about ${size} bytes; the limit is ${limit}. Remove content, or start a new doc for the rest.`,
      limitBytes: limit,
      sizeBytes: size,
    },
  };
}

/**
 * Apply edit_doc operations to the live doc. Quotes are looked up against the
 * doc as it is now, so text a person changed since the agent read it gives
 * quote_not_found and the person's edit stands. Every operation applies in
 * one Yjs transaction, or none do. Only the changed parts of the Yjs doc are
 * touched, so concurrent edits elsewhere merge.
 */
export function applyDocOps(
  ydoc: Y.Doc,
  ops: unknown,
  options: EditOptions = {},
): EditResult {
  const limit = options.maxBytes ?? MAX_DOC_BYTES;
  const size = Y.encodeStateAsUpdate(ydoc).byteLength;
  if (size > limit) return tooLarge(size, limit);
  const fragment = docFragment(ydoc);
  const before = yXmlFragmentToDoc(fragment);
  const planned = applyOpsToDoc(before, ops);
  if (!planned.ok) return planned;
  // Growth estimate: one byte per added character or block token. Yjs adds
  // some bytes per item on top, so this errs low; the next call measures.
  const grown =
    size + Math.max(0, planned.doc.content.size - before.content.size);
  if (grown > limit) return tooLarge(grown, limit);
  ydoc.transact(() => {
    updateYFragment(ydoc, fragment, planned.doc, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, options.origin);
  return {
    ok: true,
    applied: (ops as unknown[]).length,
    changes: planned.changes,
  };
}

/** read_doc: the live doc as Markdown. */
export function readDoc(ydoc: Y.Doc): string {
  return docToMarkdown(yXmlFragmentToDoc(docFragment(ydoc)));
}

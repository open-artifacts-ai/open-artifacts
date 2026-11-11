import type { Format } from "@oa/shared";

// Mock mode only. The "Landing page" mock is not stored as format "doc", so
// ?mock=doc (and ?mock=doc-readonly) names its id here instead.
let mockDocId: string | null = null;
let mockReadOnly = false;

export function setMockDoc(id: string | null, readOnly = false) {
  mockDocId = id;
  mockReadOnly = readOnly;
}

/** The mock forces a read-only viewer (?mock=doc-readonly). */
export const mockDocReadOnly = () => mockReadOnly;

/** Is this artifact a collaborative doc (format "doc", #2089)? */
export function isDocArtifact(a: { id: string; format: Format }): boolean {
  return a.format === "doc" || a.id === mockDocId;
}

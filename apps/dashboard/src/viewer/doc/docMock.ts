// Mock mode only. The server's doc format (#2089) is not in the shared
// schema yet, so the "Landing page" mock cannot say format "doc" and still
// parse. ?mock=doc (and ?mock=doc-readonly) names it here instead.
let mockDocId: string | null = null;
let mockReadOnly = false;

export function setMockDoc(id: string | null, readOnly = false) {
  mockDocId = id;
  mockReadOnly = readOnly;
}

/** The mock forces a read-only viewer (?mock=doc-readonly). */
export const mockDocReadOnly = () => mockReadOnly;

/**
 * Is this artifact a collaborative doc? The shared schema lacks the "doc"
 * format until #2089 (docs/1100-doc-format) merges, hence the narrow cast.
 */
export function isDocArtifact(a: { id: string; format: string }): boolean {
  return (a.format as string) === "doc" || a.id === mockDocId;
}

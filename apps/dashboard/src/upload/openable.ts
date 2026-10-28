// What the viewer can open, as the upload checks it before sending (the
// server refuses the rest with unsupported_format or binary_entry, #775).
// Design's copy, 2026-10-28. "or an image" joins KINDS with the image format.

/** The kinds the viewer opens, for the copy. */
export const KINDS = "a web page, Markdown, code or a PDF";
/** The DropZone's muted line. */
export const KINDS_LINE = "Web pages, Markdown, code and PDFs";

const OPENS = new Set(["html", "htm", "md", "markdown", "mdx", "pdf"]);
const HEIC = new Set(["heic", "heif"]);
const SNIFF_BYTES = 8 * 1024;

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const heicCopy = (name: string) =>
  `${name} can't be opened here. Export it as JPEG or PNG, then upload it again.`;
export const unsupportedCopy = (name: string) =>
  `${name} can't be opened here. Upload ${KINDS}.`;

/** NUL or invalid UTF-8 in the first 8 KB: not text (the server's own rule). */
async function isBinary(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return false;
  } catch {
    return true;
  }
}

/**
 * Why the entry (the file the viewer opens) can't be opened, or null. HEIC
 * gets its own hint; any other type with no viewer is fine if it's text
 * (it opens as code), refused if it's binary.
 */
export async function entryRefusal(
  entry: string,
  file: Blob,
): Promise<string | null> {
  const ext = extOf(entry);
  const name = baseName(entry);
  if (HEIC.has(ext)) return heicCopy(name);
  if (OPENS.has(ext)) return null;
  return (await isBinary(file)) ? unsupportedCopy(name) : null;
}

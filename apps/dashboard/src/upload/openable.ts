// What the viewer can open, as the upload checks it before sending (the
// server refuses the rest with unsupported_format or binary_entry, #775).
// Design's copy, 2026-10-28, with images joined (#779).

import { isHeicPath } from "./heic";

/** The kinds the viewer opens, for the copy. */
export const KINDS = "a web page, Markdown, code, a PDF or an image";
/** The DropZone's muted line. */
export const KINDS_LINE = "Web pages, Markdown, code, PDFs and images";

/** Images the viewer opens standalone (#779): the entry is the picture. */
const IMAGES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "heic",
  "heif",
]);
const OPENS = new Set(["html", "htm", "md", "markdown", "mdx", "pdf"]);
const SNIFF_BYTES = 8 * 1024;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const extOf = (path: string) => {
  const i = path.lastIndexOf(".");
  return i <= 0 ? "" : path.slice(i + 1).toLowerCase();
};

export const heicCopy = (name: string) =>
  `${name} can't be opened here. Export it as JPEG or PNG, then upload it again.`;
export const unsupportedCopy = (name: string) =>
  `${name} can't be uploaded. Upload ${KINDS}.`;

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
 * gets its own hint (until the browser converts it, #779); an image opens
 * standalone; any other type with no viewer is fine if it's text (it opens as
 * code), refused if it's binary.
 */
export async function entryRefusal(
  entry: string,
  file: Blob,
): Promise<string | null> {
  const name = baseName(entry);
  if (isHeicPath(entry)) return heicCopy(name);
  const ext = extOf(entry);
  if (OPENS.has(ext) || IMAGES.has(ext)) return null;
  return (await isBinary(file)) ? unsupportedCopy(name) : null;
}

// Publish format guard: does an entry's content fit its format? Shared by the
// server (planFiles/materialize) and the MSW mock, so both refuse alike.
import { type Format, isTextPath } from "./formats.js";

/** How much of an entry is checked: the first 8 KB (one R2 range read for an upload). */
export const SNIFF_BYTES = 8192;

const at = (b: Uint8Array, off: number, sig: number[]) =>
  b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Known binary signatures, checked in order: [what it is, test]. */
const MAGIC: ReadonlyArray<readonly [string, (b: Uint8Array) => boolean]> = [
  ["a JPEG image", (b) => at(b, 0, [0xff, 0xd8, 0xff])],
  [
    "a PNG image",
    (b) => at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ],
  [
    "a GIF image",
    (b) => at(b, 0, ascii("GIF87a")) || at(b, 0, ascii("GIF89a")),
  ],
  ["a WebP image", (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WEBP"))],
  ["a WAV file", (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WAVE"))],
  ["an AVI file", (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("AVI "))],
  [
    "an ISO media file (MP4, MOV, HEIC or AVIF)",
    (b) => at(b, 4, ascii("ftyp")),
  ],
  ["a TIFF image", (b) => at(b, 0, [0x49, 0x49, 0x2a, 0x00])],
  ["a TIFF image", (b) => at(b, 0, [0x4d, 0x4d, 0x00, 0x2a])],
  ["a PDF", (b) => at(b, 0, ascii("%PDF"))],
  ["a ZIP archive", (b) => at(b, 0, [0x50, 0x4b, 0x03, 0x04])],
  ["a ZIP archive", (b) => at(b, 0, [0x50, 0x4b, 0x05, 0x06])],
  ["a gzip archive", (b) => at(b, 0, [0x1f, 0x8b])],
  ["a 7z archive", (b) => at(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
  ["an xz archive", (b) => at(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
  ["a RAR archive", (b) => at(b, 0, ascii("Rar!\x1a\x07"))],
  ["an Ogg file", (b) => at(b, 0, ascii("OggS\x00"))],
  ["a FLAC file", (b) => at(b, 0, ascii("fLaC"))],
  [
    "an MP3 file",
    // ID3, then a version byte 2..4: never text.
    (b) => at(b, 0, ascii("ID3")) && (b[3] ?? 0) >= 2 && (b[3] ?? 0) <= 4,
  ],
  ["a Matroska or WebM file", (b) => at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])],
  ["a WebAssembly module", (b) => at(b, 0, [0x00, 0x61, 0x73, 0x6d])],
  ["an ELF binary", (b) => at(b, 0, [0x7f, 0x45, 0x4c, 0x46])],
  [
    "a Mach-O binary",
    (b) =>
      at(b, 0, [0xfe, 0xed, 0xfa, 0xce]) ||
      at(b, 0, [0xfe, 0xed, 0xfa, 0xcf]) ||
      at(b, 0, [0xce, 0xfa, 0xed, 0xfe]) ||
      at(b, 0, [0xcf, 0xfa, 0xed, 0xfe]),
  ],
  ["a SQLite database", (b) => at(b, 0, ascii("SQLite format 3\x00"))],
];

/** What a known binary signature at the start of `head` is, or null. */
export function detectBinary(head: Uint8Array): string | null {
  for (const [what, test] of MAGIC) if (test(head)) return what;
  return null;
}

/**
 * True when `head` is UTF-8 text: no NUL byte and valid UTF-8. With
 * `truncated` (the file goes on past `head`), a multi-byte sequence cut at
 * the end is allowed.
 */
export function isUtf8Text(head: Uint8Array, truncated: boolean): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, {
      stream: truncated,
    });
    return true;
  } catch {
    return false;
  }
}

/** Upload content types that are never text (image/svg+xml is). */
export function isBinaryContentType(ct: string): boolean {
  const t = (ct.split(";")[0] ?? "").trim().toLowerCase();
  if (t === "image/svg+xml") return false;
  return (
    t.startsWith("image/") ||
    t.startsWith("audio/") ||
    t.startsWith("video/") ||
    t === "application/octet-stream"
  );
}

const isGenericType = (ct: string) =>
  (ct.split(";")[0] ?? "").trim().toLowerCase() === "application/octet-stream";

/** Why an entry is refused (400 binary_entry, details { path, reason }). */
export type EntryRefusal = {
  /** binary: a known binary signature. not_text: a NUL byte or invalid UTF-8. not_pdf: no %PDF. content_type: uploaded as binary. */
  reason: "binary" | "not_text" | "not_pdf" | "content_type";
  message: string;
};

const TEXT_FORMATS: ReadonlySet<Format> = new Set(["code", "markdown", "html"]);
const NAME: Record<Format, string> = {
  html: "HTML",
  markdown: "Markdown",
  code: "code",
  pdf: "a PDF",
};

/**
 * Checks an entry's first SNIFF_BYTES (`head`) against its format: code,
 * markdown and html must be UTF-8 text with no known binary signature; a pdf
 * must start with %PDF. `truncated`: the entry is longer than `head`.
 * `contentType`: an upload's declared type (a binary one is refused for text
 * formats). Null when it fits.
 */
export function checkEntry(
  path: string,
  format: Format,
  head: Uint8Array,
  truncated: boolean,
  contentType?: string,
): EntryRefusal | null {
  if (format === "pdf")
    return at(head, 0, ascii("%PDF"))
      ? null
      : {
          reason: "not_pdf",
          message: `"${path}" doesn't start with %PDF, so it can't be shown as a PDF.`,
        };
  if (!TEXT_FORMATS.has(format)) return null;
  if (
    contentType !== undefined &&
    isBinaryContentType(contentType) &&
    // contentTypeFor (the dashboard's and create_upload's default) labels
    // most source files application/octet-stream: their bytes still decide.
    !(isGenericType(contentType) && isTextPath(path))
  )
    return {
      reason: "content_type",
      message: `"${path}" was uploaded as ${contentType}, so it can't be shown as ${NAME[format]}. Publish text, or pass the format that fits the file.`,
    };
  const what = detectBinary(head);
  if (what)
    return {
      reason: "binary",
      message: `"${path}" is ${what}, not text, so it can't be shown as ${NAME[format]}.`,
    };
  if (!isUtf8Text(head, truncated))
    return {
      reason: "not_text",
      message: `"${path}" isn't UTF-8 text, so it can't be shown as ${NAME[format]}.`,
    };
  return null;
}

/** The first SNIFF_BYTES of inline text as UTF-8, and whether there is more. */
export function textHead(text: string): {
  head: Uint8Array;
  truncated: boolean;
} {
  const bytes = new TextEncoder().encode(text.slice(0, SNIFF_BYTES));
  return {
    head: bytes.subarray(0, SNIFF_BYTES),
    truncated: bytes.length > SNIFF_BYTES || text.length > SNIFF_BYTES,
  };
}

/** The first SNIFF_BYTES of inline bytes, and whether there is more. */
export function bytesHead(bytes: Uint8Array): {
  head: Uint8Array;
  truncated: boolean;
} {
  return {
    head: bytes.subarray(0, SNIFF_BYTES),
    truncated: bytes.length > SNIFF_BYTES,
  };
}

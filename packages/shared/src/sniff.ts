// Publish format guard: does an entry's content fit its format? Shared by the
// server (planFiles/materialize) and the MSW mock, so both refuse alike.
import type { Format } from "./formats.js";

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

/** Declared upload types that claim binary (image/svg+xml is text; application/octet-stream claims nothing). */
export function isBinaryContentType(ct: string): boolean {
  const t = (ct.split(";")[0] ?? "").trim().toLowerCase();
  if (t === "image/svg+xml") return false;
  return (
    t.startsWith("image/") || t.startsWith("audio/") || t.startsWith("video/")
  );
}

/** Why an entry is refused (400 binary_entry, details { path, reason }). */
export type EntryRefusal = {
  /**
   * binary: a known binary signature. not_text: a NUL byte or invalid UTF-8.
   * not_pdf: no %PDF. content_type: uploaded as binary (text formats), or as
   * another type than its image extension's (image). not_image: no image
   * extension, or bytes without that extension's signature. not_svg: an .svg
   * that isn't UTF-8 text with an <svg> root.
   */
  reason:
    | "binary"
    | "not_text"
    | "not_pdf"
    | "content_type"
    | "not_image"
    | "not_svg";
  message: string;
};

// ------------------------------------------------------------------ images

/** An image entry's kind, from its extension. */
export type ImageKind = "png" | "jpeg" | "gif" | "webp" | "svg";
const IMAGE_KIND: Record<string, ImageKind> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  svg: "svg",
};
/** The Content-Type an image of each kind is served with. */
export const IMAGE_CONTENT_TYPES: Record<ImageKind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const IMAGE_LABEL: Record<ImageKind, string> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  svg: "SVG",
};
const extOf = (path: string) => {
  const b = path.slice(path.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1).toLowerCase();
};

/** The image kind an entry's extension names (.png .jpg .jpeg .gif .webp .svg), or null. */
export function imageKind(path: string): ImageKind | null {
  return Object.hasOwn(IMAGE_KIND, extOf(path))
    ? (IMAGE_KIND[extOf(path)] as ImageKind)
    : null;
}

const RASTER_SIG: Record<
  Exclude<ImageKind, "svg">,
  (b: Uint8Array) => boolean
> = {
  jpeg: (b) => at(b, 0, [0xff, 0xd8, 0xff]),
  png: (b) => at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: (b) => at(b, 0, ascii("GIF87a")) || at(b, 0, ascii("GIF89a")),
  webp: (b) => at(b, 0, ascii("RIFF")) && at(b, 8, ascii("WEBP")),
};

/**
 * True when `head` (UTF-8) starts, after an optional BOM, XML declaration,
 * comments, processing instructions and a DOCTYPE, with an <svg> root
 * element. All of the prolog must fit in `head`. A DOCTYPE that declares an
 * entity (<!ENTITY) is refused.
 */
export function hasSvgRoot(head: Uint8Array): boolean {
  const t = new TextDecoder("utf-8").decode(head, { stream: true });
  let i = t.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skip = (close: string) => {
    const j = t.indexOf(close, i);
    if (j < 0) return false;
    i = j + close.length;
    return true;
  };
  for (;;) {
    while (i < t.length && /\s/.test(t[i] as string)) i++;
    if (t.startsWith("<?", i)) {
      if (!skip("?>")) return false;
    } else if (t.startsWith("<!--", i)) {
      if (!skip("-->")) return false;
    } else if (/^<!DOCTYPE/i.test(t.slice(i, i + 9))) {
      // An internal subset ([ ... ]) may hold '>' characters.
      const open = t.indexOf("[", i);
      const gt = t.indexOf(">", i);
      if (gt < 0) return false;
      if (open >= 0 && open < gt) {
        i = open;
        const start = i;
        if (!skip("]")) return false;
        // Entity declarations (expansion bombs, external entities): refused.
        if (/<!ENTITY/i.test(t.slice(start, i))) return false;
      }
      if (!skip(">")) return false;
    } else return /^<svg[\s/>]/.test(t.slice(i, i + 5));
  }
}

const baseType = (ct: string) => (ct.split(";")[0] ?? "").trim().toLowerCase();

/**
 * An image entry against its extension: the bytes must carry that
 * extension's signature (an .svg: UTF-8 text with an <svg> root), and a
 * declared upload type must be the extension's (application/octet-stream
 * claims nothing). Null when it fits.
 */
function checkImage(
  path: string,
  head: Uint8Array,
  truncated: boolean,
  contentType: string | undefined,
): EntryRefusal | null {
  const kind = imageKind(path);
  if (!kind)
    return {
      reason: "not_image",
      message: `"${path}" isn't named as an image. Name it .png, .jpg, .jpeg, .gif, .webp or .svg.`,
    };
  const want = IMAGE_CONTENT_TYPES[kind];
  if (contentType !== undefined) {
    const t = baseType(contentType);
    if (t !== want && t !== "application/octet-stream")
      return {
        reason: "content_type",
        message: `"${path}" was uploaded as ${t}, but a .${extOf(path)} image is ${want}.`,
      };
  }
  if (kind === "svg")
    return isUtf8Text(head, truncated) && hasSvgRoot(head)
      ? null
      : {
          reason: "not_svg",
          message: `"${path}" isn't an SVG image: it must be UTF-8 text with an <svg> root element.`,
        };
  if (RASTER_SIG[kind](head)) return null;
  const what = detectBinary(head);
  return {
    reason: "not_image",
    message: `"${path}" ${what ? `is ${what}` : `doesn't start with the ${IMAGE_LABEL[kind]} signature`}, so it can't be shown as a ${IMAGE_LABEL[kind]} image.`,
  };
}

/** 400 unsupported_format message for a HEIC or HEIF photo (details reason "heic"). */
export const HEIC_MESSAGE =
  "HEIC photos can't be shown yet. Save as JPEG and upload again.";
const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"];

/**
 * A HEIC or HEIF photo: named .heic/.heif, or an ISO BMFF `ftyp` box at byte
 * 4 whose major brand is a HEIF one. Refused whatever the format.
 */
export function isHeic(path: string, head?: Uint8Array): boolean {
  const e = extOf(path);
  if (e === "heic" || e === "heif") return true;
  if (!head || head.length < 12 || !at(head, 4, ascii("ftyp"))) return false;
  return HEIC_BRANDS.includes(String.fromCharCode(...head.subarray(8, 12)));
}

/**
 * A raster image's pixel size from its header (PNG IHDR, GIF screen, WebP
 * VP8/VP8L/VP8X, JPEG SOFn), or null when `b` doesn't hold it.
 */
export function imageSize(
  b: Uint8Array,
): { width: number; height: number } | null {
  const u16be = (o: number) => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
  const u16le = (o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
  const u24le = (o: number) => u16le(o) | ((b[o + 2] ?? 0) << 16);
  const u32be = (o: number) => u16be(o) * 65536 + u16be(o + 2);
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  if (RASTER_SIG.png(b))
    return b.length >= 24 && at(b, 12, ascii("IHDR"))
      ? ok(u32be(16), u32be(20))
      : null;
  if (RASTER_SIG.gif(b)) return b.length >= 10 ? ok(u16le(6), u16le(8)) : null;
  if (RASTER_SIG.webp(b)) {
    if (at(b, 12, ascii("VP8 ")) && b.length >= 30)
      return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (at(b, 12, ascii("VP8L")) && b.length >= 25) {
      const b1 = b[22] ?? 0;
      const b2 = b[23] ?? 0;
      const b3 = b[24] ?? 0;
      return ok(
        1 + ((b[21] ?? 0) | ((b1 & 0x3f) << 8)),
        1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
      );
    }
    if (at(b, 12, ascii("VP8X")) && b.length >= 30)
      return ok(1 + u24le(24), 1 + u24le(27));
    return null;
  }
  if (RASTER_SIG.jpeg(b)) {
    let o = 2;
    while (o + 9 <= b.length) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1] ?? 0;
      if (m === 0xff) {
        o++;
        continue;
      }
      // Standalone markers carry no length.
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
        o += 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return ok(u16be(o + 7), u16be(o + 5));
      const len = u16be(o + 2);
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  return null;
}

const TEXT_FORMATS: ReadonlySet<Format> = new Set(["code", "markdown", "html"]);
const NAME: Record<Format, string> = {
  html: "HTML",
  markdown: "Markdown",
  code: "code",
  pdf: "a PDF",
  image: "an image",
};

/**
 * Checks an entry's first SNIFF_BYTES (`head`) against its format. A pdf must
 * start with %PDF. An image must carry its extension's signature, and an
 * upload's declared type must be that extension's (checkImage). For code, markdown and html the bytes decide: UTF-8 text
 * (no NUL, valid UTF-8) passes whatever its first bytes look like or its
 * upload was declared as. Only bytes that fail the text check are refused,
 * named by their binary signature (`binary`), else by a binary declared
 * upload type (`content_type`; application/octet-stream claims nothing),
 * else `not_text`. `truncated`: the entry is longer than `head`. Null when it
 * fits.
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
  if (format === "image") return checkImage(path, head, truncated, contentType);
  if (!TEXT_FORMATS.has(format) || isUtf8Text(head, truncated)) return null;
  const what = detectBinary(head);
  if (what)
    return {
      reason: "binary",
      message: `"${path}" is ${what}, not text, so it can't be shown as ${NAME[format]}.`,
    };
  if (contentType !== undefined && isBinaryContentType(contentType))
    return {
      reason: "content_type",
      message: `"${path}" was uploaded as ${contentType} and isn't UTF-8 text, so it can't be shown as ${NAME[format]}.`,
    };
  return {
    reason: "not_text",
    message: `"${path}" isn't UTF-8 text, so it can't be shown as ${NAME[format]}.`,
  };
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

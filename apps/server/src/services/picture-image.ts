// Reading and cleaning the image bytes of a comment picture (#2508). Pure
// functions over bytes: the real type from the magic bytes (never the
// declared one), the width and height from the file itself, and the metadata
// taken out WITHOUT re-encoding (the pixels are never touched):
// - JPEG: APP1 (EXIF and XMP), APP13 (Photoshop/IPTC) and COM segments;
// - PNG: eXIf, tEXt, iTXt, zTXt chunks (and tIME);
// - WebP: EXIF and XMP chunks, their VP8X flags cleared, the RIFF size fixed;
// - GIF: comment and application extensions other than the NETSCAPE loop.
// What stays: JPEG keeps APP0 and APP2; PNG keeps unknown private chunks. EXIF
// and XMP are removed from every type.
// A file that doesn't parse as its type is refused, never half-cleaned.
import type { CommentPictureType } from "@oa/shared";

export type PictureRead = {
  type: CommentPictureType;
  w: number;
  h: number;
  /** The cleaned bytes (the input itself when there was nothing to remove). */
  bytes: Uint8Array;
};

export type PictureRefusal = "not_image" | "heic" | "corrupt" | "svg";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const startsWith = (b: Uint8Array, at: number, sig: Uint8Array) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const u16be = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) * 2 ** 24 +
  ((b[i + 1] ?? 0) << 16) +
  ((b[i + 2] ?? 0) << 8) +
  (b[i + 3] ?? 0);
const u16le = (b: Uint8Array, i: number) =>
  (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u32le = (b: Uint8Array, i: number) =>
  ((b[i] ?? 0) |
    ((b[i + 1] ?? 0) << 8) |
    ((b[i + 2] ?? 0) << 16) |
    ((b[i + 3] ?? 0) << 24)) >>>
  0;

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const HEIC_BRANDS = ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"];

/** What the leading bytes say the file is, or why it isn't a picture we take. */
export function sniffPicture(
  b: Uint8Array,
): CommentPictureType | PictureRefusal {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return "image/jpeg";
  if (startsWith(b, 0, PNG_SIG)) return "image/png";
  if (startsWith(b, 0, ascii("GIF87a")) || startsWith(b, 0, ascii("GIF89a")))
    return "image/gif";
  if (startsWith(b, 0, ascii("RIFF")) && startsWith(b, 8, ascii("WEBP")))
    return "image/webp";
  if (
    startsWith(b, 4, ascii("ftyp")) &&
    HEIC_BRANDS.includes(String.fromCharCode(...b.subarray(8, 12)))
  )
    return "heic";
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, 512))
    .trimStart()
    .toLowerCase();
  if (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg"))
  )
    return "svg";
  return "not_image";
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// ---- JPEG
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(b: Uint8Array): PictureRead | "corrupt" {
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let w = 0;
  let h = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) return "corrupt";
    // Fill bytes.
    while (b[i] === 0xff && i < b.length) i++;
    const marker = b[i] ?? 0;
    i++;
    if (marker === 0xd9) {
      kept.push(Uint8Array.of(0xff, 0xd9));
      break;
    }
    // Standalone markers (no length): TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      kept.push(Uint8Array.of(0xff, marker));
      continue;
    }
    if (i + 2 > b.length) return "corrupt";
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return "corrupt";
    const seg = b.subarray(i - 2, i + len);
    if (JPEG_SOF.has(marker) && w === 0) {
      if (len < 8) return "corrupt";
      h = u16be(b, i + 3);
      w = u16be(b, i + 5);
    }
    // APP1 (EXIF, XMP), APP13 (IPTC) and COM are metadata: dropped.
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) kept.push(seg);
    i += len;
    // Entropy-coded data follows SOS to the next marker: copy it whole.
    if (marker === 0xda) {
      let j = i;
      while (j < b.length) {
        if (
          b[j] === 0xff &&
          (b[j + 1] ?? 0) !== 0 &&
          !((b[j + 1] ?? 0) >= 0xd0 && (b[j + 1] ?? 0) <= 0xd7)
        )
          break;
        j++;
      }
      kept.push(b.subarray(i, j));
      i = j;
    }
  }
  if (w <= 0 || h <= 0) return "corrupt";
  return { type: "image/jpeg", w, h, bytes: concat(kept) };
}

// ---- PNG
const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function readPng(b: Uint8Array): PictureRead | "corrupt" {
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let w = 0;
  let h = 0;
  let seenIhdr = false;
  while (i < b.length) {
    if (i + 12 > b.length) return "corrupt";
    const len = u32be(b, i);
    const name = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) return "corrupt";
    if (name === "IHDR") {
      if (len < 13) return "corrupt";
      w = u32be(b, i + 8);
      h = u32be(b, i + 12);
      seenIhdr = true;
    }
    if (!PNG_DROP.has(name)) kept.push(b.subarray(i, end));
    i = end;
    if (name === "IEND") break;
  }
  if (!seenIhdr || w <= 0 || h <= 0) return "corrupt";
  return { type: "image/png", w, h, bytes: concat(kept) };
}

// ---- GIF
function readGif(b: Uint8Array): PictureRead | "corrupt" {
  if (b.length < 13) return "corrupt";
  const w = u16le(b, 6);
  const h = u16le(b, 8);
  if (w <= 0 || h <= 0) return "corrupt";
  const kept: Uint8Array[] = [];
  const flags = b[10] ?? 0;
  let i = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  if (i > b.length) return "corrupt";
  kept.push(b.subarray(0, i));
  const skipBlocks = (at: number): number => {
    let j = at;
    while (j < b.length) {
      const n = b[j] ?? 0;
      j += 1 + n;
      if (n === 0) return j;
    }
    return -1;
  };
  while (i < b.length) {
    const tag = b[i];
    if (tag === 0x3b) {
      kept.push(b.subarray(i, i + 1));
      return { type: "image/gif", w, h, bytes: concat(kept) };
    }
    if (tag === 0x21) {
      const label = b[i + 1] ?? 0;
      const end = skipBlocks(i + 2);
      if (end < 0) return "corrupt";
      // Comment (FE) and plain-text (01) extensions: dropped. Application
      // extensions (FF) other than the NETSCAPE loop count: dropped (XMP).
      const app =
        label === 0xff
          ? String.fromCharCode(...b.subarray(i + 3, i + 3 + 8))
          : "";
      const drop =
        label === 0xfe ||
        label === 0x01 ||
        (label === 0xff &&
          !app.startsWith("NETSCAPE") &&
          !app.startsWith("ANIMEXTS"));
      if (!drop) kept.push(b.subarray(i, end));
      i = end;
      continue;
    }
    if (tag === 0x2c) {
      if (i + 10 > b.length) return "corrupt";
      const f = b[i + 9] ?? 0;
      let j = i + 10 + (f & 0x80 ? 3 * 2 ** ((f & 7) + 1) : 0);
      j += 1; // LZW minimum code size
      const end = skipBlocks(j);
      if (end < 0) return "corrupt";
      kept.push(b.subarray(i, end));
      i = end;
      continue;
    }
    return "corrupt";
  }
  return "corrupt";
}

// ---- WebP
function readWebp(b: Uint8Array): PictureRead | "corrupt" {
  if (b.length < 20) return "corrupt";
  const riff = u32le(b, 4);
  if (riff + 8 > b.length || riff < 12) return "corrupt";
  const total = riff + 8;
  const chunks: Uint8Array[] = [];
  let w = 0;
  let h = 0;
  let i = 12;
  while (i + 8 <= total) {
    const name = String.fromCharCode(...b.subarray(i, i + 4));
    const len = u32le(b, i + 4);
    const padded = len + (len & 1);
    if (i + 8 + padded > total) return "corrupt";
    const data = b.subarray(i + 8, i + 8 + len);
    if (name === "VP8X" && len >= 10) {
      w = 1 + (data[4] ?? 0) + ((data[5] ?? 0) << 8) + ((data[6] ?? 0) << 16);
      h = 1 + (data[7] ?? 0) + ((data[8] ?? 0) << 8) + ((data[9] ?? 0) << 16);
      // Clear the EXIF (0x08) and XMP (0x04) flags.
      const fixed = Uint8Array.from(b.subarray(i, i + 8 + padded));
      fixed[8] = (fixed[8] ?? 0) & ~0x0c;
      chunks.push(fixed);
    } else if (name === "VP8 " && len >= 10 && w === 0) {
      w = u16le(data, 6) & 0x3fff;
      h = u16le(data, 8) & 0x3fff;
      chunks.push(b.subarray(i, i + 8 + padded));
    } else if (name === "VP8L" && len >= 5 && w === 0) {
      if (data[0] !== 0x2f) return "corrupt";
      const bits = u32le(data, 1);
      w = (bits & 0x3fff) + 1;
      h = ((bits >> 14) & 0x3fff) + 1;
      chunks.push(b.subarray(i, i + 8 + padded));
    } else if (name === "EXIF" || name === "XMP ") {
      // Metadata: dropped.
    } else {
      chunks.push(b.subarray(i, i + 8 + padded));
    }
    i += 8 + padded;
  }
  if (w <= 0 || h <= 0) return "corrupt";
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set(ascii("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, 4 + body.length, true);
  head.set(ascii("WEBP"), 8);
  return { type: "image/webp", w, h, bytes: concat([head, body]) };
}

/**
 * Reads `b` as the picture its leading bytes say it is, with metadata removed.
 * The refusal is why it isn't one: not an image we take, a HEIC photo, an SVG,
 * or a file that is cut off or malformed.
 */
export function readPicture(b: Uint8Array): PictureRead | PictureRefusal {
  const t = sniffPicture(b);
  if (t === "image/jpeg") return readJpeg(b);
  if (t === "image/png") return readPng(b);
  if (t === "image/gif") return readGif(b);
  if (t === "image/webp") return readWebp(b);
  return t;
}

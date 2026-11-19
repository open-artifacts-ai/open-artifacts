// #2508: pictures are shrunk in the browser before upload (longest side
// 2,560px) and re-encoded through a canvas, which drops EXIF (location,
// camera). A GIF that fits is sent as is, so it keeps its animation; GIFs
// carry no EXIF.
import { PICTURE_SIDE_MAX, PICTURE_TYPES } from "../../../api/commentPictures";

/** iPhone photos saved as HEIC (or HEIF): refused with Product's message. */
export const isHeic = (f: File) =>
  /^image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);

/** A kind the server takes. */
export const isPictureType = (t: string) =>
  (PICTURE_TYPES as readonly string[]).includes(t);

/** The size a picture is drawn at so its longest side is at most `max`. */
export function fitSide(w: number, h: number, max = PICTURE_SIDE_MAX) {
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const k = max / long;
  return {
    w: Math.max(1, Math.round(w * k)),
    h: Math.max(1, Math.round(h * k)),
  };
}

export type Shrunk = { blob: Blob; w: number; h: number; type: string };

/** Hex SHA-256 of the bytes. */
export async function sha256(blob: Blob) {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Shrink and strip one picture. Throws when the browser can't decode it. */
export async function shrink(file: File): Promise<Shrunk> {
  const bmp = await createImageBitmap(file);
  try {
    const size = fitSide(bmp.width, bmp.height);
    // A GIF that fits stays as is (animation).
    if (file.type === "image/gif" && size.w === bmp.width)
      return { blob: file, w: bmp.width, h: bmp.height, type: file.type };
    // GIFs that must shrink become PNG (one frame); the rest keep their kind.
    const type = file.type === "image/gif" ? "image/png" : file.type;
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("no canvas");
    g.drawImage(bmp, 0, 0, size.w, size.h);
    const blob = await new Promise<Blob>((ok, bad) =>
      canvas.toBlob(
        (b) => (b ? ok(b) : bad(new Error("encode failed"))),
        type,
        type === "image/png" ? undefined : 0.9,
      ),
    );
    return { blob, w: size.w, h: size.h, type: blob.type || type };
  } finally {
    bmp.close?.();
  }
}

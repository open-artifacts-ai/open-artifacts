// #2508, #3007: a comment picture is downscaled in the browser before upload,
// and only when it is past the limits (#3007: "resize at upload, but only if
// it is beyond a certain size"). The thresholds are the worker's, so the same
// picture is judged the same way wherever the resize happens:
// - longest side over 1,568 px: the size the agent read path serves
//   (`PREVIEW_SIDE` in apps/server/src/services/comment-pictures.ts);
// - or bytes over 3 MB: the agent read path's byte budget (`PREVIEW_MAX_BYTES`),
//   which is what a picture has to stay under for an agent to see it.
// At or under both, the file goes up exactly as picked: same bytes, no
// re-encode. Doing this in the browser is what makes it work on an install
// whose worker has no Cloudflare Images binding (the worker-side resize, #3152,
// stays as the second line for the ones that do).
// Anything the browser cannot do (no decode, no canvas, no encode) leaves the
// original to go up untouched: the server still checks it, as before.
import {
  PICTURE_BYTES_FOR_AGENTS,
  PICTURE_SIDE_MAX,
  PICTURE_TYPES,
} from "../../../api/commentPictures";

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

/** What the browser knows about a picture before it decides. */
export type PictureShape = {
  w: number;
  h: number;
  bytes: number;
  type: string;
};

export type UploadLimits = { side: number; bytes: number };

/** The limits a picture is downscaled past: the worker's, #3007. */
export const UPLOAD_LIMITS: UploadLimits = {
  side: PICTURE_SIDE_MAX,
  bytes: PICTURE_BYTES_FOR_AGENTS,
};

/** The kind a downscaled picture is re-encoded at. */
export function outputType(type: string) {
  // A JPEG or a WebP keeps its own kind (a photo, and JPEG's own compression).
  if (type === "image/jpeg" || type === "image/webp") return type;
  // PNG stays PNG, so a screenshot's text stays sharp; a GIF that has to
  // shrink becomes one frame of PNG, since a canvas can't re-time a GIF.
  return "image/png";
}

export type Fit = { scale: false } | { scale: true; w: number; h: number };

/** The decision, and nothing else: does this picture go up as it is? */
export function fitForUpload(
  p: PictureShape,
  limits: UploadLimits = UPLOAD_LIMITS,
): Fit {
  const overSide = Math.max(p.w, p.h) > limits.side;
  const overBytes = p.bytes > limits.bytes;
  if (!overSide && !overBytes) return { scale: false };
  const size = fitSide(p.w, p.h, limits.side);
  return { scale: true, w: size.w, h: size.h };
}

export type Shrunk = {
  blob: Blob;
  w?: number;
  h?: number;
  type: string;
  /** False: the file went up as it was picked (no re-encode at all). */
  scaled: boolean;
};

/** Hex SHA-256 of the bytes. */
export async function sha256(blob: Blob) {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The original, untouched. */
const asIs = (file: File, w?: number, h?: number): Shrunk => ({
  blob: file,
  w,
  h,
  type: file.type,
  scaled: false,
});

/** Draw and encode once, at `w` by `h`. Throws when the canvas can't. */
async function draw(
  bmp: ImageBitmap,
  w: number,
  h: number,
  type: string,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas");
  g.drawImage(bmp, 0, 0, w, h);
  return new Promise<Blob>((ok, bad) =>
    canvas.toBlob(
      (b) => (b ? ok(b) : bad(new Error("encode failed"))),
      type,
      type === "image/png" ? undefined : 0.9,
    ),
  );
}

/**
 * Fit one picture for upload: the file itself when it is within both limits,
 * a downscaled copy when it is not, and the file again whenever the browser
 * cannot make that copy. Never throws: the server is still the judge.
 */
export async function shrink(
  file: File,
  limits: UploadLimits = UPLOAD_LIMITS,
): Promise<Shrunk> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return asIs(file); // Undecodable here: the server reads it or refuses it.
  }
  try {
    const fit = fitForUpload(
      { w: bmp.width, h: bmp.height, bytes: file.size, type: file.type },
      limits,
    );
    if (!fit.scale) return asIs(file, bmp.width, bmp.height);

    const type = outputType(file.type);
    let w = fit.w;
    let h = fit.h;
    let best: { blob: Blob; w: number; h: number } | null = null;
    try {
      for (let tryN = 0; tryN < 4; tryN++) {
        const blob = await draw(bmp, w, h, type);
        if (!best || blob.size < best.blob.size) best = { blob, w, h };
        if (blob.size <= limits.bytes) break;
        // Still over the byte limit with the side already at its cap (a big
        // PNG of noise, say): a smaller frame is the only lever a canvas has.
        const max = Math.max(320, Math.round(Math.max(w, h) * 0.7));
        const next = fitSide(w, h, max);
        if (next.w === w && next.h === h) break;
        w = next.w;
        h = next.h;
      }
    } catch {
      return asIs(file, bmp.width, bmp.height);
    }
    // A copy no smaller than the original is no use: send what was picked.
    if (!best || best.blob.size >= file.size)
      return asIs(file, bmp.width, bmp.height);
    return {
      blob: best.blob,
      w: best.w,
      h: best.h,
      type: best.blob.type || type,
      scaled: true,
    };
  } finally {
    bmp.close?.();
  }
}

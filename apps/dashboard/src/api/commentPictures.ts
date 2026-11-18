// #2508 slice A2: pictures in comments, the drawer. The contract (routes,
// shapes, limits, error codes) is in @oa/shared (R.commentPictures,
// R.commentPicture, comments.ts); this file adds the two-step upload.
// 1. POST R.commentPictures(id) { type, bytes, sha256? } ->
//    { pictureId, url, expiresAt }; PUT the bytes to `url`, which answers the
//    CommentPicture (the server reads w and h). Comment rights needed; guests
//    get 403. HEIC answers 400 unsupported_format; over 10 MB or past the
//    pixel limits 413 too_large (reason "too_large" or "dimensions").
// 2. A new thread and a reply take `pictures?: CommentPictureRef[]`, at most 4.
// 3. GET R.commentPicture(id, pictureId) serves the bytes. No thumbnails.
import {
  COMMENT_PICTURE_MAX_BYTES,
  COMMENT_PICTURES_MAX,
  type CommentPicture,
  type CommentPictureRef,
  type CommentPictureReserve,
  CommentPictureReservedSchema,
  CommentPictureTypeSchema,
  R,
} from "@oa/shared";
import { api } from "./client";

export type { CommentPicture, CommentPictureRef as PictureRef };

export const PICTURE_ROUTES = {
  upload: R.commentPictures,
  /** The original; thumbnails scale it. */
  view: R.commentPicture,
};

/** Kinds the server takes; the file picker offers only these. */
export const PICTURE_TYPES = CommentPictureTypeSchema.options;
export const PICTURES_MAX = COMMENT_PICTURES_MAX;
export const PICTURE_BYTES_MAX = COMMENT_PICTURE_MAX_BYTES;
/** The browser shrinks the longest side to this before upload. */
export const PICTURE_SIDE_MAX = 2560;

/** A comment's pictures (none when it has none). */
export const picturesOf = (c: { pictures?: CommentPicture[] }) =>
  c.pictures ?? [];

/** A failed PUT: the server's error code and reason, when it sent them. */
export class PictureUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(`upload ${status}`);
  }
}

/** Step 1: ask for a place to put the bytes. */
export const requestUpload = (
  artifactId: string,
  meta: CommentPictureReserve,
) =>
  api.send(
    "POST",
    R.commentPictures(artifactId),
    meta,
    CommentPictureReservedSchema,
  );

/** Step 2: PUT the bytes to the signed URL, with progress (0 to 1). */
export function putBytes(
  url: string,
  blob: Blob,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.setRequestHeader("Content-Type", blob.type);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let e: { code?: string; details?: { reason?: string } } = {};
      try {
        e = JSON.parse(x.responseText)?.error ?? {};
      } catch {}
      reject(new PictureUploadError(x.status, e.code, e.details?.reason));
    };
    x.onerror = () => reject(new Error("upload failed"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => x.abort(), { once: true });
    x.send(blob);
  });
}

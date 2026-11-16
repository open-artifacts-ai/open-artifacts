// #2508 slice A2: pictures in comments, the drawer.
//
// PROVISIONAL (Frontend's proposed contract on #2508, comment 6917536040,
// for OA Backend to confirm): this file is the one place that knows the
// routes and shapes, so a change on the server is a change here.
// 1. POST {commentPictures(id)} { type, bytes, w, h, sha256 } ->
//    { pictureId, url, expiresAt }; `url` is a signed PUT for the bytes.
//    Comment rights needed; guests and signed-out visitors get 403.
//    PNG, JPEG, GIF and WebP, 10 MB each; HEIC answers 400 unsupported_format.
// 2. A new thread and a reply take `pictures?: [{ pictureId, alt? }]`, at
//    most 4. Picture-only is allowed unless it mentions an agent.
// 3. Comment.pictures?: [{ id, type, w, h, bytes, alt? }].
// 4. GET {commentPicture(id, pictureId)} serves the bytes (artifact-authz'd),
//    `?size=thumb` a 112px square for the 56px thumbnail.
import {
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
} from "@oa/shared";
import { z } from "zod";
import { api } from "./client";

const base = (artifactId: string) =>
  `/api/v1/artifacts/${encodeURIComponent(artifactId)}/comment-pictures`;
export const PICTURE_ROUTES = {
  upload: base,
  view: (artifactId: string, pictureId: string, thumb = false) =>
    `${base(artifactId)}/${encodeURIComponent(pictureId)}${thumb ? "?size=thumb" : ""}`,
};

/** Kinds the server takes; the file picker offers only these. */
export const PICTURE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];
export const PICTURES_MAX = 4;
export const PICTURE_BYTES_MAX = 10 * 1024 * 1024;
/** The browser shrinks the longest side to this before upload. */
export const PICTURE_SIDE_MAX = 2560;

export const PictureUploadSchema = z.object({
  pictureId: z.string(),
  url: z.string(),
  expiresAt: z.string().optional(),
});
export type PictureUpload = z.infer<typeof PictureUploadSchema>;

export const CommentPictureSchema = z.object({
  id: z.string(),
  type: z.string(),
  w: z.number(),
  h: z.number(),
  bytes: z.number().optional(),
  alt: z.string().nullable().optional(),
});
export type CommentPicture = z.infer<typeof CommentPictureSchema>;

/** The comment shapes with `pictures`, for parsing what the server sends. */
export const PicturedCommentSchema = CommentSchema.extend({
  pictures: z.array(CommentPictureSchema).optional(),
});
export const PicturedThreadSchema = CommentThreadSchema.extend({
  comments: z.array(PicturedCommentSchema),
});
export const PicturedListSchema = CommentListSchema.extend({
  threads: z.array(PicturedThreadSchema),
});

/** A comment's pictures (none on a server that doesn't send them). */
export const picturesOf = (c: object): CommentPicture[] =>
  (c as { pictures?: CommentPicture[] }).pictures ?? [];

/** What a new thread or reply carries for its pictures. */
export type PictureRef = { pictureId: string; alt?: string };

/** Step 1: ask for a place to put the bytes. */
export const requestUpload = (
  artifactId: string,
  meta: { type: string; bytes: number; w: number; h: number; sha256: string },
) => api.send("POST", base(artifactId), meta, PictureUploadSchema);

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
    x.onload = () =>
      x.status >= 200 && x.status < 300
        ? resolve()
        : reject(new Error(`upload ${x.status}`));
    x.onerror = () => reject(new Error("upload failed"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => x.abort(), { once: true });
    x.send(blob);
  });
}

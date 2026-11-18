// Pictures on comments (#2508). A reservation (R.commentPictures) binds a
// picture to one artifact and one person; the signed PUT stores the checked,
// metadata-free bytes in R2 under a random private key; a comment claims it;
// R.commentPicture serves it to whoever may read the page's comments, on every
// request. No public or guessable URL, ever.
import {
  COMMENT_PICTURE_HEIC_MESSAGE,
  COMMENT_PICTURE_MAX_BYTES,
  COMMENT_PICTURE_PENDING_MAX,
  COMMENT_PICTURE_PENDING_TTL_MS,
  COMMENT_PICTURE_RESERVATIONS_PER_DAY,
  COMMENT_PICTURES_MAX,
  type CommentPicture,
  type CommentPictureRef,
  type CommentPictureReserve,
  type CommentPictureReserved,
  CommentPictureTypeSchema,
  isId,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { contentKey } from "../auth/keys.js";
import { requireFreeStorage } from "../billing/caps.js";
import { stmt } from "../db/stmt.js";
import { takeAll } from "../email/send.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { readPicture } from "./picture-image.js";

const digestHex = async (b: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
/** Declared dimensions past these are refused (a tiny file can claim a huge picture). */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 50_000_000;
const notFound = () => new ApiError("not_found", "Not found");
const MB = COMMENT_PICTURE_MAX_BYTES / 1024 / 1024;
/** The signed PUT's life: ten minutes. */
const PUT_TTL_SEC = 600;
/** Plain text, one line, at most 200 characters (the same cleaning the audit text gets). */
const UNSAFE = /[\p{Cc}\p{Cs}\u2028\u2029\p{Cf}]/gu;

/** Alt text: control, format and line-break characters out, whitespace collapsed, cut to the limit. */
export function cleanAlt(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const s = raw.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, 200).join("") : undefined;
}

const signingKey = (env: Env) => contentKey(env, "oa:upload");
/** A prefix of its own: an upload's signature can never verify as a picture's. */
const payload = (id: string, exp: number) => `cpic:${id}:${exp}`;

export const signPicture = async (
  env: Env,
  id: string,
  exp: number,
): Promise<string> => hmacSign(await signingKey(env), payload(id, exp));

const HEIC_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

type Row = {
  id: string;
  artifact_id: string;
  user_id: string;
  type: string;
  r2_key: string;
  bytes: number;
  w: number;
  h: number;
  expected_sha256: string | null;
  alt: string | null;
  comment_id: string | null;
  thread_id: string | null;
  created_at: number;
  received_at: number | null;
};

const asPicture = (r: Row): CommentPicture => ({
  id: r.id,
  type: r.type as CommentPicture["type"],
  w: r.w,
  h: r.h,
  bytes: r.bytes,
  ...(r.alt ? { alt: r.alt } : {}),
});

/**
 * POST R.commentPictures: reserves one picture. The caller has been checked
 * for comment rights, a signed-in non-guest. 400 unsupported_format for HEIC
 * or any type but png, jpeg, gif, webp; 413 too_large over 10 MB; 429 over
 * 100 reservations a day or 20 reserved and not yet used.
 */
export async function reservePicture(
  env: Env,
  user: Member,
  artifactId: string,
  input: CommentPictureReserve,
  now = Date.now(),
): Promise<CommentPictureReserved> {
  const type = input.type.trim().toLowerCase();
  if (HEIC_TYPES.has(type))
    throw new ApiError("unsupported_format", COMMENT_PICTURE_HEIC_MESSAGE, {
      reason: "heic",
    });
  const ok = CommentPictureTypeSchema.safeParse(type);
  if (!ok.success)
    throw new ApiError(
      "unsupported_format",
      "Pictures can be PNG, JPEG, GIF or WebP.",
      { reason: "type" },
    );
  if (input.bytes > COMMENT_PICTURE_MAX_BYTES)
    throw new ApiError("too_large", `A picture can be up to ${MB} MB.`, {
      reason: "too_large",
    });
  await signingKey(env);
  // Unused reservations first (they expire after an hour), then the day.
  const pending = await stmt(
    env.DB,
    "select count(*) as n from comment_pictures where user_id = ?1 and comment_id is null and created_at > ?2",
  )
    .bind(user.id, now - COMMENT_PICTURE_PENDING_TTL_MS)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= COMMENT_PICTURE_PENDING_MAX)
    throw new ApiError(
      "rate_limited",
      "Too many pictures are waiting to be used. Attach them to a comment, or try again in an hour.",
      { reason: "pending", limit: COMMENT_PICTURE_PENDING_MAX },
    );
  const day = new Date(now).toISOString().slice(0, 10);
  if (
    (await takeAll(env, [
      [`cpic:${user.id}`, COMMENT_PICTURE_RESERVATIONS_PER_DAY, day],
    ])) !== -1
  )
    throw new ApiError(
      "rate_limited",
      "You have added a lot of pictures today. Try again tomorrow.",
      { reason: "day", limit: COMMENT_PICTURE_RESERVATIONS_PER_DAY },
    );
  await requireFreeStorage(env, input.bytes);
  const id = newId();
  await stmt(
    env.DB,
    `insert into comment_pictures (id, artifact_id, user_id, type, r2_key, bytes, expected_sha256, created_at)
     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      artifactId,
      user.id,
      ok.data,
      // Under the artifact's files/ prefix, so the purge that lists and deletes
      // that prefix takes the bytes with no R2 call of its own.
      `files/${artifactId}/${newId()}`,
      input.bytes,
      input.sha256 ?? null,
      now,
    )
    .run();
  const exp = Math.floor(now / 1000) + PUT_TTL_SEC;
  const sig = await signPicture(env, id, exp);
  return {
    pictureId: id,
    url: `${appOrigin(env)}${R.commentPicture(artifactId, id)}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * PUT of the raw bytes, authorized by its signature alone. Unknown, expired or
 * already-stored → 404/409. The body must be exactly the declared size; the
 * real type comes from the bytes (a mismatch is 400 binary_entry, HEIC is
 * unsupported_format); metadata is removed without re-encoding; w and h come
 * from the file. Answers the Picture.
 */
export async function putPicture(
  env: Env,
  artifactId: string,
  pictureId: string,
  exp: string,
  sig: string,
  req: Request,
  now = Date.now(),
): Promise<CommentPicture> {
  if (!isId(pictureId) || !/^\d{1,12}$/.test(exp) || !sig) throw notFound();
  if (Number(exp) * 1000 <= now) throw notFound();
  if (
    !(await hmacVerify(
      await signingKey(env),
      payload(pictureId, Number(exp)),
      sig,
    ))
  )
    throw notFound();
  const row = await stmt(
    env.DB,
    "select * from comment_pictures where id = ?1 and artifact_id = ?2",
  )
    .bind(pictureId, artifactId)
    .first<Row>();
  if (!row) throw notFound();
  if (row.received_at !== null)
    throw new ApiError("conflict", "This picture was already uploaded.");
  const len = req.headers.get("content-length");
  if (!req.body || len === null || Number(len) !== row.bytes)
    throw new ApiError(
      "bad_request",
      "Content-Length must equal the reserved size. Send exactly those bytes.",
      { expected: row.bytes },
    );
  const claim = await stmt(
    env.DB,
    "update comment_pictures set received_at = -1 where id = ?1 and received_at is null",
  )
    .bind(pictureId)
    .run();
  if (!claim.meta.changes)
    throw new ApiError("conflict", "This picture was already uploaded.");
  const release = () =>
    stmt(
      env.DB,
      "update comment_pictures set received_at = null where id = ?1 and received_at = -1",
    )
      .bind(pictureId)
      .run();
  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.length !== row.bytes)
      throw new ApiError("bad_request", "The body is not the reserved size.", {
        expected: row.bytes,
      });
    if (row.expected_sha256 && (await digestHex(raw)) !== row.expected_sha256)
      throw new ApiError(
        "bad_request",
        "The SHA-256 does not match the one reserved. Send the original bytes.",
      );
    const read = readPicture(raw);
    if (read === "heic")
      throw new ApiError("unsupported_format", COMMENT_PICTURE_HEIC_MESSAGE, {
        reason: "heic",
      });
    if (typeof read === "string")
      throw new ApiError(
        "binary_entry",
        "This file isn't a PNG, JPEG, GIF or WebP picture.",
        { reason: read === "corrupt" ? "corrupt" : "not_image" },
      );
    if (read.type !== row.type)
      throw new ApiError(
        "binary_entry",
        `The bytes are ${read.type.slice(6).toUpperCase()}, not the ${row.type.slice(6).toUpperCase()} they were reserved as.`,
        { reason: "type_mismatch" },
      );
    if (read.w > MAX_SIDE || read.h > MAX_SIDE || read.w * read.h > MAX_PIXELS)
      throw new ApiError(
        "too_large",
        `A picture can be up to ${MAX_SIDE} pixels on a side and ${MAX_PIXELS / 1_000_000} megapixels.`,
        { reason: "dimensions" },
      );
    // The cleaned size is what is stored, and what counts.
    await requireFreeStorage(env, read.bytes.length);
    await env.FILES.put(row.r2_key, read.bytes, {
      httpMetadata: { contentType: read.type },
    });
    const done = await stmt(
      env.DB,
      "update comment_pictures set bytes = ?2, w = ?3, h = ?4, received_at = ?5 where id = ?1 and received_at = -1",
    )
      .bind(pictureId, read.bytes.length, read.w, read.h, now)
      .run();
    if (!done.meta.changes) {
      await env.FILES.delete(row.r2_key).catch(() => {});
      throw new ApiError("conflict", "This picture was already uploaded.");
    }
    return asPicture({
      ...row,
      type: read.type,
      bytes: read.bytes.length,
      w: read.w,
      h: read.h,
    });
  } catch (e) {
    await env.FILES.delete(row.r2_key).catch(() => {});
    await release();
    throw e;
  }
}

/**
 * Claims the pictures a new comment attaches, before the comment is written:
 * each must be the caller's, uploaded, unattached, on this artifact (else 400
 * bad_request; nothing is claimed). They are held under `holder` until
 * `bindPictures` names the comment, or `releasePictures` gives them back.
 */
export async function claimPictures(
  env: Env,
  artifactId: string,
  userId: string,
  refs: CommentPictureRef[],
): Promise<{ holder: string; refs: CommentPictureRef[] }> {
  const ids = new Set(refs.map((r) => r.pictureId));
  const bad = () =>
    new ApiError(
      "bad_request",
      "A picture isn't yours, isn't uploaded, was already used, or is on another page.",
      { reason: "picture" },
    );
  if (ids.size !== refs.length || refs.length > COMMENT_PICTURES_MAX)
    throw bad();
  const holder = `hold:${newId()}`;
  for (const r of refs) {
    if (!isId(r.pictureId)) {
      await releaseHolder(env, holder);
      throw bad();
    }
    const alt = cleanAlt(r.alt) ?? null;
    const res = await stmt(
      env.DB,
      `update comment_pictures set comment_id = ?1, alt = ?2
        where id = ?3 and user_id = ?4 and artifact_id = ?5
          and comment_id is null and received_at > 0`,
    )
      .bind(holder, alt, r.pictureId, userId, artifactId)
      .run();
    if (!res.meta.changes) {
      await releaseHolder(env, holder);
      throw bad();
    }
  }
  return { holder, refs };
}

const releaseHolder = (env: Env, holder: string) =>
  stmt(
    env.DB,
    "update comment_pictures set comment_id = null where comment_id = ?1",
  )
    .bind(holder)
    .run();

/** The comment was never written: the pictures go back to the caller, unattached. */
export const releasePictures = (env: Env, holder: string) =>
  releaseHolder(env, holder).then(() => undefined);

/** The comment exists: the held pictures belong to it (and its thread). */
export async function bindPictures(
  env: Env,
  holder: string,
  threadId: string,
  commentId: string,
): Promise<void> {
  await stmt(
    env.DB,
    "update comment_pictures set comment_id = ?1, thread_id = ?2 where comment_id = ?3",
  )
    .bind(commentId, threadId, holder)
    .run();
}

/** The pictures of these comments, by comment id, in the order they were attached. */
export async function picturesOf(
  env: Env,
  commentIds: string[],
): Promise<Map<string, CommentPicture[]>> {
  const out = new Map<string, CommentPicture[]>();
  if (commentIds.length === 0) return out;
  const { results } = await stmt(
    env.DB,
    `select * from comment_pictures where received_at > 0
       and comment_id in (select value from json_each(?1))
     order by rowid`,
  )
    .bind(JSON.stringify(commentIds))
    .all<Row>();
  for (const r of results) {
    if (!r.comment_id) continue;
    out.set(r.comment_id, [...(out.get(r.comment_id) ?? []), asPicture(r)]);
  }
  return out;
}

/**
 * The picture's bytes for GET: it must be on this artifact and either
 * attached to a comment or the caller's own pending one. Else 404.
 */
export async function getPicture(
  env: Env,
  artifactId: string,
  pictureId: string,
  userId: string | null,
): Promise<{ body: ReadableStream; type: string; bytes: number } | null> {
  if (!isId(pictureId)) return null;
  const row = await stmt(
    env.DB,
    "select * from comment_pictures where id = ?1 and artifact_id = ?2 and received_at > 0",
  )
    .bind(pictureId, artifactId)
    .first<Row>();
  if (!row) return null;
  const attached =
    row.comment_id !== null && !row.comment_id.startsWith("hold:");
  if (!attached && row.user_id !== userId) return null;
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return null;
  return { body: obj.body, type: row.type, bytes: row.bytes };
}

/**
 * The picture's comment, for the GET's held-request check: null when it isn't
 * attached to one.
 */
export async function pictureComment(
  env: Env,
  artifactId: string,
  pictureId: string,
): Promise<{ threadId: string; commentId: string } | null> {
  const row = await stmt(
    env.DB,
    "select thread_id, comment_id from comment_pictures where id = ?1 and artifact_id = ?2",
  )
    .bind(pictureId, artifactId)
    .first<{ thread_id: string | null; comment_id: string | null }>();
  if (!row?.thread_id || !row.comment_id || row.comment_id.startsWith("hold:"))
    return null;
  return { threadId: row.thread_id, commentId: row.comment_id };
}

/** Deletes pictures by where they sit (a comment, or a whole thread) and their bytes. */
async function deleteWhere(
  env: Env,
  column: "comment_id" | "thread_id",
  id: string,
): Promise<void> {
  const { results } = await stmt(
    env.DB,
    `select r2_key from comment_pictures where ${column} = ?1`,
  )
    .bind(id)
    .all<{ r2_key: string }>();
  if (results.length === 0) return;
  await env.FILES.delete(results.map((r) => r.r2_key));
  await stmt(env.DB, `delete from comment_pictures where ${column} = ?1`)
    .bind(id)
    .run();
}

/** A deleted comment takes its pictures; a deleted root takes the whole thread's. */
export const deleteCommentPictures = (
  env: Env,
  threadId: string,
  commentId: string,
  root: boolean,
) =>
  root
    ? deleteWhere(env, "thread_id", threadId)
    : deleteWhere(env, "comment_id", commentId);

/** The daily sweep: reservations and uploads no comment used for an hour, and rows stuck under a "hold:" claim that long (and their bytes). */
export async function sweepPictures(env: Env, now: number): Promise<number> {
  const { results } = await stmt(
    env.DB,
    `select id, r2_key from comment_pictures
      where (comment_id is null or comment_id like 'hold:%') and created_at < ?1 limit 500`,
  )
    .bind(now - COMMENT_PICTURE_PENDING_TTL_MS)
    .all<{ id: string; r2_key: string }>();
  if (results.length === 0) return 0;
  await env.FILES.delete(results.map((r) => r.r2_key));
  await stmt(
    env.DB,
    "delete from comment_pictures where id in (select value from json_each(?1))",
  )
    .bind(JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}

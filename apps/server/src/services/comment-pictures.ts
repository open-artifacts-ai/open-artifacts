// Pictures on comments (#2508). A reservation (R.commentPictures) binds a
// picture to one artifact and one person; the signed PUT stores the checked,
// metadata-free bytes in R2 under a random private key, downscaled once if it
// is past the store limits (#3007); a comment claims it; R.commentPicture
// serves it to whoever may read the page's comments, on every request. No
// public or guessable URL, ever.
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
import { readCappedRequest } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { logError } from "../log.js";
import { runtimeStub } from "../runtime/do.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { type PictureRead, readPicture } from "./picture-image.js";

const digestHex = async (b: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
/** Declared dimensions past these are refused (a tiny file can claim a huge picture). */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 50_000_000;
const notFound = () => new ApiError("not_found", "Not found");
const MB = COMMENT_PICTURE_MAX_BYTES / 1024 / 1024;
/**
 * A comment picture is downscaled once, at upload, and only past these limits
 * (#3007): a longest side over the 1568 px agents are served, or over the 3 MB
 * the agent read path would send. At or under them the uploaded bytes are
 * stored exactly as they came (metadata cleaning aside), never re-encoded.
 */
export const PICTURE_STORE_MAX_SIDE = 1568;
export const PICTURE_STORE_MAX_BYTES = 3 * 1024 * 1024;
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

/** Whether an uploaded picture is past the store limits, i.e. whether it is
 * downscaled: the longest side over 1568 px, or over 3 MB of bytes. */
export const beyondStoreLimits = (p: {
  w: number;
  h: number;
  bytes: number;
}): boolean =>
  Math.max(p.w, p.h) > PICTURE_STORE_MAX_SIDE ||
  p.bytes > PICTURE_STORE_MAX_BYTES;

/** How a downscaled copy is written back: the picture's own type, so the
 * declared type, the stored row and the served content-type still agree. */
const RESIZE_OUTPUT = {
  "image/png": { format: "image/png" },
  "image/jpeg": { format: "image/jpeg", quality: 85 },
  "image/webp": { format: "image/webp", quality: 85, anim: false },
  "image/gif": { format: "image/gif", anim: true },
} as const;

/**
 * The bytes that get stored (#3007). At or under the store limits this is the
 * cleaned original itself, untouched and byte for byte. Past them, Workers
 * Images makes a copy whose longest side fits 1568 px; the copy is read back
 * like any upload (same type, real width and height) and kept only if it is
 * smaller. A resize that fails or gains nothing leaves the original in place:
 * the upload succeeds either way.
 */
export async function fitForStorage(
  env: Env,
  read: PictureRead,
): Promise<PictureRead & { downscaled: boolean }> {
  const images = env.IMAGES;
  if (!beyondStoreLimits({ w: read.w, h: read.h, bytes: read.bytes.length }))
    return { ...read, downscaled: false };
  // No binding: the upload is kept as it came, as before #3007.
  if (!images) return { ...read, downscaled: false };
  const output = RESIZE_OUTPUT[read.type];
  const keep = (why: string, e?: unknown, status?: number) => {
    logError("comment_picture_resize_failed", e, {
      why,
      status,
      type: read.type,
      bytes: read.bytes.length,
      w: read.w,
      h: read.h,
    });
    return { ...read, downscaled: false };
  };
  try {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(read.bytes);
        c.close();
      },
    });
    const res = (
      await images
        .input(body)
        .transform({
          width: PICTURE_STORE_MAX_SIDE,
          height: PICTURE_STORE_MAX_SIDE,
          fit: "scale-down",
        })
        .output(output)
    ).response();
    if (!res.ok || res.headers.get("content-type") !== output.format)
      return keep("images_status", undefined, res.status);
    const bytes = await readCappedRequest(res, COMMENT_PICTURE_MAX_BYTES);
    const again = readPicture(bytes);
    if (typeof again === "string" || again.type !== read.type)
      return keep("copy_unreadable");
    // A copy no smaller than the original would only cost a re-encode.
    if (again.bytes.length >= read.bytes.length)
      return { ...read, downscaled: false };
    return { ...again, downscaled: true };
  } catch (e) {
    return keep("images_threw", e);
  }
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
    // The bytes are final here: over the store limits (#3007) an Images copy
    // takes the place of the original; at or under them they are kept as sent.
    const stored = await fitForStorage(env, read);
    // The stored size is what counts.
    await requireFreeStorage(env, stored.bytes.length);
    await env.FILES.put(row.r2_key, stored.bytes, {
      httpMetadata: { contentType: stored.type },
    });
    const done = await stmt(
      env.DB,
      "update comment_pictures set bytes = ?2, w = ?3, h = ?4, type = ?6, received_at = ?5 where id = ?1 and received_at = -1",
    )
      .bind(
        pictureId,
        stored.bytes.length,
        stored.w,
        stored.h,
        now,
        stored.type,
      )
      .run();
    if (!done.meta.changes) {
      await env.FILES.delete(row.r2_key).catch(() => {});
      throw new ApiError("conflict", "This picture was already uploaded.");
    }
    return asPicture({
      ...row,
      type: stored.type,
      bytes: stored.bytes.length,
      w: stored.w,
      h: stored.h,
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
 * Who is reading a picture. `browser`: the person's own signed-in browser
 * session (or a signed-out visitor the route let in). `agent`: a token, a
 * grant or MCP: #2577, it reads no picture of a request held for the person it
 * acts for.
 */
type PictureReadMode = "browser" | "agent";

type PictureHit = {
  body: ReadableStream;
  type: string;
  bytes: number;
  w: number;
  h: number;
};

/**
 * The one path to a picture's bytes, for REST and MCP. It is on this artifact
 * and either attached to a comment or the caller's own pending one. For an
 * `agent` read of an attached picture, its comment must exist and not be held
 * for the caller (#2577), read from the same picture row; a picture that has
 * lost its comment fails closed. All checked before R2 is read.
 */
export async function getPicture(
  env: Env,
  artifactId: string,
  pictureId: string,
  userId: string | null,
  mode: PictureReadMode,
): Promise<PictureHit> {
  if (!isId(pictureId)) throw new ApiError("bad_request", "Invalid pictureId");
  const row = await stmt(
    env.DB,
    "select * from comment_pictures where id = ?1 and artifact_id = ?2 and received_at > 0",
  )
    .bind(pictureId, artifactId)
    .first<Row>();
  if (!row) throw notFound();
  if (row.comment_id && !row.comment_id.startsWith("hold:")) {
    if (mode === "agent" && userId) {
      if (!row.thread_id) throw notFound();
      const thread = await runtimeStub(env, artifactId).commentsGet(
        row.thread_id,
      );
      const comment = thread.comments.find((c) => c.id === row.comment_id);
      if (
        !comment ||
        comment.held?.some((h) => h.state === "held" && h.owner === userId)
      )
        throw notFound();
    }
  } else if (row.user_id !== userId) {
    throw notFound();
  }
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) throw notFound();
  return {
    body: obj.body,
    type: row.type,
    bytes: row.bytes,
    w: row.w,
    h: row.h,
  };
}

// The agent read path's budget: the same numbers a stored picture is kept
// within at upload (#3007).
const PREVIEW_MAX_BYTES = PICTURE_STORE_MAX_BYTES;
const PREVIEW_SIDE = PICTURE_STORE_MAX_SIDE;

type PictureForAgent = { data: Uint8Array; mimeType: string };

/**
 * Send the stored image within the byte budget. If Images is available,
 * also fit its longest side to the preview limit. Images receives private bytes.
 */
export async function previewForAgent(
  env: Env,
  hit: PictureHit,
): Promise<PictureForAgent> {
  const images = env.IMAGES;
  const fitsFrame = hit.w <= PREVIEW_SIDE && hit.h <= PREVIEW_SIDE;
  if (hit.bytes <= PREVIEW_MAX_BYTES && (!images || fitsFrame))
    return {
      data: new Uint8Array(await new Response(hit.body).arrayBuffer()),
      mimeType: hit.type,
    };
  const unavailable = () =>
    new ApiError(
      "too_large",
      "A smaller preview could not be made for this picture. You can open the original in the web app.",
    );
  if (!images) {
    await hit.body.cancel().catch(() => {});
    throw new ApiError(
      "too_large",
      "This picture is too large to show. Open the original in the web app.",
    );
  }
  try {
    const res = (
      await images
        .input(hit.body)
        .transform({
          width: PREVIEW_SIDE,
          height: PREVIEW_SIDE,
          fit: "scale-down",
        })
        .output({ format: "image/webp", quality: 85, anim: false })
    ).response();
    if (!res.ok || res.headers.get("content-type") !== "image/webp")
      throw unavailable();
    const data = await readCappedRequest(res, PREVIEW_MAX_BYTES);
    if (!data.length) throw unavailable();
    return { data, mimeType: "image/webp" };
  } catch (e) {
    if (!(e instanceof ApiError)) logError("comment_picture_preview_failed", e);
    throw unavailable();
  }
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

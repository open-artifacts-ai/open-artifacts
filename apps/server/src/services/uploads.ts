import {
  contentTypeFor,
  isId,
  LIMITS,
  type Member,
  newId,
  normalizePath,
  R,
  type UploadCreated,
  type UploadCreateInput,
} from "@oa/shared";
import { authorize, callerOf, capOfCaller } from "../auth/authz.js";
import { contentKey } from "../auth/keys.js";
import { orgCan } from "../auth/policy.js";
import { requireFreeStorage } from "../billing/caps.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";

const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9_.+-]+=("[^"\\\r\n]*"|[a-z0-9_.+-]+))*$/i;
const notFound = () => new ApiError("not_found", "Not found");

/** Upload URLs: the "oa:upload" subkey (never the content-token one). */
const signingKey = (env: Env) => contentKey(env, "oa:upload");

/**
 * Registers an upload and returns a signed PUT URL (valid LIMITS.uploadUrlTtlSec).
 * No artifactId → reserves a new id for this user; otherwise the caller must be
 * an editor of the artifact or hold its reservation (else 404).
 */
export async function createUpload(
  env: Env,
  user: Member,
  input: UploadCreateInput,
  now = Date.now(),
): Promise<UploadCreated> {
  const p = normalizePath(input.path);
  if (!p.ok)
    throw new ApiError(
      "bad_request",
      `Invalid path "${input.path}": ${p.error}`,
      {
        path: input.path,
        reason: p.error,
      },
    );
  if (!Number.isSafeInteger(input.size) || input.size <= 0)
    throw new ApiError("bad_request", "Invalid size", {
      path: input.path,
      reason: "invalid_size",
    });
  if (input.size > LIMITS.fileBytes)
    throw new ApiError(
      "too_large",
      `Files are limited to ${LIMITS.fileBytes} bytes`,
      {
        path: input.path,
        reason: "too_large",
      },
    );
  const contentType = input.contentType ?? contentTypeFor(p.path);
  if (contentType.length > 200 || !CONTENT_TYPE.test(contentType))
    throw new ApiError("bad_request", "Invalid contentType", {
      path: input.path,
      reason: "invalid_content_type",
    });
  const key = await signingKey(env);
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  let artifactId = input.artifactId;
  const who = callerOf(user);
  // Reserving or uploading into a new artifact is a create (capped callers can't).
  const mayCreate = () => {
    if (!orgCan(user, "artifact.create", { cap: capOfCaller(who) }))
      throw new ApiError("space_forbidden", "You can't create artifacts");
  };
  if (artifactId === undefined) {
    mayCreate();
    artifactId = newId();
    stmts.push(
      db
        .prepare(
          "insert into reserved_artifacts (id, user_id, created_at) values (?, ?, ?)",
        )
        .bind(artifactId, user.id, now),
    );
  } else {
    const exists = await db
      .prepare("select 1 from artifacts where id = ?")
      .bind(artifactId)
      .first();
    if (exists) await authorize(env, who, artifactId, "upload");
    else {
      mayCreate();
      const r = await db
        .prepare(
          "select 1 from reserved_artifacts where id = ? and user_id = ?",
        )
        .bind(artifactId, user.id)
        .first();
      if (!r) throw notFound();
    }
  }
  // Hosted billing: a free instance's storage cap (off until set).
  await requireFreeStorage(env, input.size);
  const uploadId = newId();
  stmts.push(
    db
      .prepare(
        `insert into uploads (id, artifact_id, user_id, r2_key, size, content_type, path, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uploadId,
        artifactId,
        user.id,
        `files/${artifactId}/${newId()}`,
        input.size,
        contentType,
        p.path,
        now,
      ),
  );
  await db.batch(stmts);
  const exp = Math.floor(now / 1000) + LIMITS.uploadUrlTtlSec;
  const sig = await hmacSign(key, `${uploadId}:${exp}`);
  return {
    uploadId,
    artifactId,
    url: `${appOrigin(env)}${R.upload(uploadId)}?exp=${exp}&sig=${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Signed PUT of an upload's bytes. Bad/expired signature, unknown or consumed
 * upload → 404. Content-Length must equal the declared size (400). The body is
 * streamed to R2, never buffered. Write-once: the slot is claimed atomically
 * (received_at = -1) before streaming, so a second PUT → 409; received_at gets
 * the real time after a size-matched put, or is reset to NULL on failure.
 */
export async function putUpload(
  env: Env,
  uploadId: string,
  exp: string,
  sig: string,
  req: Request,
  now = Date.now(),
): Promise<void> {
  if (!isId(uploadId) || !/^\d{1,12}$/.test(exp) || !sig) throw notFound();
  if (Number(exp) * 1000 <= now) throw notFound();
  if (!(await hmacVerify(await signingKey(env), `${uploadId}:${exp}`, sig)))
    throw notFound();
  const row = await env.DB.prepare(
    "select r2_key, size, content_type from uploads where id = ? and consumed = 0",
  )
    .bind(uploadId)
    .first<{ r2_key: string; size: number; content_type: string }>();
  if (!row) throw notFound();
  const len = req.headers.get("content-length");
  if (
    len === null ||
    !/^\d+$/.test(len) ||
    Number(len) !== row.size ||
    !req.body
  )
    throw new ApiError(
      "bad_request",
      "Content-Length must equal the declared size",
      {
        expected: row.size,
      },
    );
  // Write-once: claim the slot atomically (received_at = -1 while in flight).
  const claim = await env.DB.prepare(
    "update uploads set received_at = -1 where id = ? and received_at is null and consumed = 0",
  )
    .bind(uploadId)
    .run();
  if (!claim.meta.changes)
    throw new ApiError("conflict", "Upload already received");
  const release = async () => {
    await env.FILES.delete(row.r2_key).catch(() => {});
    await env.DB.prepare(
      "update uploads set received_at = null where id = ? and received_at = -1",
    )
      .bind(uploadId)
      .run();
  };
  let obj: R2Object | null;
  try {
    obj = await env.FILES.put(row.r2_key, req.body, {
      httpMetadata: { contentType: row.content_type },
    });
  } catch (e) {
    await release();
    throw e;
  }
  if (!obj || obj.size !== row.size) {
    await release();
    throw new ApiError(
      "bad_request",
      "Body size must equal the declared size",
      {
        expected: row.size,
      },
    );
  }
  await env.DB.prepare(
    "update uploads set received_at = ? where id = ? and received_at = -1",
  )
    .bind(now, uploadId)
    .run();
}

const SWEEP_BATCH = 500;

/**
 * Deletes unconsumed uploads older than LIMITS.uploadTtlHours (row + R2 object),
 * then reservations that old with no artifact and no remaining upload.
 * Returns the number of uploads deleted.
 */
export async function sweepUploads(env: Env, now: number): Promise<number> {
  const cutoff = now - LIMITS.uploadTtlHours * 3600 * 1000;
  const db = env.DB;
  const { results } = await db
    .prepare(
      "select id, r2_key from uploads where consumed = 0 and created_at < ? limit ?",
    )
    .bind(cutoff, SWEEP_BATCH)
    .all<{ id: string; r2_key: string }>();
  if (results.length) {
    await env.FILES.delete(results.map((r) => r.r2_key));
    await db
      .prepare(
        "delete from uploads where id in (select value from json_each(?))",
      )
      .bind(JSON.stringify(results.map((r) => r.id)))
      .run();
  }
  await db
    .prepare(
      `delete from reserved_artifacts where created_at < ?
         and not exists (select 1 from artifacts a where a.id = reserved_artifacts.id)
         and not exists (select 1 from uploads u where u.artifact_id = reserved_artifacts.id)`,
    )
    .bind(cutoff)
    .run();
  return results.length;
}

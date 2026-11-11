import {
  contentTypeFor,
  isId,
  LIMITS,
  type Member,
  newId,
  normalizePath,
  planOf,
  R,
  type UploadCreated,
  type UploadCreateInput,
} from "@oa/shared";
import {
  authorize,
  callerOf,
  capOfCaller,
  planOfMember,
} from "../auth/authz.js";
import { contentKey } from "../auth/keys.js";
import { orgCan } from "../auth/policy.js";
import { requireFreeStorage } from "../billing/caps.js";
import { refuseViewOnly } from "../billing/plan.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { sha256Sink } from "../util/digest.js";

const CONTENT_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9_.+-]+=("[^"\\\r\n]*"|[a-z0-9_.+-]+))*$/i;
const OVER_CAP = `The file is over ${LIMITS.fileBytes / 1024 / 1024} MB; Open Artifacts takes files up to ${LIMITS.fileBytes / 1024 / 1024} MB.`;
const notFound = () => new ApiError("not_found", "Not found");

/** Upload URLs: the "oa:upload" subkey (never the content-token one). */
const signingKey = (env: Env) => contentKey(env, "oa:upload");

/** An upload URL's `sig` for `uploadId` expiring at `exp` (unix seconds). */
export const signUpload = async (
  env: Env,
  uploadId: string,
  exp: number,
): Promise<string> => hmacSign(await signingKey(env), `${uploadId}:${exp}`);

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
  // No size: the server measures the bytes at PUT (stored as 0 until then).
  const declared = input.size;
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(declared) || declared <= 0)
  )
    throw new ApiError(
      "bad_request",
      "size must be a positive whole number of bytes. Fix it, or omit size and the server measures the file.",
      { path: input.path, reason: "invalid_size" },
    );
  if (declared !== undefined && declared > LIMITS.fileBytes)
    throw new ApiError("too_large", OVER_CAP, {
      path: input.path,
      reason: "too_large",
    });
  const contentType = input.contentType ?? contentTypeFor(p.path);
  if (contentType.length > 200 || !CONTENT_TYPE.test(contentType))
    throw new ApiError(
      "bad_request",
      "Invalid contentType. Use a MIME type such as text/html or application/pdf.",
      {
        path: input.path,
        reason: "invalid_content_type",
      },
    );
  // A missing or short key fails here, before any row is written.
  await signingKey(env);
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  let artifactId = input.artifactId;
  const who = callerOf(user);
  // Reserving or uploading into a new artifact is a create (capped callers can't).
  const mayCreate = () => {
    // An unpaid Solo is view-only: no new artifact, so no upload into one.
    refuseViewOnly(planOfMember(user));
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
  // (Without a size it is checked at PUT, against the measured bytes.)
  if (declared !== undefined) await requireFreeStorage(env, declared);
  const uploadId = newId();
  stmts.push(
    db
      .prepare(
        `insert into uploads (id, artifact_id, user_id, r2_key, size, content_type, path, created_at, expected_sha256)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uploadId,
        artifactId,
        user.id,
        `files/${artifactId}/${newId()}`,
        declared ?? 0,
        contentType,
        p.path,
        now,
        input.sha256 ?? null,
      ),
  );
  await db.batch(stmts);
  const exp = Math.floor(now / 1000) + LIMITS.uploadUrlTtlSec;
  const sig = await signUpload(env, uploadId, exp);
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
    "select r2_key, size, content_type, expected_sha256 from uploads where id = ? and consumed = 0",
  )
    .bind(uploadId)
    .first<{
      r2_key: string;
      size: number;
      content_type: string;
      expected_sha256: string | null;
    }>();
  if (!row) throw notFound();
  const len = req.headers.get("content-length");
  const measure = row.size === 0; // created without a size
  if (!measure) {
    if (
      len === null ||
      !/^\d+$/.test(len) ||
      Number(len) !== row.size ||
      !req.body
    )
      throw new ApiError(
        "bad_request",
        "Content-Length must equal the declared size. Send exactly the declared bytes, or create a new upload without a size.",
        { expected: row.size },
      );
  } else {
    if (!req.body)
      throw new ApiError(
        "bad_request",
        "The PUT has no body. Send the file's bytes.",
      );
    if (len === null || !/^\d+$/.test(len))
      throw new ApiError(
        "bad_request",
        "The PUT has no Content-Length. Send a Content-Length header; curl -T and fetch with a Blob do this.",
        { reason: "length_required" },
      );
    if (Number(len) > LIMITS.fileBytes)
      throw new ApiError("too_large", OVER_CAP, { reason: "too_large" });
  }
  // Unsized: refuse an over-cap instance before storing anything (re-checked on the measured bytes below).
  if (measure) await requireFreeStorage(env, Number(len));
  // Write-once: claim the slot atomically (received_at = -1 while in flight).
  const claim = await env.DB.prepare(
    "update uploads set received_at = -1 where id = ? and received_at is null and consumed = 0",
  )
    .bind(uploadId)
    .run();
  if (!claim.meta.changes)
    throw new ApiError(
      "conflict",
      "Upload already received. Create a new one with create_upload to send different bytes.",
    );
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
      ...(row.expected_sha256 ? { sha256: row.expected_sha256 } : {}),
    });
  } catch (e) {
    await release();
    if (
      row.expected_sha256 &&
      e instanceof Error &&
      /\(10037\)$/.test(e.message)
    )
      throw new ApiError(
        "bad_request",
        "Upload SHA-256 does not match the declared checksum. Send the original bytes or create a new upload with their checksum.",
      );
    throw e;
  }
  let finalSize = row.size;
  if (measure) {
    if (!obj || obj.size <= 0 || obj.size > LIMITS.fileBytes) {
      await release();
      throw obj && obj.size > LIMITS.fileBytes
        ? new ApiError("too_large", OVER_CAP, { reason: "too_large" })
        : new ApiError(
            "bad_request",
            "The body is empty. Send the file's bytes.",
          );
    }
    try {
      await requireFreeStorage(env, obj.size);
    } catch (e) {
      await release();
      throw e;
    }
    finalSize = obj.size;
  } else if (!obj || obj.size !== row.size) {
    await release();
    throw new ApiError(
      "bad_request",
      "Body size must equal the declared size. Send exactly the declared bytes, or create a new upload without a size.",
      {
        expected: row.size,
      },
    );
  }
  // R2 verified the supplied checksum while storing the bytes. Without one,
  // paid plans reread and hash; Free keeps null to stay within its CPU budget.
  let digest: string | null = row.expected_sha256;
  if (!digest && planOf(env.PLAN) === "paid") {
    try {
      const stored = await env.FILES.get(row.r2_key);
      if (!stored) throw new Error("upload not readable after put");
      const sink = sha256Sink();
      await stored.body.pipeTo(sink.writable);
      digest = await sink.hex();
    } catch (e) {
      await release();
      throw e;
    }
  }
  await env.DB.prepare(
    "update uploads set size = ?, received_at = ?, digest = ? where id = ? and received_at = -1",
  )
    .bind(finalSize, now, digest, uploadId)
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

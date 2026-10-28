import {
  ArtifactPatchSchema,
  INLINE_TOO_LARGE_MESSAGE,
  isId,
  LIMITS,
  ListQuerySchema,
  MoveArtifactInputSchema,
  type PublishInput,
  PublishInputSchema,
  R,
  TransferArtifactInputSchema,
  TrashQuerySchema,
} from "@oa/shared";
import type { Context } from "hono";
import { authorize, caller, callerOf, requireUser } from "../auth/authz.js";
import { isPubliclyServable } from "../auth/policy.js";
import {
  contentViewer,
  publicPrefix,
  signContent,
} from "../content/signing.js";
import { jsonBody, readCapped } from "../http/body.js";
import { ApiError, contentOrigin } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import type { AgentAttr } from "../services/agent-usage.js";
import {
  getSummary,
  list,
  listVersions,
  patch,
  publish,
  putThumbnail,
  readThumbnail,
  readVersionFile,
  restoreVersion,
  softDelete,
  undelete,
} from "../services/artifacts.js";
import { planFiles, RESERVED_KEYS } from "../services/manifest.js";
import { putExtractedText } from "../services/search.js";
import {
  moveArtifact,
  requireSpaces,
  transferArtifact,
} from "../services/spaces.js";
import { listTrash } from "../services/trash.js";
import { utf8Decoder } from "../util/text.js";
import type { AppType } from "./index.js";

// JSON escaping at most doubles inline text (`"` and `\`; base64 is 4/3), plus
// 64 KB for the rest of the body. A body past it can only be oversize inline
// content: 413 with the upload hint, from Content-Length before it is read or
// parsed, so an oversize burst costs no JSON.parse. (Text of control
// characters, escaped 6×, can be refused under the limit; uploads take it.)
const MAX_BODY = 2 * LIMITS.inlineBytes + 64 * 1024;
const ARTIFACT = "/api/v1/artifacts/:id";
const VERSIONS = `${ARTIFACT}/versions`;
const VERSION_FILE = `${VERSIONS}/:v/files/*`;
const MAX_PATCH = 64 * 1024;
const VERSION_NUM = /^[1-9]\d{0,8}$/;

// Module-scope warm-up (startup limit, not a request's CPU): zod builds a
// schema's parser on its first parse, ~1 ms of a cold isolate's first request.
ListQuerySchema.safeParse({ limit: "25" });
PublishInputSchema.safeParse({ title: "t", format: "html", content: "" });

/** Parses PublishInput; schema failures re-run planFiles for a precise {path, reason}. */
async function publishInput(
  c: Context<AppEnv>,
  id?: string,
): Promise<PublishInput> {
  const buf = await readCapped(c, MAX_BODY, INLINE_TOO_LARGE_MESSAGE);
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decoder.decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
  const files = (raw as { files?: unknown } | null)?.files;
  if (files && typeof files === "object")
    for (const k of RESERVED_KEYS)
      if (Object.hasOwn(files, k))
        throw new ApiError(
          "bad_request",
          `Invalid file "${k}": reserved_name`,
          {
            path: k,
            reason: "reserved_name",
          },
        );
  if (id !== undefined && raw && typeof raw === "object" && !Array.isArray(raw))
    (raw as { id?: unknown }).id = id;
  const r = PublishInputSchema.safeParse(raw);
  if (r.success) return r.data;
  if (raw && typeof raw === "object") planFiles(raw as PublishInput);
  throw new ApiError("bad_request", "Invalid request body", r.error.issues);
}

/** REST attribution: the PAT label when authenticated by token, else none. */
const agentOf = (c: Context<AppEnv>): AgentAttr | null =>
  c.var.tokenId && c.var.tokenLabel
    ? {
        name: c.var.tokenLabel,
        version: null,
        via: { kind: "token", id: c.var.tokenId },
      }
    : null;

const notFound = () => new ApiError("not_found", "Not found");

/** The :id param, or 404 for anything that isn't an id. */
const idParam = (c: Context<AppEnv>): string => {
  const id = c.req.param("id");
  if (!id || !isId(id)) throw notFound();
  return id;
};
const versionParam = (c: Context<AppEnv>): number => {
  const v = c.req.param("v") ?? "";
  if (!VERSION_NUM.test(v)) throw notFound();
  return Number(v);
};

/** The decoded file path after `/files/`, from the raw URL; malformed → 404. */
function filePath(c: Context<AppEnv>): string {
  const raw = new URL(c.req.url).pathname;
  const i = raw.indexOf("/files/");
  if (i < 0) throw notFound();
  try {
    return raw
      .slice(i + "/files/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  } catch {
    throw notFound();
  }
}

/** RFC 5987 ext-value: encodeURIComponent plus the ' ( ) * it leaves bare. */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function mountArtifacts(app: AppType): void {
  app.get(R.artifacts, async (c) => {
    const user = requireUser(c);
    const q = ListQuerySchema.safeParse(c.req.query());
    if (!q.success)
      throw new ApiError("bad_request", "Invalid query", q.error.issues);
    return c.json(await list(c.env, callerOf(user), q.data));
  });

  // P4 item 9: what the caller may restore (services/trash.ts).
  app.get(R.trash, async (c) => {
    const user = requireUser(c);
    const q = TrashQuerySchema.safeParse(c.req.query());
    if (!q.success)
      throw new ApiError("bad_request", "Invalid query", q.error.issues);
    return c.json(await listTrash(c.env, callerOf(user), q.data));
  });

  app.get(ARTIFACT, async (c) =>
    c.json(await getSummary(c.env, caller(c), idParam(c))),
  );

  app.patch(ARTIFACT, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    const buf = await readCapped(c, MAX_PATCH);
    let raw: unknown;
    try {
      raw = JSON.parse(utf8Decoder.decode(buf));
    } catch {
      throw new ApiError("bad_request", "Invalid JSON body");
    }
    const p = ArtifactPatchSchema.safeParse(raw);
    if (!p.success)
      throw new ApiError("bad_request", "Invalid request body", p.error.issues);
    return c.json(await patch(c.env, user, id, p.data, execCtx(c)));
  });

  app.delete(ARTIFACT, async (c) => {
    const user = requireUser(c);
    await softDelete(c.env, user, idParam(c), execCtx(c));
    return c.body(null, 204);
  });

  // Hosted M1 (P3 T10): 404 without the spaces feature.
  app.post(`${ARTIFACT}/move`, async (c) => {
    requireSpaces(c.env);
    const user = requireUser(c);
    const id = idParam(c);
    const { spaceId } = await jsonBody(c, MoveArtifactInputSchema);
    return c.json(await moveArtifact(c.env, user, id, spaceId, execCtx(c)));
  });

  app.post(`${ARTIFACT}/transfer`, async (c) => {
    requireSpaces(c.env);
    const user = requireUser(c);
    const id = idParam(c);
    const { userId } = await jsonBody(c, TransferArtifactInputSchema);
    return c.json(await transferArtifact(c.env, user, id, userId, execCtx(c)));
  });

  app.post(`${ARTIFACT}/undelete`, async (c) => {
    const user = requireUser(c);
    return c.json(await undelete(c.env, user, idParam(c), execCtx(c)));
  });

  // Viewer+. Defaults to the current version; ?v= must exist (else 404).
  // `version` names the one served, so a caller fetching this in parallel
  // with the artifact keeps its version consistent across a publish.
  app.get(`${ARTIFACT}/content-url`, async (c) => {
    const id = idParam(c);
    const { artifact: a } = await authorize(
      c.env,
      caller(c),
      id,
      "content.mint",
    );
    const q = c.req.query("v");
    if (q !== undefined && !VERSION_NUM.test(q)) throw notFound();
    const v = q === undefined ? a.currentVersion : Number(q);
    const exists = await c.env.DB.prepare(
      "select 1 as ok from versions where artifact_id = ? and version = ?",
    )
      .bind(id, v)
      .first();
    if (!exists) throw notFound();
    const origin = contentOrigin(c.env);
    // Unsigned only when the artifact may be served publicly (the same rule
    // as the content host's /p/); otherwise a signed, expiring URL.
    if (
      isPubliclyServable({
        visibility: a.visibility,
        deleted: a.deletedAt != null,
      })
    )
      return c.json({
        url: `${origin}${publicPrefix(id, v)}__view`,
        expiresAt: null,
        version: v,
      });
    // Bound to the viewer (content_revocation): the content host re-checks
    // their status and epoch on every file (P3 T11).
    const { prefix, exp } = await signContent(
      c.env,
      id,
      v,
      Date.now(),
      LIMITS.signedUrlTtlSec,
      "frame",
      contentViewer(c.env, c.var.user?.id, c.var.sessionEpoch),
    );
    return c.json({
      url: `${origin}${prefix}__view`,
      expiresAt: new Date(exp * 1000).toISOString(),
      version: v,
    });
  });

  app.get(VERSIONS, async (c) => {
    const id = idParam(c);
    const b = c.req.query("before");
    if (b !== undefined && !VERSION_NUM.test(b))
      throw new ApiError("bad_request", "before must be a positive integer", {
        path: "before",
        reason: "invalid",
      });
    return c.json(
      await listVersions(
        c.env,
        caller(c),
        id,
        b === undefined ? undefined : Number(b),
      ),
    );
  });

  app.get(VERSION_FILE, async (c) => {
    const id = idParam(c);
    const v = versionParam(c);
    const path = filePath(c);
    const { body, contentType } = await readVersionFile(
      c.env,
      caller(c),
      id,
      v,
      path,
    );
    const name = path.slice(path.lastIndexOf("/") + 1);
    return new Response(body.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.size),
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename*=UTF-8''${rfc5987(name)}`,
        "Cache-Control": "private, no-store",
      },
    });
  });

  app.post(`${VERSIONS}/:v/restore`, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    const v = versionParam(c);
    return c.json(
      await restoreVersion(c.env, user, id, v, agentOf(c), execCtx(c)),
      201,
    );
  });

  // Signed-in viewer+ contributes a pdf version's text (text/plain, ≤ extractedTextBytes).
  app.put(`${VERSIONS}/:v/text`, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    const v = versionParam(c);
    const ct = c.req.header("content-type") ?? "";
    if (!/^text\/plain\s*(;|$)/i.test(ct))
      throw new ApiError("bad_request", "Content-Type must be text/plain");
    const buf = await readCapped(c, LIMITS.extractedTextBytes);
    await putExtractedText(
      c.env,
      callerOf(user),
      id,
      v,
      utf8Decoder.decode(buf),
    );
    return c.body(null, 204);
  });

  app.get(`${ARTIFACT}/thumbnail`, async (c) => {
    const body = await readThumbnail(c.env, caller(c), idParam(c));
    return new Response(body.body, {
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(body.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });

  /**
   * PUT thumbnail (image/webp, ≤ LIMITS.thumbnailBytes). Optional `?v=` is
   * the version the image depicts (default: the current one). A thumbnail is
   * only replaced by one of the same or a newer version: an upload for an
   * older version than the stored thumbnail answers 409 conflict (so a client
   * knows its image was not used), never silently ignored.
   */
  app.put(`${ARTIFACT}/thumbnail`, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    const vq = c.req.query("v");
    if (vq !== undefined && !/^[1-9]\d{0,8}$/.test(vq))
      throw new ApiError("bad_request", "v must be a version number");
    const ct = c.req.header("content-type") ?? "";
    if (!/^image\/webp\s*(;|$)/i.test(ct))
      throw new ApiError("bad_request", "Content-Type must be image/webp");
    const buf = await readCapped(c, LIMITS.thumbnailBytes);
    await putThumbnail(
      c.env,
      user,
      id,
      buf,
      vq === undefined ? undefined : Number(vq),
    );
    return c.body(null, 204);
  });

  app.post(R.artifacts, async (c) => {
    const user = requireUser(c);
    const input = await publishInput(c);
    return c.json(
      await publish(c.env, user, input, agentOf(c), execCtx(c), "create"),
      201,
    );
  });

  app.post(VERSIONS, async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    if (!isId(id)) throw new ApiError("not_found", "Not found");
    const input = await publishInput(c, id);
    return c.json(
      await publish(c.env, user, input, agentOf(c), execCtx(c), "version"),
      201,
    );
  });
}

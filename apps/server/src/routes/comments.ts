import type { AccessLevel } from "@oa/shared";
import {
  ANON_ID_HEADER,
  isId,
  NewThreadBodySchema,
  ReplyBodySchema,
} from "@oa/shared";
import type { Context } from "hono";
import { z } from "zod";
import type { ArtifactRow } from "../auth/authz.js";
import { authorize, caller, canCtx } from "../auth/authz.js";
import { can, type PolicyAction } from "../auth/policy.js";
import { readCapped } from "../http/body.js";
import { isEmbedRequest } from "../http/embed.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { resolveAnonId } from "../runtime/anon-id.js";
import { ipKey } from "../runtime/routes.js";
import type { AgentAttr } from "../services/agent-usage.js";
import {
  addReply,
  addThread,
  type CommentViewer,
  type CommentWho,
  deleteComment,
  editComment,
  listComments,
  setStatus,
} from "../services/comments.js";
import { utf8Decoder } from "../util/text.js";
import type { AppType } from "./index.js";

// Comments on any artifact (#682, part 1): REST over the artifact's DO.
// The policy table is the floor (open access; sign in for writes unless the
// artifact lets anonymous visitors write data); the handlers add the embed
// refusal, comments_off and who may edit or delete.

const ART = "/api/v1/artifacts/:id";
const COMMENTS = `${ART}/comments`;
const THREAD = `${COMMENTS}/:threadId`;
const REPLIES = `${THREAD}/replies`;
const COMMENT = `${THREAD}/comments/:commentId`;

/** A body is at most 2,000 characters; the anchor adds under 3 KB. */
const MAX_BODY = 32 * 1024;

/** Thread and comment ids are ids; anything else is not a resource. */
const idParam = (c: Context<AppEnv>, name: string): string => {
  const v = c.req.param(name);
  if (!v || !isId(v)) throw new ApiError("bad_request", `Invalid ${name}`);
  return v;
};

async function jsonOf(c: Context<AppEnv>): Promise<unknown> {
  const buf = await readCapped(c, MAX_BODY);
  try {
    return JSON.parse(utf8Decoder.decode(buf));
  } catch {
    throw new ApiError("bad_request", "Invalid JSON body");
  }
}

/** REST attribution: the PAT label when authenticated by token. */
const agentOf = (c: Context<AppEnv>): AgentAttr | null =>
  c.var.tokenId && c.var.tokenLabel
    ? {
        name: c.var.tokenLabel,
        version: null,
        via: { kind: "token", id: c.var.tokenId },
      }
    : null;

/**
 * Authorization shared by every comment route: access for `action` (404
 * otherwise), then no embeds (403), then comments on (403 comments_off).
 */
async function open(c: Context<AppEnv>, action: PolicyAction) {
  const id = c.req.param("id") ?? "";
  const who = caller(c);
  const { level, artifact } = await authorize(c.env, who, id, action);
  if (isEmbedRequest(c.req.raw) || c.req.header("x-oa-embed") === "1")
    throw new ApiError("forbidden", "Comments are not available in an embed");
  if (artifact.comments !== 1)
    throw new ApiError("comments_off", "Comments are off for this artifact");
  return { id, who, level, artifact };
}

/** The signed-in person, or a signed-out visitor's anonymous identity (minted when `mint`). */
async function identity(
  c: Context<AppEnv>,
  artifactId: string,
  mint: boolean,
  moderator = false,
): Promise<{
  who: CommentWho | null;
  viewer: CommentViewer;
  issued: string | null;
}> {
  const user = c.var.user;
  if (user)
    return {
      who: { kind: "user", id: user.id, agent: agentOf(c) },
      viewer: { userId: user.id, short: null, moderator },
      issued: null,
    };
  const anon = await resolveAnonId(
    c.env,
    artifactId,
    c.req.header(ANON_ID_HEADER),
    mint,
  );
  const viewer = { userId: null, short: anon?.short ?? null, moderator };
  if (!anon || !mint) return { who: null, viewer, issued: null };
  // The per-IP key the DO limits by (10 a minute): an IPv6 address by its /64.
  const key = ipKey(c.req.header("cf-connecting-ip") ?? "");
  if (!key)
    throw new ApiError("rate_limited", "Anonymous access is unavailable");
  return {
    who: { kind: "guest", short: anon.short, rate: `ip:${key}` },
    viewer,
    issued: anon.issued,
  };
}

/** `res` carrying a newly minted anonymous id token, as data writes do. */
function withAnon(issued: string | null, res: Response): Response {
  if (!issued) return res;
  const out = new Response(res.body, res);
  out.headers.set(ANON_ID_HEADER, issued);
  out.headers.set("cache-control", "no-store");
  return out;
}

const StatusQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
});
const StatusPatch = z.strictObject({ status: z.enum(["open", "resolved"]) });
const EditBody = z.strictObject({ body: z.string() });

/** A body that failed its schema: the anchor's issues are invalid_anchor, the body's invalid_body. */
const bad = (issues: { path: PropertyKey[] }[]): never => {
  const first = issues[0]?.path[0];
  if (first === "anchor")
    throw new ApiError("invalid_anchor", "Invalid anchor", issues);
  if (first === "body")
    throw new ApiError(
      "invalid_body",
      "A comment is 1 to 2,000 characters after trimming",
    );
  throw new ApiError("bad_request", "Invalid request body", issues);
};

export function mountComments(app: AppType): void {
  app.get(COMMENTS, async (c) => {
    const {
      id,
      who: cw,
      level,
      artifact: art,
    } = await open(c, "comments.read");
    const q = StatusQuery.safeParse({
      status: c.req.query("status") ?? undefined,
    });
    if (!q.success) throw new ApiError("bad_request", "Invalid status");
    const { viewer } = await identity(c, id, false, modOf(cw, level, art));
    const out = await listComments(c.env, id, q.data.status, viewer);
    return c.json(out);
  });

  app.post(COMMENTS, async (c) => {
    const { id, artifact, who: cw, level } = await open(c, "comments.write");
    const raw = NewThreadBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const { who, viewer, issued } = await identity(
      c,
      id,
      true,
      modOf(cw, level, artifact),
    );
    if (!who) throw new ApiError("unauthorized", "Sign in to comment");
    const named = raw.data.guestName;
    const w: CommentWho =
      who.kind === "guest" && named !== undefined
        ? { ...who, name: named }
        : who;
    const t = await addThread(c.env, artifact, w, viewer, raw.data);
    return withAnon(issued, c.json(t, 201));
  });

  app.post(REPLIES, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const raw = ReplyBodySchema.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    const { who, viewer, issued } = await identity(
      c,
      id,
      true,
      modOf(cw, level, artifact),
    );
    if (!who) throw new ApiError("unauthorized", "Sign in to comment");
    const w: CommentWho =
      who.kind === "guest" && raw.data.guestName !== undefined
        ? { ...who, name: raw.data.guestName }
        : who;
    const out = await addReply(c.env, id, threadId, w, viewer, raw.data.body);
    return withAnon(issued, c.json(out, 201));
  });

  app.patch(THREAD, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const raw = StatusPatch.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    // No mint here: a guest resolves under the identity they commented with.
    const { who: signed, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    let who = signed;
    if (!who) {
      // A guest with no token still resolves, as "Guest" (me false), against
      // the per-IP limit.
      const key = ipKey(c.req.header("cf-connecting-ip") ?? "");
      if (!key)
        throw new ApiError("rate_limited", "Anonymous access is unavailable");
      who = { kind: "guest", short: viewer.short ?? "", rate: `ip:${key}` };
    }
    const out = await setStatus(
      c.env,
      id,
      threadId,
      who,
      viewer,
      raw.data.status,
    );
    return c.json(out);
  });

  app.patch(COMMENT, async (c) => {
    const { id, who: cw, level, artifact } = await open(c, "comments.write");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const raw = EditBody.safeParse(await jsonOf(c));
    if (!raw.success) return bad(raw.error.issues);
    // An author edits: a guest by the identity they wrote under, never minted here.
    const { who, viewer } = await identity(
      c,
      id,
      false,
      modOf(cw, level, artifact),
    );
    const actor = who ?? guestOf(viewer);
    if (!actor)
      throw new ApiError("forbidden", "Only the author can edit a comment");
    const out = await editComment(
      c.env,
      id,
      threadId,
      commentId,
      actor,
      viewer,
      raw.data.body,
    );
    return c.json(out);
  });

  app.delete(COMMENT, async (c) => {
    const {
      id,
      who: callerWho,
      level,
      artifact,
    } = await open(c, "comments.read");
    const threadId = idParam(c, "threadId");
    const commentId = idParam(c, "commentId");
    const { who, viewer } = await identity(c, id, false);
    const actor = who ?? guestOf(viewer);
    const moderator = modOf(callerWho, level, artifact);
    await deleteComment(c.env, id, threadId, commentId, actor, moderator);
    return c.body(null, 204);
  });
}

/** Whether the caller's level may delete anyone's comment. */
const modOf = (
  who: ReturnType<typeof caller>,
  level: AccessLevel,
  artifact: ArtifactRow,
): boolean => can(level, "comments.moderate", canCtx(who, artifact));

/** A guest who only reads back (no mint): as an author for edit and delete. */
function guestOf(viewer: CommentViewer): CommentWho | null {
  return viewer.short === null
    ? null
    : { kind: "guest", short: viewer.short, rate: "" };
}

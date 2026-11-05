import { z } from "zod";
import {
  type Anchor,
  noteAnchorSchema,
  pinAnchorSchema,
  textAnchorSchema,
} from "./anchor.js";
import { stripNameControls } from "./schemas.js";

// Comments on any artifact (#682, part 1: store and REST). Contract with the
// dashboard; the MCP tools (part 2) reuse these shapes.

/** Longest comment body, in characters, after trim. */
export const COMMENT_BODY_MAX = 2000;
/** Longest guest display name, in characters. */
export const GUEST_NAME_MAX = 50;
/** The name shown when a signed-out commenter gives none. */
export const GUEST_NAME_DEFAULT = "Guest";
/** GET R.comments: most threads returned. */
export const COMMENTS_MAX_THREADS = 500;
/** GET R.comments: most replies returned per thread (the root is extra). */
export const COMMENTS_MAX_REPLIES = 200;
/** A pin's contentHash. */
export const CONTENT_HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Who wrote a comment. Never an email. `id` only for users. `agent` is the
 * agent's name when the comment came through an agent connection, as the
 * viewer may see it (a private token label shows as "<owner>'s agent").
 */
export const CommentAuthorSchema = z.object({
  kind: z.enum(["user", "guest"]),
  id: z.string().optional(),
  name: z.string(),
  agent: z.string().optional(),
  me: z.boolean(),
});
export type CommentAuthor = z.infer<typeof CommentAuthorSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: CommentAuthorSchema,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentStatusSchema = z.enum(["open", "resolved"]);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  anchor: z.union([noteAnchorSchema, textAnchorSchema, pinAnchorSchema]),
  version: z.number().int().min(1),
  status: CommentStatusSchema,
  resolvedBy: CommentAuthorSchema.nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  /** The first comment is the root. */
  comments: z.array(CommentSchema),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const CommentListSchema = z.object({
  threads: z.array(ThreadSchema),
  /** Open threads on the artifact, whatever the filter. */
  open: z.number().int().min(0),
  truncated: z.boolean(),
});
export type CommentList = z.infer<typeof CommentListSchema>;

export const CommentListQuerySchema = z.object({
  status: z.enum(["open", "resolved", "all"]).default("all"),
});

const version = z.number().int().min(1);
/** An anchor as a client posts it: `version` is optional (missing means the current one). */
export const anchorInputSchema = z.discriminatedUnion("kind", [
  noteAnchorSchema,
  textAnchorSchema.extend({ version: version.optional() }),
  pinAnchorSchema.extend({ version: version.optional() }),
]);
export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type { Anchor };

const body = z.string();
const guestName = z.string().optional();

export const NewThreadSchema = z.strictObject({
  anchor: z.unknown(),
  body,
  guestName,
});
export const NewReplySchema = z.strictObject({ body, guestName });
export const ThreadStatusPatchSchema = z.strictObject({
  status: CommentStatusSchema,
});
export const CommentEditSchema = z.strictObject({ body });

/** A guest name as stored: controls stripped, trimmed, at most GUEST_NAME_MAX characters; blank is "Guest". */
export function cleanGuestName(raw: string | undefined): string {
  const cut = [
    ...stripNameControls(raw ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, GUEST_NAME_MAX)
    .join("")
    .trim();
  return cut === "" ? GUEST_NAME_DEFAULT : cut;
}

/** What `{type:"comments"}` frames on R.events carry: the open count only. */
export type CommentsFrame = { type: "comments"; open: number };

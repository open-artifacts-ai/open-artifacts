import { z } from "zod";
import {
  anchorSchema,
  noteAnchorSchema,
  pinAnchorSchema,
  textAnchorSchema,
} from "./anchor.js";

// Comments REST contract (#682): /api/v1/artifacts/:id/comments. The shell and
// the MSW mocks build against these; the Backend implements the same shapes.

export const COMMENT_BODY_MAX = 2000;
export const COMMENT_GUEST_NAME_MAX = 50;

export const CommentAuthorSchema = z.object({
  kind: z.enum(["user", "guest"]),
  id: z.string().optional(),
  name: z.string(),
  /** An agent acting for the person, e.g. "via Claude Code". */
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
  can: z.object({ edit: z.boolean(), delete: z.boolean() }),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentThreadSchema = z.object({
  id: z.string(),
  anchor: anchorSchema,
  version: z.number().int().min(1),
  status: z.enum(["open", "resolved"]),
  resolvedBy: CommentAuthorSchema.nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  /** The first comment is the root. */
  comments: z.array(CommentSchema),
});
export type CommentThread = z.infer<typeof CommentThreadSchema>;

export const CommentListSchema = z.object({
  threads: z.array(CommentThreadSchema),
  open: z.number().int().min(0),
  truncated: z.boolean(),
});
export type CommentList = z.infer<typeof CommentListSchema>;

export type CommentStatusFilter = "open" | "resolved" | "all";

/** An anchor as a client sends it: `version` is optional on text and pin (the current version). */
export const anchorInputSchema = z.discriminatedUnion("kind", [
  noteAnchorSchema,
  textAnchorSchema.extend({
    version: textAnchorSchema.shape.version.optional(),
  }),
  pinAnchorSchema.extend({ version: pinAnchorSchema.shape.version.optional() }),
]);
export type AnchorInput = z.infer<typeof anchorInputSchema>;

const commentBody = z.string().trim().min(1).max(COMMENT_BODY_MAX);
const guestName = z.string().max(COMMENT_GUEST_NAME_MAX).optional();

/** POST R.comments body. */
export const NewThreadBodySchema = z.object({
  anchor: anchorInputSchema,
  body: commentBody,
  guestName,
});
export type NewThreadBody = z.infer<typeof NewThreadBodySchema>;

/** POST R.commentReplies body. */
export const ReplyBodySchema = z.object({ body: commentBody, guestName });
export type ReplyBody = z.infer<typeof ReplyBodySchema>;

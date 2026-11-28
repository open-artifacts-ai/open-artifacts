import { Buffer } from "node:buffer";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CommentThread, Comment as CommentView } from "@oa/shared";
import { authorize, canCtx, capOfCaller } from "../../auth/authz.js";
import { can, capsReads, isGuestRole } from "../../auth/policy.js";
import { ApiError } from "../../http/errors.js";
import { placeAskSlot, removeAskSlot } from "../../services/ask-slots.js";
import {
  getPicture,
  previewForAgent,
} from "../../services/comment-pictures.js";
import {
  addReply,
  addThread,
  type CommentViewer,
  type CommentWho,
  editComment,
  listComments,
  listThread,
  setStatus,
  withdrawAsk,
} from "../../services/comments.js";
import { mentionedHandles } from "../../services/person-handles.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

// #682 part 2: the comments service over /mcp. The same service functions
// as the REST routes (routes/comments.ts), so the limits, the body and
// anchor checks, the rate bucket (`u:<user>`) and the `comment` notice are
// one implementation. The caller is always a signed-in member: a guest has
// no MCP session.

/** The DO's bare "Not found" for a missing thread, said so (the artifact is already proven). */
async function threadOf<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.code === "not_found")
      throw new ApiError(
        "not_found",
        "No such thread on this artifact. Get threadId from list_comments.",
      );
    throw e;
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function commentForTool(c: CommentView) {
  return c.people?.length
    ? { ...c, mentions: [...(c.mentions ?? []), ...c.people] }
    : c;
}

function threadForTool(thread: CommentThread) {
  return { ...thread, comments: thread.comments.map(commentForTool) };
}

function threadsForTool<T extends { threads: CommentThread[] }>(list: T) {
  return { ...list, threads: list.threads.map(threadForTool) };
}

/**
 * #3163: what a write returns by default: ids and status, not the comment.
 * Kept: `notice` (a non-fatal note, such as a cross-page replace that did not
 * finish), `askedBy`, and the mentioned agents a notice could not reach.
 * `status` only when it is known: a plain reply never says the thread's.
 */
function compact(
  threadId: string,
  c: CommentView | undefined,
  status?: string,
): Record<string, unknown> {
  const gone = (c?.mentions ?? [])
    .filter((m) => m.delivery === "gone")
    .map((m) => m.name);
  return {
    threadId,
    ...(c ? { commentId: c.id } : {}),
    ...(status ? { status } : {}),
    ...(c?.ask ? { askId: c.id } : {}),
    ...(c?.askedBy ? { askedBy: c.askedBy } : {}),
    ...(c?.people?.length ? { mentions: c.people } : {}),
    ...(c?.notice ? { notice: c.notice } : {}),
    ...(gone.length ? { notReached: gone } : {}),
  };
}

export function registerCommentTools(server: McpServer, t: ToolEnv): void {
  const { env, caller } = t;

  /** The REST gate: access for `action`, then comments on (403 comments_off). */
  async function open(id: string, action: "comments.read" | "comments.write") {
    const { level, artifact } = await authorize(env, caller, id, action);
    if (artifact.comments !== 1)
      throw new ApiError(
        "comments_off",
        "Comments are off for this artifact. The owner can turn them on in its settings.",
      );
    const viewer: CommentViewer = {
      agent: t.agentNow() ?? null,
      userId: t.user.id,
      short: null,
      guest: isGuestRole(t.user.role),
      capped: capsReads(capOfCaller(caller)),
      moderator: can(level, "comments.moderate", canCtx(caller, artifact)),
      caller,
    };
    const who: CommentWho = {
      kind: "user",
      id: t.user.id,
      agent: t.agentNow(),
    };
    return { artifact, viewer, who };
  }

  server.registerTool("list_comments", toolConfig("list_comments"), (i) =>
    guard(async () => {
      const { viewer } = await open(i.id, "comments.read");
      if (i.commentId !== undefined && i.threadId === undefined)
        throw new ApiError("bad_request", "commentId needs threadId.");
      if (i.threadId !== undefined) {
        if (
          i.answeredSince !== undefined ||
          i.mentionedSince !== undefined ||
          i.compact ||
          i.since !== undefined
        )
          throw new ApiError(
            "bad_request",
            "threadId reads one thread; leave out since, answeredSince, mentionedSince and compact.",
          );
        const one = await listThread(
          env,
          i.id,
          viewer,
          i.threadId,
          i.commentId,
          { withCursor: true },
        );
        const n = one.threads[0]?.comments.length ?? 0;
        return ok(
          `Thread ${i.threadId} on ${i.id}: ${plural(n, "comment")}${
            i.commentId !== undefined
              ? " (that comment, the one before it and the first)"
              : ""
          }.`,
          threadsForTool(one),
        );
      }
      // #3168: delta read from an earlier list_comments cursor.
      if (i.since !== undefined) {
        if (
          i.answeredSince !== undefined ||
          i.mentionedSince !== undefined ||
          i.compact
        )
          throw new ApiError(
            "bad_request",
            "since combines with status only; leave out answeredSince, mentionedSince and compact.",
          );
        const out = await listComments(env, i.id, i.status ?? "all", viewer, {
          since: i.since,
          withCursor: true,
        });
        if (out.threads.length === 0)
          return ok(`No changes on ${i.id} since your cursor.`, out);
        return ok(
          `${plural(out.threads.length, "changed thread")} on ${i.id} since your cursor (${out.open} open)${
            out.truncated ? ", more exist than are shown" : ""
          }.`,
          threadsForTool(out),
        );
      }
      if (
        i.compact &&
        i.answeredSince === undefined &&
        i.mentionedSince === undefined
      )
        throw new ApiError(
          "bad_request",
          "compact needs answeredSince or mentionedSince.",
        );
      if (i.answeredSince !== undefined || i.mentionedSince !== undefined) {
        const found = await listComments(env, i.id, i.status ?? "all", viewer, {
          ...(i.answeredSince !== undefined
            ? { answeredSince: i.answeredSince }
            : {}),
          ...(i.mentionedSince !== undefined
            ? { mentionedSince: i.mentionedSince }
            : {}),
          ...(i.compact ? { compact: true } : {}),
          withCursor: true,
        });
        if ("threads" in found) {
          return ok(
            `${plural(found.threads.length, "thread")} on ${i.id} since your time (${found.open} open)${
              found.truncated ? ", more exist than are shown" : ""
            }.`,
            threadsForTool(found),
          );
        }
        return ok(
          `${plural(found.answers?.length ?? 0, "answer")}, ${plural(found.mentions?.length ?? 0, "mention")} on ${i.id} since your time.`,
          found,
        );
      }
      const out = await listComments(env, i.id, i.status ?? "all", viewer, {
        withCursor: true,
      });
      return ok(
        `${plural(out.threads.length, "thread")} on ${i.id} (${out.open} open)${
          out.truncated ? ", more exist than are shown" : ""
        }.`,
        threadsForTool(out),
      );
    }),
  );

  server.registerTool(
    "get_comment_picture",
    toolConfig("get_comment_picture"),
    (i) =>
      guard(async () => {
        // The same gate as list_comments; the id is checked after it, so a
        // caller without access learns nothing from the id's shape.
        await open(i.id, "comments.read");
        const hit = await getPicture(
          env,
          i.id,
          i.pictureId,
          t.user.id,
          "agent",
        );
        const preview = await previewForAgent(env, hit);
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(preview.data).toString("base64"),
              mimeType: preview.mimeType,
            },
          ],
        };
      }),
  );

  server.registerTool("add_comment", toolConfig("add_comment"), (i) =>
    guard(async () => {
      const { artifact, viewer, who } = await open(i.id, "comments.write");
      const labels =
        viewer.moderator && !viewer.guest && !viewer.capped
          ? await mentionedHandles(env, i.body, i.id)
          : {};
      const targets = { people: Object.keys(labels), personLabels: labels };
      const opts = {
        moderator: viewer.moderator === true,
        after: {
          version: artifact.currentVersion,
          ...(t.exec ? { ctx: t.exec } : {}),
        },
      };
      if (i.threadId === undefined && i.requestCommentId !== undefined)
        throw new ApiError(
          "bad_request",
          "`requestCommentId` is for a reply: add `threadId`, or drop it.",
        );
      if (i.threadId !== undefined) {
        if (i.anchor !== undefined)
          throw new ApiError(
            "bad_request",
            "A reply has no anchor. Drop `anchor`, or drop `threadId` to start a new thread.",
          );
        const comment = await threadOf(
          addReply(
            env,
            i.id,
            i.threadId,
            who,
            viewer,
            i.body,
            {
              ...targets,
              ...(i.ask ? { ask: i.ask } : {}),
              ...(i.requestCommentId
                ? { requestCommentId: i.requestCommentId }
                : {}),
            },
            opts,
          ),
        );
        // #3163: ids and status by default; verbose: true keeps the full comment.
        return ok(
          `Replied in thread ${i.threadId} on ${i.id}.`,
          i.verbose
            ? { threadId: i.threadId, comment: commentForTool(comment) }
            : compact(
                i.threadId,
                comment,
                comment.ask
                  ? comment.ask.closed
                    ? "resolved"
                    : "open"
                  : undefined,
              ),
        );
      }
      const thread = await addThread(
        env,
        artifact,
        who,
        viewer,
        {
          anchor: i.anchor ?? { kind: "note" },
          body: i.body,
          ...targets,
          ...(i.ask ? { ask: i.ask } : {}),
        },
        opts,
      );
      // #3163: ids and status by default; verbose: true keeps the full thread.
      return ok(
        `Started thread ${thread.id} on ${i.id}.`,
        i.verbose
          ? { thread: threadForTool(thread) }
          : compact(thread.id, thread.comments[0], thread.status),
      );
    }),
  );

  server.registerTool("withdraw_ask", toolConfig("withdraw_ask"), (i) =>
    guard(async () => {
      const { viewer, who } = await open(i.id, "comments.write");
      const comment = await threadOf(
        withdrawAsk(
          env,
          i.id,
          i.threadId,
          i.commentId,
          who,
          viewer,
          i.replacedBy,
        ),
      );
      // #3163: ids and status by default; verbose: true keeps the full comment.
      return ok(
        `Withdrew the ask ${i.commentId} on ${i.id}.`,
        i.verbose
          ? { threadId: i.threadId, comment }
          : compact(
              i.threadId,
              comment,
              comment.ask?.withdrawn ? "withdrawn" : "open",
            ),
      );
    }),
  );

  server.registerTool("edit_comment", toolConfig("edit_comment"), (i) =>
    guard(async () => {
      const { viewer, who } = await open(i.id, "comments.write");
      const comment = await threadOf(
        editComment(
          env,
          i.id,
          i.threadId,
          i.commentId,
          who,
          viewer,
          i.body,
          true,
        ),
      );
      return ok(`Edited comment ${i.commentId} on ${i.id}.`, {
        threadId: i.threadId,
        comment,
      });
    }),
  );

  server.registerTool("resolve_comment", toolConfig("resolve_comment"), (i) =>
    guard(async () => {
      const { viewer, who } = await open(i.id, "comments.write");
      const resolved = i.resolved ?? true;
      const thread = await threadOf(
        setStatus(
          env,
          i.id,
          i.threadId,
          who,
          viewer,
          resolved ? "resolved" : "open",
        ),
      );
      // #3163: ids and status by default; verbose: true keeps the full thread.
      return ok(
        `Thread ${i.threadId} on ${i.id} is ${resolved ? "resolved" : "open again"}.`,
        i.verbose
          ? { thread }
          : {
              threadId: thread.id,
              ...(thread.comments[0]
                ? { commentId: thread.comments[0].id }
                : {}),
              status: thread.status,
            },
      );
    }),
  );

  server.registerTool("place_ask", toolConfig("place_ask"), (i) =>
    guard(async () => {
      const slot = await placeAskSlot(env, caller, i, {
        userId: t.user.id,
        agent: t.agentNow()?.name ?? null,
      });
      return ok(
        `Placed ask ${slot.commentId} (from ${slot.homeArtifactId}) in slot "${slot.key}" on ${slot.id}.`,
        slot,
      );
    }),
  );

  server.registerTool("remove_ask_slot", toolConfig("remove_ask_slot"), (i) =>
    guard(async () => {
      const out = await removeAskSlot(env, caller, i.id, i.key);
      return ok(
        out.removed
          ? `Removed ask slot "${out.key}" from ${out.id}.`
          : `No ask slot "${out.key}" on ${out.id}.`,
        out,
      );
    }),
  );
}

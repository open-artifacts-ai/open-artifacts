import type { McpServer } from "@modelcontextprotocol/server";
import { authorize, canCtx, capOfCaller } from "../../auth/authz.js";
import { can, capsReads, isGuestRole } from "../../auth/policy.js";
import { ApiError } from "../../http/errors.js";
import {
  addReply,
  addThread,
  type CommentViewer,
  type CommentWho,
  editComment,
  listComments,
  setStatus,
  withdrawAsk,
} from "../../services/comments.js";
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

/**
 * #2688: an ask's answer notice goes only to the agent's own bus session (#2224).
 * A connection with no bus identity (unlinked) gets none, so say so in the result.
 */
const UNLINKED_ASK = {
  answerDelivery: "none",
  note: "This request wasn't verified as coming from a bus session, so the answer won't be sent to you over the bus. Check the thread with list_comments, and ask the person to tell you when they answer.",
} as const;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function registerCommentTools(server: McpServer, t: ToolEnv): void {
  const { env, caller } = t;
  /** The extra result fields when `ask` was posted by a connection the answer can't reach. */
  const unlinkedAsk = (ask: unknown) =>
    ask && !t.agentNow()?.identity ? UNLINKED_ASK : {};
  /** The same note on the text line, for clients that show only `content`. */
  const withNote = (line: string, ask: unknown) =>
    ask && !t.agentNow()?.identity ? `${line} ${UNLINKED_ASK.note}` : line;

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
      const out = await listComments(env, i.id, i.status ?? "all", viewer);
      return ok(
        `${plural(out.threads.length, "thread")} on ${i.id} (${out.open} open)${
          out.truncated ? ", more exist than are shown" : ""
        }.`,
        out,
      );
    }),
  );

  server.registerTool("add_comment", toolConfig("add_comment"), (i) =>
    guard(async () => {
      const { artifact, viewer, who } = await open(i.id, "comments.write");
      const opts = {
        moderator: viewer.moderator === true,
        after: {
          version: artifact.currentVersion,
          ...(t.exec ? { ctx: t.exec } : {}),
        },
      };
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
            i.ask ? { ask: i.ask } : {},
            opts,
          ),
        );
        return ok(
          withNote(`Replied in thread ${i.threadId} on ${i.id}.`, i.ask),
          {
            threadId: i.threadId,
            comment,
            ...unlinkedAsk(i.ask),
          },
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
          ...(i.ask ? { ask: i.ask } : {}),
        },
        opts,
      );
      return ok(withNote(`Started thread ${thread.id} on ${i.id}.`, i.ask), {
        thread,
        ...unlinkedAsk(i.ask),
      });
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
      return ok(`Withdrew the ask ${i.commentId} on ${i.id}.`, {
        threadId: i.threadId,
        comment,
      });
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
      return ok(
        `Thread ${i.threadId} on ${i.id} is ${resolved ? "resolved" : "open again"}.`,
        { thread },
      );
    }),
  );
}

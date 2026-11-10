import {
  ANON_ID_HEADER,
  ArtifactAgentSchema,
  COMMENT_BODY_MAX,
  type Comment,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
  MENTIONS_MAX,
  type Me,
  type NewThreadBody,
  R,
  type ReplyBody,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  isAnonToken,
  loadAnonToken,
  saveAnonToken,
  withMintLock,
} from "../viewer/anonId";
import { ApiClientError, api, type RequestExtra } from "./client";
import {
  billingContext,
  cappedCopy,
  type ErrorContext,
  errorCopy,
} from "./errorCopy";
import { qk } from "./queries";

export const commentsKey = (id: string) => ["comments", id] as const;

/**
 * Guests (signed out) carry the per-artifact anon token in ANON_ID_HEADER, as
 * the bridge does for runtime calls, and store one the server returns. No
 * cookie. Only creating a thread or a reply mints (a GET or a status change never does: with no
 * token it just reads as a guest), and a mint with no token yet runs inside
 * the browser-wide mint lock, so tabs opened at once share one token.
 */
export async function withAnon<T>(
  guest: boolean,
  mints: boolean,
  go: (x?: RequestExtra) => Promise<T>,
): Promise<T> {
  if (!guest) return go();
  const send = (token: string | null) =>
    go({
      ...(token ? { headers: { [ANON_ID_HEADER]: token } } : {}),
      onResponse: (res) => {
        const t = res.headers.get(ANON_ID_HEADER);
        if (isAnonToken(t)) saveAnonToken(t);
      },
    });
  if (!mints || loadAnonToken()) return send(loadAnonToken());
  return withMintLock(() => send(loadAnonToken()));
}

/** Every thread, open and resolved: the shell filters and counts. */
export const useThreads = (id: string, enabled: boolean, guest = false) =>
  useQuery({
    enabled,
    queryKey: commentsKey(id),
    // A server without comments, or comments off: no retry, the shell hides them.
    retry: (n, e) =>
      !(
        e instanceof ApiClientError &&
        (e.status === 404 || e.code === "comments_off")
      ) && n < 2,
    queryFn: ({ signal }) =>
      withAnon(guest, false, (x) =>
        api.get(`${R.comments(id)}?status=all`, CommentListSchema, signal, x),
      ),
  });

const useRefetching = <V, T>(
  id: string,
  guest: boolean,
  mints: boolean,
  fn: (v: V, x?: RequestExtra) => Promise<T>,
) => {
  const qc = useQueryClient();
  return useMutation<T, ApiClientError, V>({
    mutationFn: (v: V) => withAnon(guest, mints, (x) => fn(v, x)),
    // Settled, not success: a 404 or 403 means the list is stale too.
    onSettled: () => qc.invalidateQueries({ queryKey: commentsKey(id) }),
  });
};

export const useCreateThread = (id: string, guest = false) =>
  useRefetching(id, guest, true, (b: NewThreadBody, x) =>
    api.send("POST", R.comments(id), b, CommentThreadSchema, undefined, x),
  );
export const useReply = (id: string, guest = false) =>
  useRefetching(id, guest, true, (v: ReplyBody & { thread: string }, x) =>
    api.send(
      "POST",
      R.commentReplies(id, v.thread),
      {
        body: v.body,
        ...(v.guestName ? { guestName: v.guestName } : {}),
        ...(v.mentions?.length ? { mentions: v.mentions } : {}),
        ...(v.toAsker ? { toAsker: true } : {}),
      },
      CommentSchema,
      undefined,
      x,
    ),
  );
const AgentList = z.array(ArtifactAgentSchema);
/** The agents that follow or publish to the artifact (the @ picker). Owners and editors only; a failure just means no picker. */
export const useArtifactAgents = (id: string, enabled: boolean) =>
  useQuery<z.infer<typeof AgentList>>({
    enabled,
    queryKey: ["comment-agents", id],
    retry: false,
    staleTime: 30_000,
    // A server without the route (404) stays answered: no refetch on mount or focus.
    refetchOnMount: (q) => q.state.status !== "error",
    refetchOnWindowFocus: (q) => q.state.status !== "error",
    queryFn: ({ signal }) => api.get(R.artifactAgents(id), AgentList, signal),
  });

/** Tap an option on an ask. The list refetches on settle, so a 409 shows the closed ask. */
export const useAnswerAsk = (id: string) =>
  useRefetching(
    id,
    false,
    false,
    (v: { thread: string; comment: string; optionId: string }, x) =>
      api.send(
        "POST",
        R.commentAnswer(id, v.thread, v.comment),
        { optionId: v.optionId },
        CommentSchema,
        undefined,
        x,
      ),
  );

export const useSetThreadStatus = (id: string, guest = false) =>
  useRefetching(
    id,
    guest,
    false,
    (v: { thread: string; status: "open" | "resolved" }, x) =>
      api.send(
        "PATCH",
        R.commentThread(id, v.thread),
        { status: v.status },
        CommentThreadSchema,
        undefined,
        x,
      ),
  );
export const useEditComment = (id: string, guest = false) =>
  useRefetching(
    id,
    guest,
    false,
    (
      v: { thread: string; comment: string; body: string },
      x,
    ): Promise<Comment> =>
      api.send(
        "PATCH",
        R.comment(id, v.thread, v.comment),
        { body: v.body },
        CommentSchema,
        undefined,
        x,
      ),
  );
export const useDeleteComment = (id: string, guest = false) =>
  useRefetching(id, guest, false, (v: { thread: string; comment: string }, x) =>
    api.send(
      "DELETE",
      R.comment(id, v.thread, v.comment),
      undefined,
      undefined,
      undefined,
      x,
    ),
  );

/** More agents @mentioned than one comment may carry. */
export class TooManyMentions extends Error {}

/** "5 seconds", "2 minutes": a Retry-After rounded up. */
const wait = (s: number) =>
  s <= 90
    ? `${Math.max(1, s)} second${s <= 1 ? "" : "s"}`
    : `${Math.ceil(s / 60)} minutes`;

const isPlanRefusal = (code: string | null) =>
  code === "plan_required" || code === "plan_read_only";

/** A guest or restricted account: billing details never reach them. A signed-out viewer never gets a plan code on a comment write (the server answers 401). */
const planOutsider = (ctx?: ErrorContext) => ctx?.capped === true;

/** Who the caller is for the plan copy (owners read the action, members whom to ask). */
export const commentErrorCtx = (me: Me | null | undefined): ErrorContext =>
  me
    ? {
        ...billingContext(me),
        // Only a guest or restricted account is an outsider; cap "plan" is a
        // locked instance's member or admin, who keep the plan copy.
        capped: me.auth?.cap === "guest" || me.auth?.cap === "restricted",
      }
    : {};

export const useCommentErrorCtx = (): ErrorContext => {
  // Read the cached Me; a comment surface never fetches it just for error copy.
  const qc = useQueryClient();
  return commentErrorCtx(qc.getQueryData<Me>(qk.me));
};

/** The copy for a failed comment call (Product's strings where the spec has them). */
export function commentError(
  e: unknown,
  capped = false,
  ctx?: ErrorContext,
): string {
  if (e instanceof TooManyMentions)
    return `Mention at most ${MENTIONS_MAX} agents in one comment.`;
  const code = e instanceof ApiClientError ? e.code : null;
  // A capped (guest or restricted) member's writes are refused as read-only:
  // the server answers 404, and says nothing about a missing comment.
  if (
    capped &&
    (code === "not_found" || code === "forbidden" || code === "space_forbidden")
  )
    return cappedCopy("comment");
  // The plan cap refuses a comment write: the plan copy the rest of the app uses.
  if (isPlanRefusal(code))
    return planOutsider(ctx)
      ? cappedCopy("comment")
      : errorCopy(e, "Couldn't post your comment. Try again.", ctx);
  switch (code) {
    case "rate_limited":
      return e instanceof ApiClientError && e.retryAfter
        ? `Too many comments. Try again in ${wait(e.retryAfter)}.`
        : "Too many comments. Try again in a minute.";
    case "invalid_body":
      return `A comment needs 1 to ${COMMENT_BODY_MAX.toLocaleString("en")} characters.`;
    case "anchor_not_in_version":
      return "That version of the page is gone.";
    case "comments_off":
      return "Comments are off for this page.";
    case "forbidden":
      return "You can't do that on this comment.";
    case "not_found":
      return "That comment is gone.";
    case "conflict":
      return "This thread has too many replies. Start a new comment instead.";
    case "not_an_ask":
      return "That ask is no longer open to questions. Reply instead.";
    case "bad_request":
      return "That comment couldn't be found.";
    case "unauthorized":
      return "Sign in to comment.";
    default:
      return "Couldn't post your comment. Try again.";
  }
}

/** Copy for a failed answer: 403 not asked, 409 closed, 400 unknown option. */
export function answerError(e: unknown, ctx?: ErrorContext): string {
  if (e instanceof ApiClientError && isPlanRefusal(e.code))
    return planOutsider(ctx)
      ? cappedCopy("answer")
      : errorCopy(e, "Couldn't send your answer. Try again.", ctx);
  const status = e instanceof ApiClientError ? e.status : 0;
  if (status === 403)
    return "Only the people this ask is addressed to can answer.";
  if (status === 409)
    return "The agent already closed this ask, so it can't be changed.";
  if (status === 400)
    return "That option isn't on this ask any more. Reload to see the current ones.";
  if (status === 404) return "That ask is gone.";
  return "Couldn't send your answer. Try again.";
}

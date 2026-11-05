import {
  ANON_ID_HEADER,
  COMMENT_BODY_MAX,
  type Comment,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
  type NewThreadBody,
  R,
  type ReplyBody,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isAnonToken,
  loadAnonToken,
  saveAnonToken,
  withMintLock,
} from "../viewer/anonId";
import { ApiClientError, api, type RequestExtra } from "./client";
import { cappedCopy } from "./errorCopy";

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
      { body: v.body, ...(v.guestName ? { guestName: v.guestName } : {}) },
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

/** "5 seconds", "2 minutes": a Retry-After rounded up. */
const wait = (s: number) =>
  s <= 90
    ? `${Math.max(1, s)} second${s <= 1 ? "" : "s"}`
    : `${Math.ceil(s / 60)} minutes`;

/** The copy for a failed comment call (Product's strings where the spec has them). */
export function commentError(e: unknown, capped = false): string {
  const code = e instanceof ApiClientError ? e.code : null;
  // A capped (guest or restricted) member's writes are refused as read-only:
  // the server answers 404, and says nothing about a missing comment.
  if (
    capped &&
    (code === "not_found" || code === "forbidden" || code === "space_forbidden")
  )
    return cappedCopy("comment");
  switch (code) {
    case "rate_limited":
      return e instanceof ApiClientError && e.retryAfter
        ? `Too many comments. Try again in ${wait(e.retryAfter)}.`
        : "Too many comments. Try again in a minute.";
    case "invalid_body":
      return `A comment needs 1 to ${COMMENT_BODY_MAX.toLocaleString("en")} characters.`;
    case "anchor_not_in_version":
      return "That text isn't in this version.";
    case "comments_off":
      return "Comments are off for this page.";
    case "forbidden":
      return "You can't do that on this comment.";
    case "not_found":
      return "That comment is gone.";
    case "conflict":
      return "This thread has too many replies. Start a new comment instead.";
    case "bad_request":
      return "That comment couldn't be found.";
    case "unauthorized":
      return "Sign in to comment.";
    default:
      return "Couldn't post your comment. Try again.";
  }
}

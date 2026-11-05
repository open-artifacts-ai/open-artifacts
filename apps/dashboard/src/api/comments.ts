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

export const commentsKey = (id: string) => ["comments", id] as const;

/**
 * Guests (signed out) carry the per-artifact anon token in ANON_ID_HEADER, as
 * the bridge does for runtime calls: with none, the server mints one and
 * returns it in that header, and it is stored the same way. No cookie. A write
 * with no token yet runs inside the browser-wide mint lock, so tabs opened at
 * once share one token.
 */
export async function withAnon<T>(
  guest: boolean,
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
  // The server mints on any comments request that has no token, reads
  // included: so a token-less call of any kind takes the lock.
  if (loadAnonToken()) return send(loadAnonToken());
  return withMintLock(() => send(loadAnonToken()));
}

/** Every thread, open and resolved: the shell filters and counts. */
export const useThreads = (id: string, enabled: boolean, guest = false) =>
  useQuery({
    enabled,
    queryKey: commentsKey(id),
    queryFn: ({ signal }) =>
      withAnon(guest, (x) =>
        api.get(`${R.comments(id)}?status=all`, CommentListSchema, signal, x),
      ),
  });

const useRefetching = <V, T>(
  id: string,
  guest: boolean,
  fn: (v: V, x?: RequestExtra) => Promise<T>,
) => {
  const qc = useQueryClient();
  return useMutation<T, ApiClientError, V>({
    mutationFn: (v: V) => withAnon(guest, (x) => fn(v, x)),
    // Settled, not success: a 404 or 403 means the list is stale too.
    onSettled: () => qc.invalidateQueries({ queryKey: commentsKey(id) }),
  });
};

export const useCreateThread = (id: string, guest = false) =>
  useRefetching(id, guest, (b: NewThreadBody, x) =>
    api.send("POST", R.comments(id), b, CommentThreadSchema, undefined, x),
  );
export const useReply = (id: string, guest = false) =>
  useRefetching(id, guest, (v: ReplyBody & { thread: string }, x) =>
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
  useRefetching(id, guest, (v: { thread: string; comment: string }, x) =>
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
export function commentError(e: unknown): string {
  const code = e instanceof ApiClientError ? e.code : null;
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

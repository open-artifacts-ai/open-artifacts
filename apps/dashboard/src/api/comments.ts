import {
  ANON_ID_HEADER,
  AnswerChallengeSchema,
  type ArtifactAgent,
  ArtifactAgentSchema,
  COMMENT_BODY_MAX,
  type Comment,
  type CommentList,
  CommentListSchema,
  CommentSchema,
  type CommentThread,
  CommentThreadSchema,
  MENTIONS_MAX,
  type Me,
  type NewThreadBody,
  R,
  type ReplyBody,
} from "@oa/shared";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import {
  isAnonToken,
  loadAnonToken,
  saveAnonToken,
  withMintLock,
} from "../viewer/anonId";
import {
  assertionToJSON,
  decodeRequestOptions,
} from "../viewer/comments/passkey";
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

/**
 * Posts that are on screen before the server has answered. They live beside the
 * query cache, not in it: a refetch (a live event, a focus) that lands while the
 * write is in flight replaces the cache and would drop a cached temp comment,
 * but never touches this list. `useThreads` lays them over the cache, and drops
 * one as soon as the list carries the real comment (matched below), so a refetch
 * that lands first never shows it twice.
 */
type Pending = {
  tmp: string;
  /** The thread replied to; null for a new thread. */
  thread: string | null;
  comment: Comment;
  /** For a new thread: the temp thread that holds the comment. */
  tmpThread?: CommentThread;
  /** Comment and thread ids the list had when the post began. */
  known: ReadonlySet<string>;
};
const NO_PENDING: readonly Pending[] = [];
const pendingByArtifact = new Map<string, readonly Pending[]>();
const pendingListeners = new Set<() => void>();
const setPending = (
  id: string,
  f: (cur: readonly Pending[]) => readonly Pending[],
) => {
  const next = f(pendingByArtifact.get(id) ?? NO_PENDING);
  if (next.length) pendingByArtifact.set(id, next);
  else pendingByArtifact.delete(id);
  for (const l of pendingListeners) l();
};
const usePending = (id: string) =>
  useSyncExternalStore(
    (l) => {
      pendingListeners.add(l);
      return () => void pendingListeners.delete(l);
    },
    () => pendingByArtifact.get(id) ?? NO_PENDING,
    () => NO_PENDING,
  );

let tmpSeq = 0;
/** A client id no server id can equal. */
const tmpId = () => `tmp-${Date.now().toString(36)}-${++tmpSeq}`;
export const isSending = (id: string) => id.startsWith("tmp-");

/** The list with each pending post laid over it, minus the ones the list already carries. */
export function overlayPending(
  data: CommentList,
  pending: readonly Pending[],
): CommentList {
  if (!pending.length) return data;
  let threads = data.threads;
  let opened = 0;
  // A real comment answers one pending post only, so two posts with the same text stay two.
  const claimed = new Set<string>();
  const landed = (c: Comment, p: Pending) =>
    !p.known.has(c.id) &&
    !claimed.has(c.id) &&
    c.author.me &&
    c.body === p.comment.body;
  for (const p of pending) {
    if (p.thread === null) {
      const hit = threads.find((t) => {
        const first = t.comments[0];
        return !p.known.has(t.id) && first && landed(first, p);
      });
      if (hit?.comments[0]) {
        claimed.add(hit.comments[0].id);
        continue;
      }
      if (p.tmpThread) {
        threads = [...threads, p.tmpThread];
        opened++;
      }
    } else {
      const t = threads.find((x) => x.id === p.thread);
      if (!t) continue;
      const hit = t.comments.find((c) => landed(c, p));
      if (hit) {
        claimed.add(hit.id);
        continue;
      }
      threads = threads.map((x) =>
        x === t ? { ...x, comments: [...x.comments, p.comment] } : x,
      );
    }
  }
  return threads === data.threads
    ? data
    : { ...data, threads, open: data.open + opened };
}

/** Every thread, open and resolved: the shell filters and counts. Posts still in flight are laid over the list. */
export const useThreads = (id: string, enabled: boolean, guest = false) => {
  const q = useQuery({
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
  const pending = usePending(id);
  const data = useMemo(
    () => (q.data ? overlayPending(q.data, pending) : q.data),
    [q.data, pending],
  );
  return data === q.data ? q : { ...q, data };
};

type Snapshot = { prev: CommentList | undefined };

/**
 * What an optimistic action changed, and how to put back only that: `apply`
 * edits the list, `undo` restores just the touched item from `prev` (the list
 * before this action). A failure never rewinds the whole list, so two quick
 * actions cannot undo each other.
 */
type Patch<V> = {
  apply: (list: CommentList, v: V, me: Comment["author"]) => CommentList;
  undo: (list: CommentList, v: V, prev: CommentList) => CommentList;
};

/**
 * Optimistic edits to the cached list (TanStack onMutate): `apply` shows the
 * result at once, an error puts the snapshot back, and the settle refetch makes
 * the server's record the truth. Used only for actions whose outcome is
 * predictable. Never for answering an ask (it must show the server's record:
 * who answered, a 409 for a closed ask), a confirm or passkey step (#2263), or
 * an edit the server may refuse for rights the client cannot see.
 */
const useRefetching = <V, T>(
  id: string,
  guest: boolean,
  mints: boolean,
  fn: (v: V, x?: RequestExtra) => Promise<T>,
  patch?: Patch<V>,
) => {
  const qc = useQueryClient();
  return useMutation<T, ApiClientError, V, Snapshot | undefined>({
    mutationFn: (v: V) => withAnon(guest, mints, (x) => fn(v, x)),
    onMutate: patch
      ? async (v) => {
          // A fetch already on its way would overwrite the edit below.
          await qc.cancelQueries({ queryKey: commentsKey(id) });
          const prev = qc.getQueryData<CommentList>(commentsKey(id));
          if (prev)
            qc.setQueryData<CommentList>(
              commentsKey(id),
              patch.apply(prev, v, viewerAuthor(qc, guest)),
            );
          return { prev };
        }
      : undefined,
    onError: patch
      ? (_e, v, ctx) => {
          const prev = ctx?.prev;
          if (!prev) return;
          qc.setQueryData<CommentList>(commentsKey(id), (cur) =>
            cur ? patch.undo(cur, v, prev) : cur,
          );
        }
      : undefined,
    // Settled, not success: a 404 or 403 means the list is stale too.
    onSettled: () => qc.invalidateQueries({ queryKey: commentsKey(id) }),
  });
};

const mapThread = (
  list: CommentList,
  thread: string,
  f: (t: CommentThread) => CommentThread,
): CommentList => ({
  ...list,
  threads: list.threads.map((t) => (t.id === thread ? f(t) : t)),
});
const setStatus = (
  list: CommentList,
  thread: string,
  status: "open" | "resolved",
): CommentList =>
  mapThread(list, thread, (t) => ({
    ...t,
    status,
    // Who resolved it and when are the server's to say.
    ...(status === "open" ? { resolvedBy: null, resolvedAt: null } : {}),
  }));
/** `next` with the open count moved by what changed from `list`. */
const withOpen = (list: CommentList, next: CommentList): CommentList => ({
  ...next,
  open: list.open + countOpen(next.threads) - countOpen(list.threads),
});
const countOpen = (threads: readonly CommentThread[]) =>
  threads.filter((t) => t.status === "open").length;

/** The viewer as an author of a comment that has not reached the server. */
function viewerAuthor(qc: QueryClient, guest: boolean, guestName?: string) {
  const me = qc.getQueryData<Me>(qk.me);
  return guest || !me
    ? ({
        kind: "guest",
        name: guestName?.trim() || "You",
        me: true,
      } as const)
    : ({
        kind: "user",
        id: me.user.id,
        name: me.user.name ?? me.user.email,
        me: true,
      } as const);
}

/** The mentions a post carries, named from the @ picker's list, each "queued" so it reads "sending" (HELD_AFTER_MS). */
function pendingMentions(
  qc: QueryClient,
  id: string,
  keys: readonly { key: string }[] | undefined,
) {
  if (!keys?.length) return undefined;
  const agents = qc.getQueryData<ArtifactAgent[]>(["comment-agents", id]);
  return keys.map(({ key }) => ({
    key,
    name: agents?.find((a) => a.key === key)?.name ?? key,
    delivery: "queued" as const,
  }));
}

function pendingComment(
  qc: QueryClient,
  id: string,
  guest: boolean,
  v: { body: string; guestName?: string; mentions?: { key: string }[] },
): Comment {
  const mentions = pendingMentions(qc, id, v.mentions);
  return {
    id: tmpId(),
    body: v.body,
    author: viewerAuthor(qc, guest, v.guestName),
    createdAt: new Date().toISOString(),
    editedAt: null,
    typed: true,
    // Nothing to edit or delete until the server has the comment.
    can: { edit: false, delete: false },
    ...(mentions ? { mentions } : {}),
  };
}

/** Put the server's comment in the cache and drop the pending one in one step, so nothing flickers. */
function landed(
  qc: QueryClient,
  id: string,
  p: Pending,
  server: Comment | CommentThread,
) {
  qc.setQueryData<CommentList>(commentsKey(id), (list) => {
    if (!list) return list;
    if (p.thread === null) {
      const t = server as CommentThread;
      if (list.threads.some((x) => x.id === t.id)) return list;
      return {
        ...list,
        threads: [...list.threads, t],
        open: list.open + (t.status === "open" ? 1 : 0),
      };
    }
    const c = server as Comment;
    return mapThread(list, p.thread, (t) =>
      t.comments.some((x) => x.id === c.id)
        ? t
        : { ...t, comments: [...t.comments, c] },
    );
  });
  setPending(id, (cur) => cur.filter((x) => x.tmp !== p.tmp));
}

const knownIds = (list: CommentList | undefined) => {
  const s = new Set<string>();
  for (const t of list?.threads ?? []) {
    s.add(t.id);
    for (const c of t.comments) s.add(c.id);
  }
  return s;
};

type NewThreadVars = NewThreadBody & {
  /** The shown version's hash, for a pin's temp anchor. Not sent. */
  contentHash?: string | null;
};

/**
 * Posting shows the comment at once (a pending post, see above) and takes it
 * back on any error. The caller restores the typed text.
 */
function usePost<V extends { body: string; guestName?: string }>(
  id: string,
  guest: boolean,
  mentionsOf: (v: V) => { key: string }[] | undefined,
  threadOf: (v: V) => string | null,
  tempThread: (v: V, c: Comment) => CommentThread | undefined,
  send: (v: V, x?: RequestExtra) => Promise<Comment | CommentThread>,
) {
  const qc = useQueryClient();
  return useMutation<Comment | CommentThread, ApiClientError, V, Pending>({
    mutationFn: (v) => withAnon(guest, true, (x) => send(v, x)),
    onMutate: (v) => {
      const comment = pendingComment(qc, id, guest, {
        body: v.body,
        guestName: v.guestName,
        mentions: mentionsOf(v),
      });
      const p: Pending = {
        tmp: comment.id,
        thread: threadOf(v),
        comment,
        tmpThread: tempThread(v, comment),
        known: knownIds(qc.getQueryData<CommentList>(commentsKey(id))),
      };
      setPending(id, (cur) => [...cur, p]);
      return p;
    },
    onSuccess: (server, _v, p) => landed(qc, id, p, server),
    onError: (_e, _v, p) =>
      p && setPending(id, (cur) => cur.filter((x) => x.tmp !== p.tmp)),
    onSettled: () => qc.invalidateQueries({ queryKey: commentsKey(id) }),
  });
}

export const useCreateThread = (id: string, guest = false) =>
  usePost<NewThreadVars>(
    id,
    guest,
    (v) => v.mentions,
    () => null,
    (v, comment) => ({
      id: tmpId(),
      anchor: (v.anchor.kind === "note"
        ? v.anchor
        : {
            ...v.anchor,
            version: v.anchor.version ?? 1,
            ...(v.anchor.kind === "pin"
              ? { contentHash: v.contentHash ?? v.anchor.contentHash ?? "" }
              : {}),
          }) as CommentThread["anchor"],
      version: v.anchor.kind === "note" ? 1 : (v.anchor.version ?? 1),
      status: "open",
      resolvedBy: null,
      resolvedAt: null,
      createdAt: comment.createdAt,
      comments: [comment],
    }),
    (v, x) => {
      const { contentHash: _h, ...body } = v;
      return api.send(
        "POST",
        R.comments(id),
        body,
        CommentThreadSchema,
        undefined,
        x,
      );
    },
  );
export const useReply = (id: string, guest = false) =>
  usePost<ReplyBody & { thread: string }>(
    id,
    guest,
    (v) => v.mentions,
    (v) => v.thread,
    () => undefined,
    (v, x) =>
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
/** #2035: stop (or undo) a thread's replies reaching one agent. The server allows the agent's person and the owner. */
export const useThreadAgent = (id: string, guest = false) =>
  useRefetching(
    id,
    guest,
    false,
    (v: { thread: string; key: string; removed: boolean }, x) =>
      api.send(
        v.removed ? "DELETE" : "PUT",
        R.commentThreadAgent(id, v.thread, v.key),
        undefined,
        undefined,
        undefined,
        x,
      ),
    // The chip and row change at once; a refusal puts them back.
    {
      apply: (list, v) =>
        mapThread(list, v.thread, (t) => ({
          ...t,
          agents: t.agents?.map((a) =>
            a.key === v.key
              ? { ...a, removed: v.removed ? true : undefined }
              : a,
          ),
        })),
      // Only this agent goes back; another removal in flight stays.
      undo: (list, v, prev) => {
        const was = prev.threads
          .find((t) => t.id === v.thread)
          ?.agents?.find((a) => a.key === v.key);
        return mapThread(list, v.thread, (t) => ({
          ...t,
          agents: t.agents?.map((a) =>
            a.key === v.key ? { ...a, removed: was?.removed } : a,
          ),
        }));
      },
    },
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

/**
 * Tap an option on an ask: the pick shows at once and settles to the server's
 * record on the refetch. The card only marks the picked option as sending
 * until then (never "You picked"). A refusal, a 409 included, rolls it back to
 * unanswered, and the settle refetch then shows whoever answered first.
 * Never for an ask with `confirm` (the passkey asks of #2263): a yes that needs
 * the server's verification must not appear before it. The optimistic answer is
 * never a person's yes (`yes: false`), whatever the server later says.
 */
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
    {
      apply: (list, v, me) =>
        mapThread(list, v.thread, (t) => ({
          ...t,
          comments: t.comments.map((c) =>
            c.id !== v.comment ||
            !c.ask ||
            c.ask.closed ||
            (c.ask as { confirm?: unknown }).confirm
              ? c
              : {
                  ...c,
                  ask: {
                    ...c.ask,
                    answer: {
                      optionId: v.optionId,
                      by: me,
                      at: new Date().toISOString(),
                      typed: true,
                      yes: false,
                      // Not answered until the server confirms: the card keeps its
                      // "needs you" border and the header keeps counting it.
                      sending: true,
                    } as NonNullable<typeof c.ask.answer>,
                  },
                },
          ),
        })),
      undo: (list, v, prev) => {
        const was = prev.threads
          .find((t) => t.id === v.thread)
          ?.comments.find((c) => c.id === v.comment)?.ask?.answer;
        return mapThread(list, v.thread, (t) => ({
          ...t,
          comments: t.comments.map((c) =>
            c.id === v.comment && c.ask
              ? { ...c, ask: { ...c.ask, answer: was } }
              : c,
          ),
        }));
      },
    },
  );

/**
 * #2263: pick an option on a `confirm: "passkey"` ask. Challenge, then the passkey
 * prompt, then the answer; nothing is answered until the server verifies it.
 */
export const usePasskeyAnswer = (id: string) =>
  useRefetching(
    id,
    false,
    false,
    async (v: { thread: string; comment: string; optionId: string }, x) => {
      const ch = await api.send(
        "POST",
        R.commentAnswerChallenge(id, v.thread, v.comment),
        { optionId: v.optionId },
        AnswerChallengeSchema,
        undefined,
        x,
      );
      const cred = await navigator.credentials.get({
        publicKey: decodeRequestOptions(ch.options),
      });
      if (!cred) throw new DOMException("No credential", "NotAllowedError");
      return api.send(
        "POST",
        R.commentAnswer(id, v.thread, v.comment),
        {
          optionId: v.optionId,
          assertion: assertionToJSON(cred as PublicKeyCredential),
        },
        CommentSchema,
        undefined,
        x,
      );
    },
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
    {
      apply: (list, v) => withOpen(list, setStatus(list, v.thread, v.status)),
      // Only this thread's status goes back.
      undo: (list, v, prev) => {
        const was = prev.threads.find((t) => t.id === v.thread);
        return was
          ? withOpen(
              list,
              mapThread(list, v.thread, (t) => ({
                ...t,
                status: was.status,
                resolvedBy: was.resolvedBy,
                resolvedAt: was.resolvedAt,
              })),
            )
          : list;
      },
    },
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
  useRefetching(
    id,
    guest,
    false,
    (v: { thread: string; comment: string }, x) =>
      api.send(
        "DELETE",
        R.comment(id, v.thread, v.comment),
        undefined,
        undefined,
        undefined,
        x,
      ),
    // Deleting the root takes the thread with it, as the server does.
    {
      apply: (list, v) => {
        const t = list.threads.find((x) => x.id === v.thread);
        if (!t) return list;
        if (t.comments[0]?.id === v.comment)
          return {
            ...list,
            threads: list.threads.filter((x) => x.id !== v.thread),
            open: list.open - (t.status === "open" ? 1 : 0),
          };
        return mapThread(list, v.thread, (x) => ({
          ...x,
          comments: x.comments.filter((c) => c.id !== v.comment),
        }));
      },
      // Only the deleted comment (or thread) comes back, in its old place.
      undo: (list, v, prev) => {
        const was = prev.threads.find((x) => x.id === v.thread);
        if (!was) return list;
        const at = was.comments.findIndex((c) => c.id === v.comment);
        const gone = was.comments[at];
        if (!gone) return list;
        if (at === 0) {
          if (list.threads.some((x) => x.id === v.thread)) return list;
          const i = prev.threads.indexOf(was);
          const threads = [...list.threads];
          threads.splice(Math.min(i, threads.length), 0, was);
          return withOpen(list, { ...list, threads });
        }
        return mapThread(list, v.thread, (x) => {
          if (x.comments.some((c) => c.id === v.comment)) return x;
          const comments = [...x.comments];
          comments.splice(Math.min(at, comments.length), 0, gone);
          return { ...x, comments };
        });
      },
    },
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

/** No Me (anonymous) or a capped account: billing details never reach them. */
const planOutsider = (ctx?: ErrorContext) => !ctx || ctx.capped === true;

/** Who the caller is for the plan copy (owners read the action, members whom to ask). */
// A missing Me is an outsider: a signed-out viewer never reaches a plan code
// (authz.ts:449, the 401 path), so this is the safe default while Me loads or fails.
export const commentErrorCtx = (me: Me | null | undefined): ErrorContext =>
  me
    ? {
        ...billingContext(me),
        // Only a guest or restricted account is an outsider; cap "plan" is a
        // locked instance's member or admin, who keep the plan copy.
        capped: me.auth?.cap === "guest" || me.auth?.cap === "restricted",
      }
    : { capped: true };

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
    case "comments_signed_in_only":
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

/**
 * For you's client (#2512) on OA Backend's inbox contract (R.meInbox*,
 * InboxSchema). The bell reads Me.inbox; the list loads when it opens.
 */
import {
  type Inbox,
  type InboxItem,
  InboxItemSchema,
  InboxSchema,
  type Me,
  R,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { countsOf } from "./model";

export const inboxKey = ["inbox"] as const;

export const useInbox = (enabled: boolean) =>
  useQuery({
    queryKey: inboxKey,
    queryFn: ({ signal }) => api.get(R.meInbox, InboxSchema, signal),
    enabled,
  });

/**
 * Changes the cached list (and Me.inbox, the bell) at once; a failure puts
 * the list back, and the settle refetch makes the server's record the truth.
 */
const useEdit = <V, T>(
  send: (v: V) => Promise<T>,
  edit?: (inbox: Inbox, v: V) => Pick<Inbox, "needsYou" | "later" | "updates">,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onMutate: async (v: V) => {
      if (!edit) return { prev: undefined };
      await qc.cancelQueries({ queryKey: inboxKey });
      const prev = qc.getQueryData<Inbox>(inboxKey);
      if (prev) setInbox(qc, { ...prev, ...edit(prev, v) });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) setInbox(qc, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: inboxKey });
      void qc.invalidateQueries({ queryKey: qk.me, exact: true });
    },
  });
};

/** The list, with its counts recomputed, and the bell's counts on Me. */
function setInbox(
  qc: ReturnType<typeof useQueryClient>,
  next: Omit<Inbox, "counts"> & Partial<Pick<Inbox, "counts">>,
) {
  const counts = countsOf(next);
  qc.setQueryData<Inbox>(inboxKey, { ...next, counts });
  qc.setQueryData<Me>(qk.me, (me) =>
    me?.inbox ? { ...me, inbox: counts } : me,
  );
}

const readAt = (x: InboxItem) =>
  x.readAt === null ? { ...x, readAt: new Date().toISOString() } : x;

export const useMarkRead = () =>
  useEdit(
    (ids: string[]) => api.send("POST", R.meInboxRead, { ids }),
    (i, ids) => ({
      ...i,
      updates: i.updates.map((x) => (ids.includes(x.id) ? readAt(x) : x)),
    }),
  );

export const useReadAll = () =>
  useEdit(
    () => api.send("POST", R.meInboxReadAll, undefined),
    (i) => ({ ...i, updates: i.updates.map(readAt) }),
  );

/** Put off once: the server answers the deferred item, which joins Later. */
export const useLater = () => {
  const qc = useQueryClient();
  return useEdit(
    async (v: { id: string; until: "hour" | "morning" }) => {
      const moved = await api.send(
        "POST",
        R.meInboxLater(v.id),
        { until: v.until },
        InboxItemSchema,
      );
      const cur = qc.getQueryData<Inbox>(inboxKey);
      if (cur)
        setInbox(qc, {
          ...cur,
          needsYou: cur.needsYou.filter((x) => x.id !== v.id),
          later: [...cur.later.filter((x) => x.id !== v.id), moved],
        });
      return moved;
    },
    (i, v) => ({ ...i, needsYou: i.needsYou.filter((x) => x.id !== v.id) }),
  );
};

/** A mute stops push only: the row stays. */
export const useMute = () =>
  useEdit((v: { kind: "agent" | "page"; id: string }) =>
    api.send("POST", R.meInboxMutes, v),
  );

/** An answered (or gone) ask leaves the list at once; the next fetch confirms it. */
export const useDropItem = () => {
  const qc = useQueryClient();
  return (id: string) => {
    const cur = qc.getQueryData<Inbox>(inboxKey);
    if (cur)
      setInbox(qc, {
        ...cur,
        needsYou: cur.needsYou.filter((x) => x.id !== id),
      });
    void qc.invalidateQueries({ queryKey: inboxKey });
    void qc.invalidateQueries({ queryKey: qk.me, exact: true });
  };
};

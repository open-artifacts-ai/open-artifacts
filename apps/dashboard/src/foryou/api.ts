/**
 * For you's client (#2512) on OA Backend's inbox contract (R.meInbox*,
 * InboxSchema). The bell reads Me.inbox; the list loads when it opens, and
 * Updates page on with `cursor` ("Show more").
 */
import {
  type Inbox,
  type InboxItem,
  InboxItemSchema,
  InboxSchema,
  type Me,
  MeSchema,
  R,
} from "@oa/shared";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { countsOf } from "./model";

export const inboxKey = ["inbox"] as const;
/** How often the bell's counts (and an open list) refresh while the tab is visible. */
export const INBOX_REFRESH_MS = 60_000;

type Pages = InfiniteData<Inbox, string | null>;

/** The pages as one list: Needs you, Later and the counts come with the first page; Updates run on. */
export function flatInbox(d: InfiniteData<Inbox, unknown>): Inbox | undefined {
  const [first] = d.pages;
  if (!first) return undefined;
  return {
    ...first,
    updates: d.pages.flatMap((p) => p.updates),
    cursor: d.pages.at(-1)?.cursor ?? null,
  };
}

/**
 * The bell's counts: Me.inbox, refetched on focus and every minute while the
 * tab is visible (never in the background). /me carries the counts; there is
 * no separate count route.
 */
export const useInboxCounts = (enabled: boolean) =>
  useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    enabled,
    // Focus always asks again; the app's other /me reads keep their 60 s.
    staleTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    refetchInterval: INBOX_REFRESH_MS,
    refetchIntervalInBackground: false,
  });

const syncMe = (qc: QueryClient, counts: Inbox["counts"]) =>
  qc.setQueryData<Me>(qk.me, (me) =>
    me?.inbox ? { ...me, inbox: counts } : me,
  );

/** The open list: the first page and any shown with "Show more"; it refreshes like the bell while open. */
export function useInbox(open: boolean) {
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: inboxKey,
    initialPageParam: null as string | null,
    queryFn: async ({ signal, pageParam }) => {
      const page = await api.get(
        pageParam
          ? `${R.meInbox}?cursor=${encodeURIComponent(pageParam)}`
          : R.meInbox,
        InboxSchema,
        signal,
      );
      // The first page's counts are the freshest: the bell follows them.
      if (!pageParam) syncMe(qc, page.counts);
      return page;
    },
    getNextPageParam: (last) => last.cursor ?? undefined,
    enabled: open,
    refetchInterval: open ? INBOX_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
  return { ...q, inbox: q.data ? flatInbox(q.data) : undefined };
}

/** Every page through `f` (index 0 is the first), with the counts recomputed, and the bell's counts on Me. */
function editPages(qc: QueryClient, f: (p: Inbox, i: number) => Inbox) {
  const cur = qc.getQueryData<Pages>(inboxKey);
  if (!cur) return;
  const pages = cur.pages.map(f);
  const counts = countsOf({
    needsYou: pages[0]?.needsYou ?? [],
    updates: pages.flatMap((p) => p.updates),
  });
  qc.setQueryData<Pages>(inboxKey, {
    ...cur,
    pages: pages.map((p, i) => (i === 0 ? { ...p, counts } : p)),
  });
  syncMe(qc, counts);
}

/**
 * Changes the cached list (and Me.inbox, the bell) at once; a failure puts
 * it back, and the settle refetch makes the server's record the truth.
 */
const useEdit = <V, T>(
  send: (v: V) => Promise<T>,
  edit?: (page: Inbox, v: V) => Inbox,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onMutate: async (v: V) => {
      if (!edit) return { prev: undefined, me: undefined };
      await qc.cancelQueries({ queryKey: inboxKey });
      const prev = qc.getQueryData<Pages>(inboxKey);
      const me = qc.getQueryData<Me>(qk.me);
      editPages(qc, (p) => edit(p, v));
      return { prev, me };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(inboxKey, ctx.prev);
      if (ctx?.me) qc.setQueryData(qk.me, ctx.me);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: inboxKey });
      void qc.invalidateQueries({ queryKey: qk.me, exact: true });
    },
  });
};

const readNow = (x: InboxItem) =>
  x.readAt === null ? { ...x, readAt: new Date().toISOString() } : x;

export const useMarkRead = () =>
  useEdit(
    (ids: string[]) => api.send("POST", R.meInboxRead, { ids }),
    (p, ids) => ({
      ...p,
      updates: p.updates.map((x) => (ids.includes(x.id) ? readNow(x) : x)),
    }),
  );

export const useReadAll = () =>
  useEdit(
    () => api.send("POST", R.meInboxReadAll, undefined),
    (p) => ({ ...p, updates: p.updates.map(readNow) }),
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
      editPages(qc, (p, i) =>
        i === 0
          ? { ...p, later: [...p.later.filter((x) => x.id !== v.id), moved] }
          : p,
      );
      return moved;
    },
    (p, v) => ({ ...p, needsYou: p.needsYou.filter((x) => x.id !== v.id) }),
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
    editPages(qc, (p) => ({
      ...p,
      needsYou: p.needsYou.filter((x) => x.id !== id),
    }));
    void qc.invalidateQueries({ queryKey: inboxKey });
    void qc.invalidateQueries({ queryKey: qk.me, exact: true });
  };
};

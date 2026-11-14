/**
 * For you's client (#2512). PROVISIONAL: R.forYou* and the shapes are the
 * dashboard's guess until OA Backend's contract lands; swap them here.
 */
import {
  type ForYou,
  type ForYouItem,
  type ForYouReadBody,
  ForYouSchema,
  R,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiClientError, api } from "../api/client";
import { laterUntil } from "./model";

export const forYouKey = ["for-you"] as const;

/** A server without For you answers 404: the bell stays hidden and stops asking. */
export const useForYou = (enabled: boolean) =>
  useQuery({
    queryKey: forYouKey,
    queryFn: ({ signal }) => api.get(R.forYou, ForYouSchema, signal),
    enabled,
    refetchInterval: (q) =>
      q.state.error instanceof ApiClientError ? false : 60_000,
  });

/** Changes the cached list at once; the server's answer replaces it. */
const useEdit = <V>(
  send: (v: V) => Promise<unknown>,
  edit: (items: ForYouItem[], v: V) => ForYouItem[],
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: forYouKey });
      const prev = qc.getQueryData<ForYou>(forYouKey);
      if (prev)
        qc.setQueryData<ForYou>(forYouKey, {
          ...prev,
          items: edit(prev.items, v),
        });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(forYouKey, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: forYouKey }),
  });
};

export const useMarkRead = () =>
  useEdit(
    (b: ForYouReadBody) => api.send("POST", R.forYouRead, b),
    (items, b) => {
      const ids = "ids" in b ? new Set(b.ids) : null;
      return items.map((x) =>
        x.level === "update" && (!ids || ids.has(x.id))
          ? { ...x, read: true }
          : x,
      );
    },
  );

export const useLater = () =>
  useEdit(
    (v: { id: string; when: "hour" | "morning" }) =>
      api.send("POST", R.forYouLater(v.id), { when: v.when }),
    (items, v) =>
      items.map((x) =>
        x.id === v.id
          ? { ...x, later: { state: "snoozed", until: laterUntil(v.when) } }
          : x,
      ),
  );

export const useMute = () =>
  useEdit(
    (agent: string) => api.send("POST", R.forYouMutes, { agent }),
    // Their items stay; they only stop interrupting.
    (items) => items,
  );

export const useUnfollow = () =>
  useEdit(
    (page: string) => api.send("DELETE", R.forYouFollow(page), undefined),
    (items, page) =>
      items.filter((x) => x.level !== "update" || x.page?.id !== page),
  );

/** An answered ask leaves the list at once; the next fetch confirms it. */
export const useDropItem = () => {
  const qc = useQueryClient();
  return (id: string) => {
    const cur = qc.getQueryData<ForYou>(forYouKey);
    if (cur)
      qc.setQueryData<ForYou>(forYouKey, {
        ...cur,
        items: cur.items.filter((x) => x.id !== id),
      });
    void qc.invalidateQueries({ queryKey: forYouKey });
  };
};

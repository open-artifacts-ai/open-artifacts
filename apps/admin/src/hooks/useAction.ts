import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError, api } from "../api/client";
import { reauthHref } from "../api/reauth";
import { newRequestId } from "../api/requestId";

/**
 * A write. `fn` gets a request id that stays the same across a retry after a
 * network failure (the API replays it) and is new after an answer or a success.
 * A `reauth_required` answer sends the user to a fresh sign-in that returns here.
 */
export function useAction<V, R>(
  fn: (v: V, requestId: string) => Promise<R>,
  o: {
    invalidate?: QueryKey[];
    onSuccess?: (r: R, v: V) => void;
    /** What the request body depends on; a change drops a request id kept for a retry. */
    key?: unknown;
  } = {},
) {
  const qc = useQueryClient();
  const pending = useRef<{ id: string; key: string } | null>(null);
  return useMutation<R, unknown, V>({
    mutationFn: (v) => {
      const key = JSON.stringify([o.key ?? null, v ?? null]);
      if (pending.current?.key !== key)
        pending.current = { id: newRequestId(), key };
      return fn(v, pending.current.id);
    },
    onSuccess: (r, v) => {
      pending.current = null;
      for (const key of o.invalidate ?? [])
        void qc.invalidateQueries({ queryKey: key });
      o.onSuccess?.(r, v);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        pending.current = null;
        if (e.code === "reauth_required")
          api.redirect(
            reauthHref(`${window.location.pathname}${window.location.search}`),
          );
      }
    },
  });
}

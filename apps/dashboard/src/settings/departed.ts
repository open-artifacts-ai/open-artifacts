import type { Me, Member, TransferSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiClientError, api } from "../api/client";
import { TransferSummarySchema } from "../api/contract";
import { qk, useMembers } from "../api/queries";

type Gone = Member & { status: "suspended" | "removed" };
export type Departed = { member: Gone; summary: TransferSummary };

/** Only real departures: never trust the server's ?status filter alone. */
const isGone = (m: Member): m is Gone =>
  m.status === "suspended" || m.status === "removed";

/** Org owners and admins, on every install (parity 1): who may see departed people. */
export const seesDeparted = (me: Me | null | undefined) =>
  !!me && (me.user.role === "owner" || me.user.role === "admin");

/** Only the uncapped owner reads an owner's or admin's counts (403 owner_only). */
const ownerOnlySource = (source: Member, callerIsOwner: boolean) =>
  (source.role === "admin" || source.role === "owner") && !callerIsOwner;

/**
 * A first load that failed. A failed refetch keeps its cached data, so it
 * isn't one; nor is a 404, the role gate (a capped or demoted caller, and
 * /me refreshes) or a person who no longer exists; nor is a 403 owner_only,
 * a refusal, which only a stale role can reach now those sources are skipped.
 */
const loadFailed = (q: { isLoadingError: boolean; error: unknown }) =>
  q.isLoadingError &&
  !(
    q.error instanceof ApiClientError &&
    (q.error.status === 404 || q.error.code === "owner_only")
  );

/**
 * Suspended or removed members who still have personal artifacts, with their
 * counts (never titles: only R.memberTransfer, never their artifacts).
 * People with nothing left are left out, and so are those whose artifacts
 * only the owner may transfer: no row, no count, no dot. `failed`: the list
 * or someone's summary never loaded, so `people` may be short; `retry` asks
 * again, and
 * `retrying` holds that state until it settles, so the card and its error
 * stay put.
 */
export const useDeparted = (me: Me | null | undefined) => {
  const on = seesDeparted(me);
  const list = useMembers("suspended,removed", on);
  const owner = me?.user.role === "owner" && me.auth?.cap == null;
  const gone = on
    ? (list.data ?? []).filter(isGone).filter((m) => !ownerOnlySource(m, owner))
    : [];
  const summaries = useQueries({
    queries: gone.map((m) => ({
      queryKey: qk.memberTransfer(m.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(R.memberTransfer(m.id), TransferSummarySchema, signal),
    })),
  });
  const people: Departed[] = gone.flatMap((member, i) => {
    const summary = summaries[i]?.data;
    return summary && summary.live + summary.deleted > 0
      ? [{ member, summary }]
      : [];
  });
  const stuck = [list, ...summaries].filter(loadFailed);
  // Set by retry: the error it answers. Covers the summaries a retried list adds.
  const [retried, setRetried] = useState<{ error: unknown } | null>(null);
  const loading =
    list.isFetching || summaries.some((q) => q.isFetching || q.isPending);
  useEffect(() => {
    if (retried && !loading) setRetried(null);
  }, [retried, loading]);
  return {
    people,
    failed: stuck.length > 0 || retried !== null,
    error: stuck[0]?.error ?? retried?.error,
    retrying: retried !== null,
    retry: () => {
      setRetried({ error: stuck[0]?.error });
      for (const q of stuck) void q.refetch();
    },
  };
};

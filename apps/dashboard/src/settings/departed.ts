import type { Me, Member, TransferSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { useQueries } from "@tanstack/react-query";
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

/**
 * A first load that failed. A failed refetch keeps its cached data, so it
 * isn't one; nor is a 404, the role gate (a capped or demoted caller, and
 * /me refreshes) or a person who no longer exists. #831's 403 owner_only
 * lands here until that merge drops those people (Design's rule).
 */
const loadFailed = (q: { isLoadingError: boolean; error: unknown }) =>
  q.isLoadingError &&
  !(q.error instanceof ApiClientError && q.error.status === 404);

/**
 * Suspended or removed members who still have personal artifacts, with their
 * counts (never titles: only R.memberTransfer, never their artifacts).
 * People with nothing left are left out. `failed`: the list or someone's
 * summary never loaded, so `people` may be short; `retry` asks again.
 */
export const useDeparted = (me: Me | null | undefined) => {
  const on = seesDeparted(me);
  const list = useMembers("suspended,removed", on);
  const gone = on ? (list.data ?? []).filter(isGone) : [];
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
  return {
    people,
    failed: stuck.length > 0,
    error: stuck[0]?.error,
    retry: () => {
      for (const q of stuck) void q.refetch();
    },
  };
};

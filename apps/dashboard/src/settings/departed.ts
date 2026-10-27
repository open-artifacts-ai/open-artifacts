import type { Me, Member, TransferSummary } from "@oa/shared";
import { R } from "@oa/shared";
import { useQueries } from "@tanstack/react-query";
import { api } from "../api/client";
import { hasFeature, TransferSummarySchema } from "../api/contract";
import { qk, useMembers } from "../api/queries";

type Gone = Member & { status: "suspended" | "removed" };
export type Departed = { member: Gone; summary: TransferSummary };

/** Only real departures: never trust the server's ?status filter alone. */
const isGone = (m: Member): m is Gone =>
  m.status === "suspended" || m.status === "removed";

/** Org owners and admins on a hosted install: who may see departed people. */
export const seesDeparted = (me: Me | null | undefined) =>
  !!me &&
  hasFeature(me, "spaces") &&
  (me.user.role === "owner" || me.user.role === "admin");

/**
 * Suspended or removed members who still have personal artifacts, with their
 * counts (never titles: only R.memberTransfer, never their artifacts).
 * People with nothing left are left out.
 */
export const useDeparted = (me: Me | null | undefined): Departed[] => {
  const on = seesDeparted(me);
  const people = useMembers("suspended,removed", on);
  const list = on ? (people.data ?? []).filter(isGone) : [];
  const summaries = useQueries({
    queries: list.map((m) => ({
      queryKey: qk.memberTransfer(m.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get(R.memberTransfer(m.id), TransferSummarySchema, signal),
    })),
  });
  return list.flatMap((member, i) => {
    const summary = summaries[i]?.data;
    return summary && summary.live + summary.deleted > 0
      ? [{ member, summary }]
      : [];
  });
};

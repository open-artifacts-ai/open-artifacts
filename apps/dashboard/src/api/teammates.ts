/** #2577: the team's members (R.meTeammates) and the first-setup question's flag (R.meOnboardingListensAsked). */
import {
  type Onboarding,
  OnboardingSchema,
  R,
  type Teammates,
  TeammatesSchema,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { qk } from "./queries";

export type MyTeammate = Teammates["members"][number];

/**
 * The team's other members. A guest or restricted caller is refused (403, or
 * 404 on an older server): the query errors and callers show their own
 * fallback or an empty state.
 */
export const useMyTeammates = (enabled = true) =>
  useQuery({
    enabled,
    // Not under ["me"]: invalidating the person would refetch it (and a refused one again and again).
    queryKey: ["teammates"],
    // A 403 or 404 settles to "no teammates": never retried, never refetched.
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 10 * 60_000,
    queryFn: ({ signal }) => api.get(R.meTeammates, TeammatesSchema, signal),
  });

/** Whether the first-setup question was answered; absent on an old server. */
export const listensAskedOf = (o: Onboarding | undefined) => o?.listensAsked;

/** Marks the first-setup question as asked (idempotent). */
export const useMarkListensAsked = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.send("POST", R.meOnboardingListensAsked, undefined, OnboardingSchema),
    onSuccess: (o) =>
      o
        ? qc.setQueryData(qk.onboarding, o)
        : qc.setQueryData<Onboarding | undefined>(qk.onboarding, (cur) =>
            cur ? { ...cur, listensAsked: true } : cur,
          ),
  });
};

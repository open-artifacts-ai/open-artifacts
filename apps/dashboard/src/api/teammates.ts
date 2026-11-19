// PROVISIONAL (#2577 s2): the shapes of OA Backend-3's next routes, mirrored
// here until packages/shared carries them. When it does, delete this file and
// import the same names from @oa/shared.
//   - GET R.meTeammates -> { members: [{ id, name, initials }] }: the team's
//     members for any signed-in member (never emails, never the caller).
//   - Share rows and PUT share responses gain `memberId: string | null`.
//   - R.onboarding gains `listensAsked: boolean`; POST LISTENS_ASKED sets it
//     (browser session, idempotent).
import { OnboardingSchema, ShareResultSchema, ShareSchema } from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client";

export const ME_TEAMMATES = "/api/v1/me/teammates";
export const LISTENS_ASKED = "/api/v1/me/onboarding/listens-asked";

export const TeammateSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
});
export type MyTeammate = z.infer<typeof TeammateSchema>;
export const TeammatesSchema = z.object({ members: z.array(TeammateSchema) });

/** The team's members. An older server answers 404: this query errors and callers fall back. */
export const useMyTeammates = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: ["me", "teammates"],
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) => api.get(ME_TEAMMATES, TeammatesSchema, signal),
  });

export const OnboardingWithListens = OnboardingSchema.extend({
  listensAsked: z.boolean().optional(),
});
export type OnboardingWithListens = z.infer<typeof OnboardingWithListens>;

/** Whether the first-setup question was answered; absent on an old server. */
export const listensAskedOf = (o: object | undefined): boolean | undefined =>
  (o as { listensAsked?: boolean } | undefined)?.listensAsked;

export const ShareRowWithMember = ShareSchema.extend({
  memberId: z.string().nullable().optional(),
});
export const ShareResultWithMember = ShareResultSchema.extend({
  memberId: z.string().nullable().optional(),
});

/** Marks the first-setup question as asked (idempotent). */
export const useMarkListensAsked = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.send("POST", LISTENS_ASKED, undefined),
    onSuccess: () =>
      qc.setQueryData<object | undefined>(["onboarding"], (o) =>
        o ? { ...o, listensAsked: true } : o,
      ),
  });
};

// #2632 (member onboarding): the one place that reads the PROVISIONAL parts
// of the contract Frontend proposed on the issue (comment 6904056554), until
// OA Self-Serve confirms them:
//
// - GET R.onboarding answers every member, per caller (same shape; dismissed
//   and completed per person), plus `teamStep`. A guest gets 403.
// - Not in that contract yet: `invitedBy` on R.onboarding (a member's Welcome
//   names who added them) and `instanceOwner` on GET /me (a guest's "ask
//   {owner}"). Both are optional here; without them the page says less.
//
// The queries (api/queries.ts) and the bridge (viewer/bridge.ts) parse
// R.onboarding with MyOnboardingSchema, so a renamed field is a change here.
import {
  type Onboarding,
  type OnboardingPatch,
  OnboardingSchema,
  R,
} from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client";

/** R.onboarding with the PROVISIONAL fields (strict, as OnboardingSchema is). */
export const MyOnboardingSchema = OnboardingSchema.extend({
  /** PROVISIONAL: commented on a teammate's page (the optional sixth step). */
  teamStep: z.boolean().optional(),
  /** PROVISIONAL, not in the contract: who added the caller. */
  invitedBy: z
    .strictObject({ name: z.string().nullable() })
    .nullable()
    .optional(),
});
export type MyOnboarding = z.infer<typeof MyOnboardingSchema>;

/** PROVISIONAL, not in the contract: the instance owner's name, from /me. */
const OwnerNameSchema = z.object({
  instanceOwner: z
    .object({ name: z.string().nullable() })
    .nullable()
    .optional(),
});
export function useOwnerName(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["me", "instanceOwner"],
    queryFn: ({ signal }) => api.get(R.me, OwnerNameSchema, signal),
    select: (d) => d.instanceOwner?.name?.trim() || null,
    staleTime: 60_000,
  });
}

export type MySteps = {
  connected: boolean;
  named: boolean;
  published: boolean;
  replied: boolean;
  answered: boolean;
  /** The optional sixth: never counts toward "Set up". */
  team: boolean;
  hidden: boolean;
  completed: boolean;
};

/** The caller's own steps, from their R.onboarding. */
export const mySteps = (
  o: (Onboarding & { teamStep?: boolean }) | undefined,
): MySteps => ({
  connected: o?.agentConnected === true,
  named: o?.agentNamed === true,
  published: !!o?.firstArtifact,
  replied: o?.mentionReplied === true,
  answered: o?.askAnswered === true,
  team: o?.teamStep === true,
  hidden: o?.dismissed === true,
  completed: o?.completed === true,
});

/** The five that make "Set up" (the sixth never counts). */
export const fiveOf = (s: MySteps) => [
  s.connected,
  s.named,
  s.published,
  s.replied,
  s.answered,
];

/** First word of a display name, for "Welcome, {first name}". */
export const firstName = (name: string | null | undefined) =>
  name?.trim().split(/\s+/)[0] || null;

/**
 * A member's own Hide, done and first open, kept for this tab's session.
 * Today's server answers a member's PUT with 403 (not saved), and the owner's
 * install-wide state must never change for them; this is what stays.
 */
const LOCAL = (userId: string) => `oa.onboarding.mine.${userId}`;
export function readLocal(userId: string | undefined): OnboardingPatch {
  if (!userId) return {};
  try {
    return JSON.parse(sessionStorage.getItem(LOCAL(userId)) ?? "{}");
  } catch {
    return {};
  }
}
export function keepLocal(userId: string, patch: OnboardingPatch) {
  const next = { ...readLocal(userId), ...patch };
  try {
    sessionStorage.setItem(LOCAL(userId), JSON.stringify(next));
  } catch {
    // No storage: the cache's optimistic answer holds until the next read.
  }
}
/** The server's answer with the session's own changes on top. */
export const withLocal = <T extends object>(
  o: T | undefined,
  userId: string | undefined,
): T | undefined => (o && userId ? { ...o, ...readLocal(userId) } : o);

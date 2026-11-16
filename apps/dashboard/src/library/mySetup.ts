// #2632: one person's own setup (member onboarding, slice 1).
//
// PROVISIONAL (#2632, until OA Self-Serve pins the fields on GET /me): the
// per-person step times and the people around them. Every name below is
// provisional; this file is the one place that reads them, so swapping them
// is a change here only. Until the server sends them, each falls back to
// what R.onboarding already says for the caller.
import { type Onboarding, R } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "../api/client";

const At = z.string().nullable().optional();
/** PROVISIONAL: `me.setup`, when each of the caller's steps happened (ISO), or null. */
const SetupTimesSchema = z.object({
  connectedAt: At,
  namedAt: At,
  publishedAt: At,
  mentionRepliedAt: At,
  askAnsweredAt: At,
  /** The optional sixth step: never counts toward "Set up". */
  teammateCommentedAt: At,
  /** "Hide" on the card: hidden is not done. */
  hiddenAt: At,
  /** Five of five. */
  completedAt: At,
});
/** PROVISIONAL: the parts of GET /me this file reads (others are stripped). */
const MeSetupSchema = z.object({
  setup: SetupTimesSchema.optional(),
  /** Who added the caller (a member's Welcome names them). */
  invitedBy: z.object({ name: z.string().nullable() }).nullable().optional(),
  /** The instance owner's name (a guest's "ask {owner}"). */
  instanceOwner: z
    .object({ name: z.string().nullable() })
    .nullable()
    .optional(),
});
export type MeSetup = z.infer<typeof MeSetupSchema>;

/** The PROVISIONAL fields of GET /me, read on their own (cached with /me's life). */
export function useMeSetup(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["me", "setup"],
    queryFn: ({ signal }) => api.get(R.me, MeSetupSchema, signal),
    staleTime: 30_000,
  });
}

export type MySteps = {
  connected: boolean;
  named: boolean;
  published: boolean;
  replied: boolean;
  answered: boolean;
  /** Optional sixth: comment on a teammate's page. */
  teammate: boolean;
  hidden: boolean;
  completed: boolean;
};

const at = (v: string | null | undefined) => v != null;

/**
 * The caller's steps: the per-person times when the server sends them,
 * else R.onboarding's record of the caller (whose dismissed and completed
 * are install-wide until the server makes them per person).
 */
export function mySteps(
  setup: MeSetup["setup"],
  o: Onboarding | undefined,
): MySteps {
  if (setup)
    return {
      connected: at(setup.connectedAt),
      named: at(setup.namedAt),
      published: at(setup.publishedAt),
      replied: at(setup.mentionRepliedAt),
      answered: at(setup.askAnsweredAt),
      teammate: at(setup.teammateCommentedAt),
      hidden: at(setup.hiddenAt),
      completed: at(setup.completedAt),
    };
  return {
    connected: o?.agentConnected === true,
    named: o?.agentNamed === true,
    published: !!o?.firstArtifact,
    replied: o?.mentionReplied === true,
    answered: o?.askAnswered === true,
    teammate: false,
    hidden: o?.dismissed === true,
    completed: o?.completed === true,
  };
}

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

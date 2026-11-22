// #2632 (member onboarding): the caller's own R.onboarding (per person for
// any non-guest member; a guest gets 403), now in @oa/shared's
// OnboardingSchema (#2639: teamStep, invitedBy) and MeSchema
// (instanceOwner). This file keeps the derived steps and the session-local
// copy of a refused save.
import type { Onboarding, OnboardingPatch, SetupStep } from "@oa/shared";
import { useMe } from "../auth/useMe";

/** The instance owner's name (GET /me `instanceOwner`), for a guest's note. */
export function useOwnerName(): { pending: boolean; name: string | null } {
  const me = useMe();
  if (me.status === "loading") return { pending: true, name: null };
  return {
    pending: false,
    name:
      me.status === "authed" ? me.me.instanceOwner?.name?.trim() || null : null,
  };
}

export type MySteps = {
  connected: boolean;
  named: boolean;
  published: boolean;
  replied: boolean;
  answered: boolean;
  /** #2890: false (never connected the bus) hides named and mention. */
  bus: boolean;
  /** #2953: the person's first typed comment, on any page. */
  commented: boolean;
  /** #2953: the server sends the field, so the comment step shows. An older server: no step. */
  comment: boolean;
  /** The optional sixth: never counts toward "Set up". */
  team: boolean;
  hidden: boolean;
  completed: boolean;
};

/** The caller's own steps, from their R.onboarding. */
export const mySteps = (o: Onboarding | undefined): MySteps => ({
  connected: o?.agentConnected === true,
  named: o?.agentNamed === true,
  published: !!o?.firstArtifact,
  replied: o?.mentionReplied === true,
  answered: o?.askAnswered === true,
  bus: o?.busConnected !== false,
  commented: o?.firstComment != null,
  comment: o?.firstComment !== undefined,
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

/** Each step by name: the cards read their state from this. */
export const onByStep = (s: MySteps): Record<SetupStep, boolean> => ({
  agent: s.connected,
  named: s.named,
  artifact: s.published,
  comment: s.commented,
  mention: s.replied,
  ask: s.answered,
});

/** #2953 (OA Product-2's words): the "Comment on a page" step. */
export const COMMENT_STEP = {
  title: "Comment on a page",
  line: "Select some text on any page and leave a comment, or reply in a thread. It's how you, your team and your agents work on the same page.",
  done: (page: string) => `You commented on ${page}.`,
} as const;

/**
 * #2890: under the list when the bus-only steps (name, mention) are hidden.
 * OA Product's words.
 */
export const BUS_LINE =
  "Want your agent to hear @mentions on its own? Connect the bus from Claude Code or Claude Desktop's Code tab.";

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

/**
 * PROVISIONAL (#2632): OA Self-Serve's server PR adds setupSteps() to
 * @oa/shared with this same signature and count. Until it lands, this local
 * copy is the one the dashboard calls; swapping in theirs is one import in
 * each caller (library/MemberGetStarted.tsx, viewer/bridge.ts,
 * api/memberSetup.ts).
 *
 * #2632: one person's five setup steps, the one count everyone shows. The
 * member's Library card, their Welcome's "{n} of 5 done" and the server's
 * `setup` on R.members rows (Settings, Members) all call this, so the count
 * can't disagree.
 *
 * The five are the design v6 screens' and the card's: connect an agent, name
 * it, publish a first artifact, get a reply to a mention, answer the ask.
 * Signing in is not a step: a member who only logged in is "0 of 5", stalled
 * on "agent" ("no agent connected yet"). The optional sixth (`teamStep`)
 * never counts.
 */
export const SETUP_STEPS = [
  "agent",
  "named",
  "artifact",
  "mention",
  "ask",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** The R.onboarding fields the count reads (any may be absent: not done). */
export type SetupStepsInput = {
  agentConnected?: boolean | null;
  agentNamed?: boolean | null;
  firstArtifact?: unknown;
  mentionReplied?: boolean | null;
  askAnswered?: boolean | null;
};

export type SetupStepsResult = {
  /** Of 5. */
  done: number;
  /** The first step not done; absent at five of five. */
  stalled?: SetupStep;
};

export function setupSteps(
  o: SetupStepsInput | null | undefined,
): SetupStepsResult {
  const on: Record<SetupStep, boolean> = {
    agent: o?.agentConnected === true,
    named: o?.agentNamed === true,
    artifact: o?.firstArtifact != null,
    mention: o?.mentionReplied === true,
    ask: o?.askAnswered === true,
  };
  const done = SETUP_STEPS.filter((s) => on[s]).length;
  const stalled = SETUP_STEPS.find((s) => !on[s]);
  return stalled ? { done, stalled } : { done };
}

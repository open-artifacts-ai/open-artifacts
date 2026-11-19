/**
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

/**
 * Steps that only the bus can tick: "named" (the bus hub records the name) and
 * "mention" (needs a verified bus identity's reply). A person who only uses
 * Open Artifacts from ChatGPT or a regular Claude chat never connects the bus,
 * so for them these two are hidden and the count is of 3 (#2890).
 */
export const BUS_STEPS = [
  "named",
  "mention",
] as const satisfies readonly SetupStep[];

/**
 * The steps that apply to this person, in order. `busConnected` false hides the
 * bus-only steps; absent or null (an older server) is true: all five.
 */
export function applicableSteps(
  busConnected?: boolean | null,
): readonly SetupStep[] {
  return busConnected === false
    ? SETUP_STEPS.filter(
        (s) => !(BUS_STEPS as readonly SetupStep[]).includes(s),
      )
    : SETUP_STEPS;
}

/** The R.onboarding fields the count reads (any may be absent: not done). */
export type SetupStepsInput = {
  agentConnected?: boolean | null;
  agentNamed?: boolean | null;
  firstArtifact?: unknown;
  mentionReplied?: boolean | null;
  askAnswered?: boolean | null;
  /** The person has ever connected the bus. False: three steps. Absent: five. */
  busConnected?: boolean | null;
};

export type SetupStepsResult = {
  /** Of `total`. */
  done: number;
  /** 5, or 3 when the bus was never connected. */
  total: number;
  /** The steps that apply, in order. */
  steps: readonly SetupStep[];
  /** The first applicable step not done; absent when all are done. */
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
  const steps = applicableSteps(o?.busConnected);
  const done = steps.filter((s) => on[s]).length;
  const stalled = steps.find((s) => !on[s]);
  return {
    done,
    total: steps.length,
    steps,
    ...(stalled ? { stalled } : {}),
  };
}

/**
 * #2632: one person's setup steps (five; #2890 three without the bus; #2953 a
 * "comment" step for everyone: six, or four without the bus), the one count everyone shows. The
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
  "comment",
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
 * bus-only steps; absent or null (an older server) is true. `comment` (#2953)
 * adds "Comment on a page" for everyone, but only when the server sends the
 * field (`firstComment` present, even null); an older server keeps today's steps.
 */
export function applicableSteps(
  busConnected?: boolean | null,
  comment?: boolean | null,
): readonly SetupStep[] {
  return SETUP_STEPS.filter(
    (s) =>
      !(
        busConnected === false &&
        (BUS_STEPS as readonly SetupStep[]).includes(s)
      ) && !(s === "comment" && comment !== true),
  );
}

/** The R.onboarding fields the count reads (any may be absent: not done). */
export type SetupStepsInput = {
  agentConnected?: boolean | null;
  agentNamed?: boolean | null;
  firstArtifact?: unknown;
  /**
   * #2953: the person's first typed comment ({ artifactId, title }), or null.
   * Absent (an older server): the step is not in the list at all.
   */
  firstComment?: unknown;
  mentionReplied?: boolean | null;
  askAnswered?: boolean | null;
  /** The person has ever connected the bus. False: three steps. Absent: five. */
  busConnected?: boolean | null;
};

export type SetupStepsResult = {
  /** Of `total`. */
  done: number;
  /** 3 to 6: 5 or 3 without the comment step, 6 or 4 with it, 3 or 4 without the bus. */
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
    comment: o?.firstComment != null,
    mention: o?.mentionReplied === true,
    ask: o?.askAnswered === true,
  };
  const steps = applicableSteps(o?.busConnected, o?.firstComment !== undefined);
  const done = steps.filter((s) => on[s]).length;
  const stalled = steps.find((s) => !on[s]);
  return {
    done,
    total: steps.length,
    steps,
    ...(stalled ? { stalled } : {}),
  };
}

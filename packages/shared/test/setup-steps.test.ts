import { describe, expect, it } from "vitest";
import { setupSteps } from "../src/setup-steps.js";

const all = {
  agentConnected: true,
  agentNamed: true,
  firstArtifact: { id: "a", title: "A" },
  mentionReplied: true,
  askAnswered: true,
};

describe("setupSteps (#2632)", () => {
  it("a member who only logged in: 0 of 5, no agent connected yet", () => {
    expect(setupSteps({})).toEqual({ done: 0, stalled: "agent" });
    expect(setupSteps(null)).toEqual({ done: 0, stalled: "agent" });
    expect(setupSteps({ agentConnected: false, firstArtifact: null })).toEqual({
      done: 0,
      stalled: "agent",
    });
  });

  it("each step in turn: the count and the step holding it up", () => {
    expect(setupSteps({ agentConnected: true })).toEqual({
      done: 1,
      stalled: "named",
    });
    expect(setupSteps({ agentConnected: true, agentNamed: true })).toEqual({
      done: 2,
      stalled: "artifact",
    });
    expect(
      setupSteps({ ...all, mentionReplied: false, askAnswered: false }),
    ).toEqual({ done: 3, stalled: "mention" });
    expect(setupSteps({ ...all, askAnswered: false })).toEqual({
      done: 4,
      stalled: "ask",
    });
    expect(setupSteps(all)).toEqual({ done: 5 });
  });

  it("stalled is the first step not done, whatever comes after", () => {
    expect(setupSteps({ ...all, agentNamed: false })).toEqual({
      done: 4,
      stalled: "named",
    });
    expect(setupSteps({ ...all, agentConnected: false })).toEqual({
      done: 4,
      stalled: "agent",
    });
  });

  it("the optional sixth never counts", () => {
    expect(setupSteps({ teamStep: true } as never)).toEqual({
      done: 0,
      stalled: "agent",
    });
  });
});

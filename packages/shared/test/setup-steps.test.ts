import { describe, expect, it } from "vitest";
import { applicableSteps, setupSteps as steps } from "../src/setup-steps.js";

/** The count and the step holding it up (the step list is asserted apart). */
const setupSteps = (o: Parameters<typeof steps>[0]) => {
  const { steps: _s, ...r } = steps(o);
  return r;
};

const all = {
  agentConnected: true,
  agentNamed: true,
  firstArtifact: { id: "a", title: "A" },
  mentionReplied: true,
  askAnswered: true,
};

describe("setupSteps (#2632)", () => {
  it("a member who only logged in: 0 of 5, no agent connected yet", () => {
    expect(setupSteps({})).toEqual({ done: 0, total: 5, stalled: "agent" });
    expect(setupSteps(null)).toEqual({ done: 0, total: 5, stalled: "agent" });
    expect(setupSteps({ agentConnected: false, firstArtifact: null })).toEqual({
      done: 0,
      total: 5,
      stalled: "agent",
    });
  });

  it("each step in turn: the count and the step holding it up", () => {
    expect(setupSteps({ agentConnected: true })).toEqual({
      done: 1,
      total: 5,
      stalled: "named",
    });
    expect(setupSteps({ agentConnected: true, agentNamed: true })).toEqual({
      done: 2,
      total: 5,
      stalled: "artifact",
    });
    expect(
      setupSteps({ ...all, mentionReplied: false, askAnswered: false }),
    ).toEqual({ done: 3, total: 5, stalled: "mention" });
    expect(setupSteps({ ...all, askAnswered: false })).toEqual({
      done: 4,
      total: 5,
      stalled: "ask",
    });
    expect(setupSteps(all)).toEqual({ done: 5, total: 5 });
  });

  it("stalled is the first step not done, whatever comes after", () => {
    expect(setupSteps({ ...all, agentNamed: false })).toEqual({
      done: 4,
      total: 5,
      stalled: "named",
    });
    expect(setupSteps({ ...all, agentConnected: false })).toEqual({
      done: 4,
      total: 5,
      stalled: "agent",
    });
  });

  it("the optional sixth never counts", () => {
    expect(setupSteps({ teamStep: true } as never)).toEqual({
      done: 0,
      total: 5,
      stalled: "agent",
    });
  });

  it("absent busConnected (an older server) is five steps", () => {
    expect(applicableSteps(undefined)).toEqual([
      "agent",
      "named",
      "artifact",
      "mention",
      "ask",
    ]);
    expect(applicableSteps(null)).toHaveLength(5);
    expect(applicableSteps(true)).toHaveLength(5);
    expect(setupSteps({ ...all, busConnected: true })).toEqual({
      done: 5,
      total: 5,
    });
  });

  it("a person who never connected the bus has three steps: agent, artifact, ask", () => {
    expect(applicableSteps(false)).toEqual(["agent", "artifact", "ask"]);
    const chat = { busConnected: false };
    expect(setupSteps(chat)).toEqual({ done: 0, total: 3, stalled: "agent" });
    expect(setupSteps({ ...chat, agentConnected: true })).toEqual({
      done: 1,
      total: 3,
      stalled: "artifact",
    });
    // named and mention never hold it up, and never count
    expect(
      setupSteps({
        ...chat,
        agentConnected: true,
        firstArtifact: { id: "a" },
        agentNamed: false,
        mentionReplied: false,
      }),
    ).toEqual({ done: 2, total: 3, stalled: "ask" });
    expect(setupSteps({ ...all, busConnected: false })).toEqual({
      done: 3,
      total: 3,
    });
    expect(
      setupSteps({
        agentConnected: true,
        firstArtifact: { id: "a" },
        askAnswered: true,
        busConnected: false,
      }),
    ).toEqual({ done: 3, total: 3 });
  });

  it("once the bus connects the two steps come back", () => {
    const o = {
      agentConnected: true,
      firstArtifact: { id: "a" },
      askAnswered: true,
    };
    expect(setupSteps({ ...o, busConnected: false })).toEqual({
      done: 3,
      total: 3,
    });
    expect(setupSteps({ ...o, busConnected: true })).toEqual({
      done: 3,
      total: 5,
      stalled: "named",
    });
  });
});

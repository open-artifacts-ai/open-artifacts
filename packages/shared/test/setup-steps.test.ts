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

  describe("the comment step (#2953)", () => {
    it("is in the list only when the server sends firstComment, even null", () => {
      expect(applicableSteps(true, false)).toHaveLength(5);
      expect(applicableSteps(true, undefined)).toHaveLength(5);
      expect(applicableSteps(true, true)).toEqual([
        "agent",
        "named",
        "artifact",
        "comment",
        "mention",
        "ask",
      ]);
      expect(applicableSteps(false, true)).toEqual([
        "agent",
        "artifact",
        "comment",
        "ask",
      ]);
    });

    it("an older server (no field): today's counts, whatever else is sent", () => {
      expect(setupSteps(all)).toEqual({ done: 5, total: 5 });
      expect(setupSteps({ ...all, busConnected: false })).toEqual({
        done: 3,
        total: 3,
      });
    });

    it("bus members count six, chat-only four", () => {
      const c = { artifactId: "a", title: "A" };
      expect(setupSteps({ ...all, firstComment: null })).toEqual({
        done: 5,
        total: 6,
        stalled: "comment",
      });
      expect(setupSteps({ ...all, firstComment: c })).toEqual({
        done: 6,
        total: 6,
      });
      expect(
        setupSteps({ ...all, busConnected: false, firstComment: null }),
      ).toEqual({ done: 3, total: 4, stalled: "comment" });
      expect(
        setupSteps({ ...all, busConnected: false, firstComment: c }),
      ).toEqual({ done: 4, total: 4 });
    });

    it("is held up in order: after publish, before mention", () => {
      const o = {
        agentConnected: true,
        agentNamed: true,
        firstArtifact: { id: "a" },
        firstComment: null,
        mentionReplied: true,
        askAnswered: true,
      };
      expect(setupSteps(o).stalled).toBe("comment");
      expect(setupSteps({ ...o, firstArtifact: null }).stalled).toBe(
        "artifact",
      );
      expect(setupSteps({ ...o, mentionReplied: false }).stalled).toBe(
        "comment",
      );
    });
  });
});

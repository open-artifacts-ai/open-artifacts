import type { ArtifactToShell, ShellToArtifact } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComments } from "../src/comments.js";

// The frame half of comments with the smallest harness: a bridge double and a
// page of text. What the paint does when the page has no highlight surface at
// all (#1473).

let ctl: AbortController;
const realParent = window.parent;

beforeEach(() => {
  ctl = new AbortController();
  document.body.innerHTML = "<p>The quick brown fox.</p>";
  Object.defineProperty(window, "parent", {
    value: { postMessage: () => {} },
    configurable: true,
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  ctl.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  document.body.replaceChildren();
});

const bridge = () => {
  const listeners: ((m: ShellToArtifact) => void)[] = [];
  const sent: ArtifactToShell[] = [];
  return {
    sent,
    on: (l: (m: ShellToArtifact) => void) => {
      listeners.push(l);
      return () => {};
    },
    send: (m: ArtifactToShell) => sent.push(m),
    emit: (m: ShellToArtifact) => {
      for (const l of [...listeners]) l(m);
    },
  };
};

const THREAD = {
  id: "t1",
  anchor: {
    kind: "text" as const,
    version: 1,
    exact: "quick",
    prefix: "The ",
    suffix: " brown fox.",
  },
};

describe("comments: no highlight surface (#1473)", () => {
  it("reports positions and does not throw when CSS.highlights is missing", () => {
    // Older browsers: `CSS` exists, the highlight registry does not.
    vi.stubGlobal("CSS", {});
    const b = bridge();
    const comments = createComments(b, ctl.signal);
    expect(() => {
      b.emit({ oa: 1, type: "comments.mode", mode: "select" });
      b.emit({ oa: 1, type: "comments.set", threads: [THREAD] });
      comments.flush();
    }).not.toThrow();
    // The missing registry drops styling only; the shell still gets the spots.
    const positions = b.sent.filter((m) => m.type === "comment.positions");
    expect(positions.length).toBeGreaterThan(0);
  });
});

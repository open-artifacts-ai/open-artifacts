import type { ArtifactToShell, ShellToArtifact } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComments } from "../src/comments.js";

// The frame half of comments without the full runtime: a bridge double, a page
// of text, and the highlight registry stubbed the way jsdom needs it (#1473).

type CommentsBridge = {
  on: (l: (m: ShellToArtifact) => void) => () => void;
  send: (m: ArtifactToShell) => void;
  emit: (m: ShellToArtifact) => void;
};

let sent: ArtifactToShell[];
let emit: (m: ShellToArtifact) => void;
let b: CommentsBridge;
let ctl: AbortController;
let highlights: Map<string, unknown>;
const realParent = window.parent;

const PAGE = "<p id=a>The quick brown fox.</p>";

function bridge(): CommentsBridge {
  const listeners: ((m: ShellToArtifact) => void)[] = [];
  return {
    on: (l) => {
      listeners.push(l);
      return () => {
        listeners.splice(listeners.indexOf(l), 1);
      };
    },
    send: (m) => sent.push(m),
    emit: (m) => {
      for (const l of [...listeners]) l(m);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  ctl = new AbortController();
  sent = [];
  document.body.innerHTML = PAGE;
  document.head.replaceChildren();
  b = bridge();
  emit = b.emit;
  highlights = new Map();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class {
      ranges: Range[];
      constructor(...r: Range[]) {
        this.ranges = r;
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(window, "parent", {
    value: { postMessage: () => {} },
    configurable: true,
  });
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
  document.head.replaceChildren();
  document.documentElement.querySelectorAll(":scope > div").forEach((d) => {
    d.remove();
  });
});

const thread = {
  id: "t1",
  anchor: {
    kind: "text" as const,
    version: 1,
    exact: "quick",
    prefix: "The ",
    suffix: " brown fox.",
  },
};

const show = async (extra: Record<string, unknown> = {}) => {
  emit({ oa: 1, type: "comments.mode", mode: "select" });
  emit({ oa: 1, type: "comments.set", threads: [{ ...thread, ...extra }] });
  await flush();
};

const pageStyle = () =>
  document.head.querySelector("style[data-oa=highlights]");

describe("comments: the page's highlight rules (#1473)", () => {
  it("live in a style element the page's adopted sheets cannot take away", async () => {
    createComments(b, ctl.signal);
    await show();
    expect(highlights.has("oa-comment")).toBe(true);
    const style = pageStyle();
    expect(style?.textContent).toContain("::highlight(oa-comment)");
    // What broke it before: a page rewriting adoptedStyleSheets took the
    // highlights with it, and only a later paint put them back.
    document.adoptedStyleSheets = [];
    expect(pageStyle()).not.toBeNull();
    expect(pageStyle()).toBe(style);
  });

  it("are put back when something removes the style element", async () => {
    createComments(b, ctl.signal);
    await show();
    const style = pageStyle();
    style?.remove();
    expect(pageStyle()).toBeNull();
    // Any page mutation puts them back, before the next paint has to.
    document.body.append(document.createElement("span"));
    await flush();
    expect(pageStyle()).not.toBeNull();
  });

  it("go with dispose, and so does any later flush", async () => {
    const comments = createComments(b, ctl.signal);
    await show();
    expect(highlights.size).toBeGreaterThan(0);
    ctl.abort();
    expect(pageStyle()).toBeNull();
    expect(highlights.has("oa-comment")).toBe(false);
    const before = sent.length;
    comments.flush();
    expect(sent).toHaveLength(before);
    expect(document.documentElement.querySelector(":scope > div")).toBeNull();
  });

  it("paint without a highlight registry, and without throwing", async () => {
    vi.stubGlobal("CSS", {});
    createComments(b, ctl.signal);
    await show();
    // No registry: no styling to add, and nothing to add it to.
    expect(pageStyle()).toBeNull();
    expect(sent.some((m) => m.type === "comment.positions")).toBe(true);
  });
});

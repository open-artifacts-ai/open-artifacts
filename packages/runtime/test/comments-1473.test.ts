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
let sheets: CSSStyleSheet[];
const realParent = window.parent;
const realAdopted = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "adoptedStyleSheets",
);

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

/**
 * jsdom's `adoptedStyleSheets` is a getter, so the runtime's assignment throws
 * there and nothing is ever adopted. Shadow it with a settable pair; in a
 * browser the runtime assigns the same array.
 */
function stubbableSheets() {
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set: (v: CSSStyleSheet[]) => {
      sheets = [...v];
    },
  });
}

beforeEach(() => {
  ctl = new AbortController();
  sent = [];
  sheets = [];
  document.body.innerHTML = PAGE;
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
  stubbableSheets();
});

afterEach(() => {
  ctl.abort();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  if (realAdopted) Reflect.deleteProperty(document, "adoptedStyleSheets");
  document.body.replaceChildren();
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

describe("comments: the highlight sheet (#1473)", () => {
  it("adopts the sheet, never an inline style a CSP would block", async () => {
    createComments(b, ctl.signal);
    await show();
    expect(highlights.has("oa-comment")).toBe(true);
    expect(sheets).toHaveLength(1);
    // An inline <style> in the head would be the runtime's business only if the
    // page allowed inline styles; the sheet is not subject to style-src.
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("adopts the same sheet again after a page rewrites adoptedStyleSheets", async () => {
    createComments(b, ctl.signal);
    await show();
    const first = sheets[0];
    // A page rewriting the list takes ours with it; no paint may follow, so the
    // observer, a click and a selection change each put it back.
    sheets = [];
    document.body.append(document.createElement("span"));
    await flush();
    expect(sheets).toEqual([first]);
    sheets = [];
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
    );
    expect(sheets).toEqual([first]);
    sheets = [];
    document.dispatchEvent(new Event("selectionchange"));
    expect(sheets).toEqual([first]);
  });

  it("dispose drops the sheet, and a later flush() does nothing", async () => {
    const comments = createComments(b, ctl.signal);
    await show();
    expect(sheets).toHaveLength(1);
    ctl.abort();
    expect(sheets).toEqual([]);
    expect(highlights.has("oa-comment")).toBe(false);
    const before = sent.length;
    comments.flush();
    expect(sent).toHaveLength(before);
    expect(document.documentElement.querySelector(":scope > div")).toBeNull();
  });

  it("paints without a highlight registry, and without throwing", async () => {
    vi.stubGlobal("CSS", {});
    createComments(b, ctl.signal);
    await show();
    expect(sheets).toEqual([]);
    expect(sent.some((m) => m.type === "comment.positions")).toBe(true);
  });
});

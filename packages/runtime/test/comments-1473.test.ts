import type { ArtifactToShell, ShellToArtifact } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComments } from "../src/comments.js";

// The frame half of comments without the full runtime: a bridge double, a page
// of text, and the highlight surface set up the way jsdom needs it (#1473).

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
 * and no sheet is ever adopted there. Shadow it with a settable pair; in a
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

describe("comments: the page stylesheet (#1473)", () => {
  it("adopts the highlight stylesheet, and adopts it again after a page drops it", async () => {
    createComments(b, ctl.signal);
    await show();
    expect(highlights.has("oa-comment")).toBe(true);
    expect(sheets.length).toBe(1);
    const first = sheets[0];
    // A page that rewrites adoptedStyleSheets takes the highlights with it.
    sheets = [];
    // The next paint adopts the same sheet again, so highlights never go
    // unstyled and the registry keeps pointing at one rule set.
    await show({ active: true });
    expect(sheets).toEqual([first]);
    expect(highlights.has("oa-comment-active")).toBe(true);
  });

  it("paints without constructable stylesheets, and without throwing", async () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    createComments(b, ctl.signal);
    await show();
    expect(highlights.has("oa-comment")).toBe(true);
    expect(sheets).toEqual([]);
  });

  it("clears its highlights on dispose", async () => {
    createComments(b, ctl.signal);
    await show();
    expect(highlights.size).toBeGreaterThan(0);
    ctl.abort();
    expect(highlights.has("oa-comment")).toBe(false);
    expect(highlights.has("oa-comment-active")).toBe(false);
  });
});

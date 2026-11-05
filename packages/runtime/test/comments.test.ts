import { type ArtifactToShell, parseArtifactMessage } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import * as schemas from "../src/schemas.js";

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;
const roots: ShadowRoot[] = [];
let rafQueue: FrameRequestCallback[] = [];
let highlights: Map<string, { ranges: Range[] }>;
const rect = {
  top: 100,
  left: 20,
  right: 80,
  bottom: 120,
  width: 60,
  height: 20,
};

const msgs = (): ArtifactToShell[] =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as ArtifactToShell)
    .filter((m) => m.type.startsWith("comment."));
const last = (type: string) =>
  msgs()
    .filter((m) => m.type === type)
    .at(-1);
const fromShell = (data: unknown, source: unknown = parent) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: source as Window }),
  );
const send = async (data: object, source?: unknown) => {
  fromShell({ oa: 1, ...data }, source);
  await flush();
};
const frames = () => {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
};
const button = () =>
  roots.at(-1)?.querySelector<HTMLButtonElement>(".btn") ?? null;

function select(node: Node, a: number, node2: Node = node, b: number = a) {
  const r = document.createRange();
  r.setStart(node, a);
  r.setEnd(node2, b);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
  document.dispatchEvent(new Event("selectionchange"));
  frames();
}

const PAGE =
  "<p id=a>The quick brown fox jumps over the lazy dog.</p><p id=b>Second paragraph of text.</p>";
const textOf = (id: string) => document.getElementById(id)?.firstChild as Text;

beforeEach(() => {
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
  document.body.innerHTML = PAGE;
  rafQueue = [];
  Object.assign(rect, { top: 100, left: 20, right: 80, bottom: 120 });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    rafQueue.push(cb),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
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
  const attach = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, "attachShadow").mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit,
  ) {
    const r = attach.call(this, { ...init, mode: "open" });
    roots.push(r);
    return r;
  });
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    rect,
  ] as unknown as DOMRectList);
});
afterEach(() => {
  ctl.abort();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  roots.length = 0;
  getSelection()?.removeAllRanges();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.documentElement.querySelectorAll(":scope > div").forEach((d) => {
    d.remove();
  });
});

async function start(mode?: "select" | "pin") {
  createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
  await flush();
  if (mode) await send({ type: "comments.mode", mode });
}

const anchorOf = (quote: string, prefix = "", suffix = "") => ({
  kind: "text" as const,
  version: 1,
  exact: quote,
  prefix,
  suffix,
});

describe("shell messages are validated", () => {
  it("ignores bad shapes and messages not from the parent", async () => {
    await start("select");
    const good = {
      type: "comments.set",
      threads: [{ id: "t1", anchor: anchorOf("quick") }],
    };
    await send({ ...good, extra: 1 });
    await send({
      type: "comments.set",
      threads: [{ id: "bad id!", anchor: anchorOf("quick") }],
    });
    await send({
      type: "comments.set",
      threads: [{ id: "t1", anchor: { kind: "note" } }],
    });
    await send({
      type: "comments.set",
      threads: [{ id: "t1", anchor: anchorOf("x".repeat(1001)) }],
    });
    await send({
      type: "comments.set",
      threads: [{ id: "t1", anchor: anchorOf("quick"), body: "hi" }],
    });
    await send({ type: "comments.mode", mode: "everything" });
    await send(good, { postMessage: vi.fn() }); // wrong source
    await send(good, window); // an artifact script posting to itself
    expect(msgs()).toEqual([]);
    await send(good);
    expect(last("comment.positions")).toBeDefined();
  });
});

describe("selection button", () => {
  it("shows for a selection in one block and sends an anchor without a version", async () => {
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    const b = button();
    expect(b?.textContent).toBe("Comment");
    b?.click();
    await flush();
    const m = last("comment.select");
    expect(m).toMatchObject({
      anchor: {
        kind: "text",
        exact: "quick",
        prefix: "The ",
        suffix: " brown fox jumps over the lazy d",
      },
    });
    expect(Object.keys((m as { anchor: object }).anchor).sort()).toEqual([
      "exact",
      "kind",
      "prefix",
      "suffix",
    ]);
    expect(button()).toBeNull();
  });

  it("does not show for a selection across blocks, an empty one, or when off", async () => {
    await start("select");
    select(textOf("a"), 4, textOf("b"), 6);
    expect(button()).toBeNull();
    select(textOf("a"), 3, textOf("a"), 4); // one space
    expect(button()).toBeNull();
    await send({ type: "comments.mode", mode: "off" });
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
  });

  it("treats a triple-click (end at the start of the next block) as one block", async () => {
    await start("select");
    select(textOf("a"), 0, textOf("b"), 0);
    expect(button()).not.toBeNull();
  });

  it("stays hidden until the shell sends a mode", async () => {
    await start();
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
  });
});

describe("highlights and positions", () => {
  it("maps each resolve state to a position and paints exact and partial", async () => {
    await start("select");
    await send({
      type: "comments.set",
      threads: [
        { id: "ex", anchor: anchorOf("quick brown") },
        {
          id: "pa",
          anchor: anchorOf(
            "jumps over the lazy cat sat",
            "brown fox ",
            " dog.",
          ),
          active: true,
        },
        {
          id: "co",
          anchor: anchorOf(
            "totally gone words",
            "Second paragraph",
            " of text",
          ),
        },
        {
          id: "or",
          anchor: anchorOf("nothing here at all", "zzzzzzzz", "yyyyyyyy"),
        },
        { id: "rs", anchor: anchorOf("fox"), resolved: true },
      ],
    });
    const p = last("comment.positions") as Extract<
      ArtifactToShell,
      { type: "comment.positions" }
    >;
    expect(p.positions).toEqual([
      { id: "ex", state: "exact", top: 100 },
      { id: "pa", state: "partial", top: 100 },
      { id: "co", state: "collapsed", top: 100 },
      { id: "or", state: "orphan", top: null },
      { id: "rs", state: "exact", top: 100 },
    ]);
    expect(
      highlights.get("oa-comment")?.ranges.map((r) => r.toString()),
    ).toEqual(["quick brown"]);
    expect(
      highlights.get("oa-comment-active")?.ranges.map((r) => r.toString()),
    ).toEqual(["jumps over the lazy"]);
  });

  it("re-reports only when positions change, and after the text changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick") }],
    });
    const n = () => msgs().filter((m) => m.type === "comment.positions").length;
    expect(n()).toBe(1);
    window.dispatchEvent(new Event("resize"));
    frames();
    await flush();
    expect(n()).toBe(1); // same positions: nothing sent
    rect.top = 150;
    window.dispatchEvent(new Event("resize"));
    frames();
    await flush();
    expect(n()).toBe(2);
    rect.top = 100;
    textOf("a").data = `Intro. ${textOf("a").data}`;
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(n()).toBe(3);
    vi.useRealTimers();
  });

  it("clicking a highlight sends only the thread id", async () => {
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick brown") }],
    });
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 110 }),
    );
    await flush();
    expect(last("comment.open")).toMatchObject({
      type: "comment.open",
      id: "ex",
    });
    parent.postMessage.mockClear();
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 500, clientY: 500 }),
    );
    await flush();
    await flush();
    expect(last("comment.open")).toBeUndefined();
  });
});

describe("pins", () => {
  beforeEach(() => {
    const meta = document.createElement("meta");
    meta.name = "oa-format";
    meta.content = "image";
    document.head.append(meta);
    document.body.innerHTML = '<div class="oa-image"><img alt="x"></div>';
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 20,
      right: 220,
      bottom: 110,
      width: 200,
      height: 100,
    } as DOMRect);
  });

  it("a click in pin mode sends normalized coordinates", async () => {
    await start("pin");
    document.querySelector("img")?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 60,
      }),
    );
    await flush();
    expect(last("comment.pin")).toMatchObject({ pin: { x: 0.5, y: 0.5 } });
  });

  it("does nothing in select mode, and pins are drawn in the overlay with their number", async () => {
    await start("select");
    document
      .querySelector("img")
      ?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 60 }),
      );
    await flush();
    expect(last("comment.pin")).toBeUndefined();
    await send({
      type: "comments.set",
      threads: [
        {
          id: "p1",
          n: 3,
          anchor: {
            kind: "pin",
            version: 1,
            x: 0.5,
            y: 0.25,
            contentHash: "h",
          },
        },
      ],
    });
    expect(last("comment.positions")).toMatchObject({
      positions: [{ id: "p1", state: "pin", top: 35 }],
    });
    expect(roots.at(-1)?.querySelector(".pin")?.textContent).toBe("3");
    roots.at(-1)?.querySelector<HTMLElement>(".pin")?.click();
    await flush();
    expect(last("comment.open")).toMatchObject({ id: "p1" });
  });
});

describe("the page is left alone", () => {
  it("adds no node to the page outside one overlay host", async () => {
    const snap = () => [document.head.outerHTML, document.body.outerHTML];
    const before = snap();
    const htmlKids = Array.from(document.documentElement.childNodes);
    await start("select");
    await send({
      type: "comments.set",
      threads: [
        { id: "ex", anchor: anchorOf("quick brown") },
        {
          id: "co",
          anchor: anchorOf(
            "totally gone words",
            "Second paragraph",
            " of text",
          ),
        },
      ],
    });
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).not.toBeNull();
    expect(snap()).toEqual(before);
    const added = Array.from(document.documentElement.childNodes).filter(
      (n) => !htmlKids.includes(n),
    );
    expect(added).toHaveLength(1);
    expect((added[0] as Element).tagName).toBe("DIV");
    expect((added[0] as Element).childNodes).toHaveLength(0); // everything is in the shadow root
    ctl.abort();
    expect(Array.from(document.documentElement.childNodes)).toEqual(htmlKids);
  });
});

describe("what the frame sends", () => {
  it("only carries anchors, ids, states, positions and pin coordinates", async () => {
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick brown") }],
    });
    select(textOf("a"), 4, textOf("a"), 9);
    button()?.click();
    await flush();
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 110 }),
    );
    await flush();
    const allowed: Record<string, string[]> = {
      "comment.select": ["anchor", "oa", "type"],
      "comment.positions": ["oa", "positions", "type"],
      "comment.open": ["id", "oa", "type"],
      "comment.pin": ["oa", "pin", "type"],
    };
    const seen = msgs();
    expect(seen.map((m) => m.type).sort()).toEqual([
      "comment.open",
      "comment.positions",
      "comment.select",
    ]);
    for (const m of seen) {
      expect(Object.keys(m).sort()).toEqual(allowed[m.type]);
      expect(parseArtifactMessage(m)).not.toBeNull();
    }
    const pos = last("comment.positions") as Extract<
      ArtifactToShell,
      { type: "comment.positions" }
    >;
    for (const p of pos.positions)
      expect(Object.keys(p).sort()).toEqual(["id", "state", "top"]);
  });
});

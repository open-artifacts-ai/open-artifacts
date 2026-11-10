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

/**
 * jsdom has no FontFaceSet: a double that records `loadingdone` listeners, so a
 * test can finish a font batch the way the browser does (#1648).
 */
function fonts() {
  const listeners = new Set<() => void>();
  Object.defineProperty(document, "fonts", {
    value: {
      status: "loading",
      addEventListener: (_t: string, h: () => void) => listeners.add(h),
      removeEventListener: (_t: string, h: () => void) => listeners.delete(h),
    },
    configurable: true,
  });
  return {
    /** A finished batch: the browser fires `loadingdone` on the font set. */
    done() {
      for (const h of [...listeners]) h();
    },
    listening: () => listeners.size,
  };
}

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
  Reflect.deleteProperty(document, "fonts");
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

async function start(mode?: "view" | "select" | "pin") {
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

/** Pointer type for the frame: matchMedia answers only (pointer: coarse). */
const pointer = (coarse: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: coarse && q === "(pointer: coarse)",
    media: q,
  }));
const wait100 = () => new Promise((r) => setTimeout(r, 130));
const sels = () => msgs().filter((m) => m.type === "comment.selection");

describe("selection state for the shell (#1732)", () => {
  it("posts has and the last rect bottom, debounced, once per change", async () => {
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    select(textOf("a"), 4, textOf("a"), 10);
    expect(sels()).toHaveLength(0);
    await wait100();
    expect(sels()).toHaveLength(1);
    expect(last("comment.selection")).toMatchObject({ has: true, bottom: 120 });
    getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await wait100();
    expect(last("comment.selection")).toMatchObject({ has: false });
    expect(sels()).toHaveLength(2);
  });

  it("reports a selection made before the shell's mode, once select arrives", async () => {
    await start();
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    expect(sels()).toHaveLength(0);
    await send({ type: "comments.mode", mode: "select" });
    expect(last("comment.selection")).toMatchObject({ has: true, bottom: 120 });
    expect(sels()).toHaveLength(1);
  });

  it("posts nothing in view or pin mode", async () => {
    await start("view");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    expect(sels()).toHaveLength(0);
  });

  it("touch: no floating button; fine pointer keeps it", async () => {
    pointer(true);
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
    await wait100();
    expect(last("comment.selection")).toMatchObject({ has: true });
  });

  it("the shell command runs the Comment path, even after the selection collapsed", async () => {
    pointer(true);
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    getSelection()?.removeAllRanges(); // iOS: a tap outside the frame
    await send({ type: "comments.comment" });
    expect(last("comment.select")).toMatchObject({
      anchor: { kind: "text", exact: "quick" },
    });
    await wait100();
    expect(last("comment.selection")).toMatchObject({ has: false });
  });

  it("the command with nothing ever selected sends nothing", async () => {
    await start("select");
    await send({ type: "comments.comment" });
    expect(last("comment.select")).toBeUndefined();
  });

  it("touch: scrolls by the overlap when the selection ends within bar + 12px of the bottom", async () => {
    pointer(true);
    vi.stubGlobal("innerHeight", 600);
    const by = vi.fn();
    vi.stubGlobal("scrollBy", by);
    Object.assign(rect, { bottom: 570 });
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    // bar 48 + 12 gap: the line must end by 540; it ends at 570.
    expect(by).toHaveBeenCalledWith(0, 30);
  });

  it("touch: scrolls once when the bar appears, not while a handle is dragged (review of #1757)", async () => {
    pointer(true);
    vi.stubGlobal("innerHeight", 600);
    const by = vi.fn();
    vi.stubGlobal("scrollBy", by);
    Object.assign(rect, { bottom: 570 });
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    expect(by).toHaveBeenCalledTimes(1);
    Object.assign(rect, { bottom: 580 });
    select(textOf("a"), 4, textOf("a"), 10);
    await wait100();
    expect(by).toHaveBeenCalledTimes(1);
  });

  it("a collapsed selection is forgotten after the tap window (review of #1757)", async () => {
    pointer(true);
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await wait100();
    await new Promise((r) => setTimeout(r, 1600));
    await send({ type: "comments.comment" });
    expect(last("comment.select")).toBeUndefined();
  });

  it("touch: does not scroll when clear of the bar", async () => {
    pointer(true);
    vi.stubGlobal("innerHeight", 600);
    const by = vi.fn();
    vi.stubGlobal("scrollBy", by);
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await wait100();
    expect(by).not.toHaveBeenCalled();
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

  it("places the button again when a webfont reflows the page (#1648)", async () => {
    // The button's own width is fixed (closed shadow root, system-ui), so the
    // swap cannot change it; what moves is the selection's rect, as the page
    // reflows. The first rect puts the button at 30px, the second at 90px.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    const f = fonts();
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()?.style.left).toBe("30px");
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, right: 140, bottom: 200 },
    ] as unknown as DOMRectList);
    f.done();
    expect(button()?.style.left).toBe("90px");
    expect(button()?.style.top).toBe("206px");
  });

  it("leaves the button alone when it is gone by the time the fonts finish (#1648)", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    const f = fonts();
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    await send({ type: "comments.mode", mode: "off" });
    expect(button()).toBeNull();
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, right: 140, bottom: 200 },
    ] as unknown as DOMRectList);
    f.done();
    expect(button()).toBeNull();
  });

  it("listens for font batches once and stops on dispose (#1648)", async () => {
    const f = fonts();
    createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
    await flush();
    expect(f.listening()).toBe(1);
    ctl.abort();
    expect(f.listening()).toBe(0);
  });

  describe("late reflows (ResizeObserver)", () => {
    let sizes: { cb: () => void; on: Element[]; off: boolean }[] = [];
    beforeEach(() => {
      sizes = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          s: { cb: () => void; on: Element[]; off: boolean };
          constructor(cb: () => void) {
            this.s = { cb, on: [], off: false };
            sizes.push(this.s);
          }
          observe(el: Element) {
            this.s.on.push(el);
          }
          disconnect() {
            this.s.off = true;
          }
        },
      );
    });
    const reflow = () => {
      for (const s of sizes) if (!s.off) s.cb();
      frames();
    };

    it("places the button again when an image load reflows the page", async () => {
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(
        100,
      );
      await start("select");
      select(textOf("a"), 4, textOf("a"), 9);
      expect(button()?.style.left).toBe("30px");
      vi.mocked(Range.prototype.getClientRects).mockReturnValue([
        { ...rect, right: 140, bottom: 200 },
      ] as unknown as DOMRectList);
      reflow();
      expect(button()?.style.left).toBe("90px");
      expect(button()?.style.top).toBe("206px");
    });

    it("observes <html> once and disconnects on dispose", async () => {
      createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
      await flush();
      const live = sizes.filter((s) => s.on.includes(document.documentElement));
      expect(live).toHaveLength(1);
      ctl.abort();
      expect(live[0]?.off).toBe(true);
    });
  });

  it("has a bubble icon, is centered under the selection end, and clamps to the viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    const b = button();
    expect(b?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(b?.textContent).toBe("Comment");
    const vw = document.documentElement.clientWidth || innerWidth;
    // rect.right = 80, width 100: centered would be 30.
    expect(b?.style.left).toBe("30px");
    expect(b?.style.top).toBe("126px");
    // Near the left edge: clamped to the margin.
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, right: 10 },
    ] as unknown as DOMRectList);
    select(textOf("a"), 3, textOf("a"), 9);
    expect(button()?.style.left).toBe("4px");
    // Near the right edge: clamped to the viewport.
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, right: vw + 50 },
    ] as unknown as DOMRectList);
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()?.style.left).toBe(`${vw - 100 - 4}px`);
  });

  it("centers under the RTL selection end, including nested direction and viewport clamps", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100);
    // happy-dom does not map dir attributes to computed direction.
    document.body.innerHTML =
      '<p dir="ltr"><span id="rtl" style="direction:rtl">שלום עולם</span></p>';
    const text = textOf("rtl");
    await start("select");
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, left: 200, right: 300 },
    ] as unknown as DOMRectList);
    select(text, 0, text, 4);
    expect(button()?.style.left).toBe("150px");
    expect(button()?.style.top).toBe("126px");
    expect(getSelection()?.toString()).toBe("שלום");

    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, left: 10, right: 110 },
    ] as unknown as DOMRectList);
    select(text, 0, text, 3);
    expect(button()?.style.left).toBe("4px");

    const vw = document.documentElement.clientWidth || innerWidth;
    vi.mocked(Range.prototype.getClientRects).mockReturnValue([
      { ...rect, left: vw + 50, right: vw + 150 },
    ] as unknown as DOMRectList);
    select(text, 0, text, 4);
    expect(button()?.style.left).toBe(`${vw - 100 - 4}px`);
  });

  it("does not show for an empty selection or when off", async () => {
    await start("select");
    select(textOf("a"), 3, textOf("a"), 4); // one space
    expect(button()).toBeNull();
    await send({ type: "comments.mode", mode: "off" });
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
  });

  it("a triple-click (end at the start of the next block) quotes only the first block", async () => {
    await start("select");
    select(textOf("a"), 0, textOf("b"), 0);
    button()?.click();
    await flush();
    expect(last("comment.select")).toMatchObject({
      anchor: { exact: "The quick brown fox jumps over the lazy dog." },
    });
  });

  it("stays hidden until the shell sends a mode", async () => {
    await start();
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
  });
});

describe("view mode (#1491)", () => {
  it("paints and reports, but shows no Comment button and sends no select", async () => {
    await start("view");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick brown") }],
    });
    expect(last("comment.positions")).toMatchObject({
      positions: [{ id: "ex", state: "exact", top: 100 }],
    });
    expect(
      highlights.get("oa-comment")?.ranges.map((r) => r.toString()),
    ).toEqual(["quick brown"]);
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).toBeNull();
    expect(last("comment.select")).toBeUndefined();
  });

  it("select to view hides a showing Comment button, and view to select shows it for a present selection", async () => {
    await start("select");
    select(textOf("a"), 4, textOf("a"), 9);
    expect(button()).not.toBeNull();
    await send({ type: "comments.mode", mode: "view" });
    expect(button()).toBeNull();
    expect(last("comment.select")).toBeUndefined();
    await send({ type: "comments.mode", mode: "select" });
    expect(button()?.textContent).toBe("Comment");
  });

  it("opens a thread from a click on its highlight, and sends no pin", async () => {
    await start("view");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick brown") }],
    });
    textOf("a").parentElement?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: 40,
        clientY: 110,
      }),
    );
    await flush();
    expect(last("comment.open")).toMatchObject({ id: "ex" });
    expect(last("comment.pin")).toBeUndefined();
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

  it("a click on a link inside a shadow root is the page's too (#1473)", async () => {
    document.body.innerHTML = "<p id=a>The quick brown fox jumps.</p>";
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const link = document.createElement("a");
    link.href = "#x";
    link.textContent = "quick";
    root.append(link);
    document.body.append(host);
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick") }],
    });
    // `target` is the host; `composedPath()[0]` is the link inside it.
    link.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 30,
        clientY: 110,
      }),
    );
    await flush();
    expect(last("comment.open")).toBeUndefined();
  });

  it("a click on a link inside a highlight is the page's, not the thread's (#1473)", async () => {
    document.body.innerHTML =
      '<p id=a>The <a id=lnk href="#x">quick</a> brown fox jumps.</p>';
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick") }],
    });
    // Inside the painted rect: the link navigates, and the thread must not open
    // as well.
    document.getElementById("lnk")?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 110,
      }),
    );
    await flush();
    expect(last("comment.open")).toBeUndefined();
    // The same spot on plain text still opens it.
    textOf("a").parentElement?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 110 }),
    );
    await flush();
    expect(last("comment.open")).toMatchObject({ id: "ex" });
  });

  it("paints the quote being written about, and drops it when the draft closes (#1834)", async () => {
    await start("select");
    const quote = {
      kind: "text" as const,
      exact: "quick brown",
      prefix: "The ",
      suffix: " fox",
    };
    await send({ type: "comments.set", threads: [], draft: quote });
    const active = () =>
      highlights.get("oa-comment-active") as { ranges: Range[] };
    expect(active().ranges).toHaveLength(1);
    expect(active().ranges[0]?.toString()).toBe("quick brown");
    // Nothing posted: no thread highlight, so clicking it opens nothing.
    expect(highlights.get("oa-comment")).toMatchObject({ ranges: [] });
    // The composer closed without posting: gone.
    await send({ type: "comments.set", threads: [] });
    expect(active().ranges).toHaveLength(0);
    // And it re-resolves after the page changes under it.
    await send({ type: "comments.set", threads: [], draft: quote });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    textOf("a").data = `Intro. ${textOf("a").data}`;
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    frames();
    await flush();
    vi.useRealTimers();
    expect(active().ranges[0]?.toString()).toBe("quick brown");
  });

  it("forgets the draft quote when comments go off (#1850)", async () => {
    await start("select");
    await send({
      type: "comments.set",
      threads: [],
      draft: {
        kind: "text",
        exact: "quick brown",
        prefix: "The ",
        suffix: " fox",
      },
    });
    const active = () =>
      highlights.get("oa-comment-active") as { ranges: Range[] };
    expect(active().ranges).toHaveLength(1);
    await send({ type: "comments.mode", mode: "off" });
    await send({ type: "comments.mode", mode: "select" });
    // A later set carries no draft: nothing painted from the old one.
    await send({ type: "comments.set", threads: [] });
    expect(active().ranges).toHaveLength(0);
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

describe("an already aborted signal (#1473)", () => {
  it("never attaches, so no overlay host and no messages", async () => {
    ctl.abort();
    createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
    await flush();
    await send({ type: "comments.mode", mode: "select" });
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick") }],
    });
    expect(msgs()).toEqual([]);
    expect(document.documentElement.querySelector(":scope > div")).toBeNull();
  });
});

describe("mode and clamping", () => {
  it("paints nothing before a mode arrives, and off clears everything", async () => {
    await start();
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
    expect(highlights.get("oa-comment")).toBeUndefined();
    expect(roots.at(-1)?.querySelector(".mark")).toBeFalsy();
    expect(msgs()).toEqual([]);
    await send({ type: "comments.mode", mode: "select" });
    expect(highlights.get("oa-comment")?.ranges).toHaveLength(1);
    expect(roots.at(-1)?.querySelector(".mark")).toBeTruthy();
    parent.postMessage.mockClear();
    await send({ type: "comments.mode", mode: "off" });
    expect(highlights.has("oa-comment")).toBe(false);
    expect(roots.at(-1)?.querySelector(".mark")).toBeFalsy();
    window.dispatchEvent(new Event("resize"));
    frames();
    await flush();
    expect(msgs()).toEqual([]);
  });

  it("clamps a negative top to 0 so the message still validates", async () => {
    rect.top = -40;
    await start("select");
    await send({
      type: "comments.set",
      threads: [{ id: "ex", anchor: anchorOf("quick") }],
    });
    const m = last("comment.positions");
    expect(m).toMatchObject({ positions: [{ id: "ex", top: 0 }] });
    expect(parseArtifactMessage(m)).not.toBeNull();
  });
});

describe("the body can change under the frame (N3)", () => {
  const settle = async () => {
    await flush();
    await vi.advanceTimersByTimeAsync(1200);
    await flush();
  };
  const newBody = (html: string) => {
    const b = document.createElement("body");
    b.innerHTML = html;
    return b;
  };

  it("a replaced body is re-resolved and selections work in the new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await start("select");
    await send({
      type: "comments.set",
      threads: [
        {
          id: "ex",
          anchor: anchorOf("quick brown", "The ", " fox jumps over"),
        },
      ],
    });
    expect(last("comment.positions")).toMatchObject({
      positions: [{ state: "exact" }],
    });
    document.documentElement.replaceChild(
      newBody("<p id=n>Entirely new words in a new body.</p>"),
      document.body,
    );
    await settle();
    expect(last("comment.positions")).toMatchObject({
      positions: [{ id: "ex", state: "orphan" }],
    });
    const t = document.getElementById("n")?.firstChild as Text;
    select(t, 9, t, 14);
    expect(button()).not.toBeNull();
    vi.useRealTimers();
  });

  it("comments start when the body arrives after the runtime", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    document.documentElement.removeChild(document.body);
    expect(document.body).toBeNull();
    await start("select");
    await send({
      type: "comments.set",
      threads: [
        {
          id: "ex",
          anchor: anchorOf("quick brown", "The ", " fox jumps over"),
        },
      ],
    });
    expect(msgs()).toEqual([]);
    document.documentElement.append(newBody(PAGE));
    await settle();
    expect(last("comment.positions")).toMatchObject({
      positions: [{ id: "ex", state: "exact" }],
    });
    vi.useRealTimers();
  });

  it("the overlay's own changes do not trigger a re-resolve", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await start("select");
    await send({
      type: "comments.set",
      threads: [
        {
          id: "ex",
          anchor: anchorOf("quick brown", "The ", " fox jumps over"),
        },
      ],
    });
    const n = () => msgs().filter((m) => m.type === "comment.positions").length;
    const before = n();
    select(textOf("a"), 4, textOf("a"), 9); // shows the button inside the overlay
    await settle();
    expect(n()).toBe(before);
    vi.useRealTimers();
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

  it("Esc in pin mode tells the shell, with no data; in other modes it does not", async () => {
    await start("pin");
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(last("comment.escape")).toMatchObject({
      oa: 1,
      type: "comment.escape",
    });
    await send({ type: "comments.mode", mode: "select" });
    const before = msgs().filter((m) => m.type === "comment.escape").length;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(msgs().filter((m) => m.type === "comment.escape")).toHaveLength(
      before,
    );
  });

  it("leaves Esc to the page when an IME, a field or a modal owns it (#1698)", async () => {
    await start("pin");
    const count = () =>
      msgs().filter((m) => m.type === "comment.escape").length;
    const before = count();
    // A composing key.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        isComposing: true,
      }),
    );
    // A text field.
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    // A plain element inside an open modal dialog.
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    modal.append(inside);
    document.body.append(modal);
    inside.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(count()).toBe(before);
    // Outside all three, pin mode's Esc still reaches the shell.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();
    expect(count()).toBe(before + 1);
    field.remove();
    modal.remove();
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

  it("marks a pin whose page changed, so the marker itself says what the card says (#1657)", async () => {
    await start("select");
    const pin = (changed: boolean) => ({
      id: "p1",
      n: 1,
      ...(changed ? { changed: true } : {}),
      anchor: {
        kind: "pin" as const,
        version: 1,
        x: 0.5,
        y: 0.25,
        contentHash: "h",
      },
    });
    await send({ type: "comments.set", threads: [pin(false)] });
    const plain = roots.at(-1)?.querySelector<HTMLElement>(".pin");
    expect(plain?.className).toBe("pin");
    expect(plain?.title).toBe("");
    await send({ type: "comments.set", threads: [pin(true)] });
    const marked = roots.at(-1)?.querySelector<HTMLElement>(".pin.changed");
    expect(marked).not.toBeNull();
    expect(marked?.title).toBe("Changed since this was placed.");
    // It is still the same pin: numbered, and a click still opens it.
    expect(marked?.textContent).toBe("1");
    marked?.click();
    await flush();
    expect(last("comment.open")).toMatchObject({ id: "p1" });
  });

  it("draws a dimmed, unnumbered ghost pin for the one being composed, and clears it", async () => {
    await start("select");
    await send({
      type: "comments.set",
      threads: [],
      ghost: { x: 0.5, y: 0.25 },
    });
    const g = roots.at(-1)?.querySelector<HTMLElement>(".pin.ghost");
    expect(g).not.toBeNull();
    expect(g?.textContent).toBe("");
    expect(g?.style.left).toBe("120px");
    expect(g?.style.top).toBe("35px");
    await send({ type: "comments.set", threads: [] });
    expect(roots.at(-1)?.querySelector(".pin")).toBeNull();
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
        {
          id: "ex",
          anchor: anchorOf("quick brown", "The ", " fox jumps over"),
        },
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
    // Nothing in the page changed: the highlight rules live in an adopted
    // sheet, and a page's CSP (style-src 'self') would block an inline style.
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
      threads: [
        {
          id: "ex",
          anchor: anchorOf("quick brown", "The ", " fox jumps over"),
        },
      ],
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
      "comment.escape": ["oa", "type"],
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

describe("a selection spanning several elements (#1708)", () => {
  const cases: {
    name: string;
    html: string;
    from: [string, number];
    to: [string, number];
    exact: string;
    first: string;
    last: string;
  }[] = [
    {
      name: "two list items",
      html: "<ul><li id=x>First item</li><li id=y>Second item</li></ul>",
      from: ["x", 6],
      to: ["y", 6],
      exact: "item Second",
      first: "item",
      last: "Second",
    },
    {
      name: "two paragraphs",
      html: "<p id=x>Alpha beta</p><p id=y>Gamma delta</p>",
      from: ["x", 6],
      to: ["y", 5],
      exact: "beta Gamma",
      first: "beta",
      last: "Gamma",
    },
    {
      name: "two table cells",
      html: "<table><tr><td id=x>Left cell</td><td id=y>Right cell</td></tr></table>",
      from: ["x", 5],
      to: ["y", 5],
      exact: "cell Right",
      first: "cell",
      last: "Right",
    },
    {
      name: "a span inside one item that ends in the next item",
      html: "<ul><li><span id=x>First <b>item</b></span></li><li id=y>Second item</li></ul>",
      from: ["x", 3],
      to: ["y", 6],
      exact: "st item Second",
      first: "st ",
      last: "Second",
    },
    {
      name: "two ordered list items (#1721)",
      html: "<ol><li id=x>First step</li><li id=y>Second step</li></ol>",
      from: ["x", 6],
      to: ["y", 6],
      exact: "step Second",
      first: "step",
      last: "Second",
    },
    {
      name: "out of a nested list into the next outer item (#1721)",
      html: "<ul><li>Parent<ul><li id=x>Child one</li><li id=y>Child two</li></ul></li><li id=z>Next item</li></ul>",
      from: ["y", 6],
      to: ["z", 4],
      exact: "two Next",
      first: "two",
      last: "Next",
    },
  ];
  for (const c of cases) {
    it(`shows the button, saves one anchor and re-highlights both sides: ${c.name}`, async () => {
      document.body.innerHTML = c.html;
      const text = (id: string) => {
        const el = document.getElementById(id) as Element;
        const w = document.createTreeWalker(el, 4);
        return w.nextNode() as Text;
      };
      await start("select");
      select(text(c.from[0]), c.from[1], text(c.to[0]), c.to[1]);
      expect(button()).not.toBeNull();
      button()?.click();
      await flush();
      const m = last("comment.select") as unknown as {
        anchor: { exact: string; prefix: string; suffix: string };
      };
      expect(m.anchor.exact).toBe(c.exact);

      // A fresh frame state: the anchor resolves exactly and paints the whole range.
      await send({
        type: "comments.set",
        threads: [
          { id: "t1", anchor: { ...m.anchor, kind: "text", version: 1 } },
        ],
      });
      expect(last("comment.positions")).toMatchObject({
        positions: [{ id: "t1", state: "exact" }],
      });
      const ranges = highlights.get("oa-comment")?.ranges ?? [];
      expect(ranges).toHaveLength(1);
      const r = ranges[0];
      expect(r.startContainer).toBe(text(c.from[0]));
      expect(r.endContainer).toBe(text(c.to[0]));
      expect(r.toString().startsWith(c.first)).toBe(true);
      expect(r.toString().endsWith(c.last)).toBe(true);
    });
  }
});

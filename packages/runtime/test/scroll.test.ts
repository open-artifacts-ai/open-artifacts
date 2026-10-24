// The runtime reports the document's scroll position (throttled) and, asked by
// the shell after a live swap, restores it: the same offset when the page is
// as tall, else the same fraction, waiting for late layout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import * as schemas from "../src/schemas.js";

const N = "AbCdEfGhIjKlMnOpQrSt_-";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;
const scrolls = () =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as { type: string; top?: number; max?: number })
    .filter((m) => m.type === "scroll");
const fromShell = (data: unknown) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source: parent as unknown as Window }),
  );
/** A page `height` tall in an 800px window, scrolled to `y`. */
const page = (height: number, y = 0) => {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value: height,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
};
let scrolledTo: number[] = [];

beforeEach(async () => {
  vi.useFakeTimers();
  delete (window as unknown as Record<string, unknown>).__oaShellNonce;
  history.replaceState(null, "", `/p#oa=${N}`);
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
  scrolledTo = [];
  vi.spyOn(window, "scrollTo").mockImplementation(((
    _x: number | ScrollToOptions,
    y?: number,
  ) => {
    const top = typeof _x === "object" ? (_x.top ?? 0) : (y ?? 0);
    scrolledTo.push(Math.round(top));
    Object.defineProperty(window, "scrollY", {
      value: top,
      configurable: true,
    });
  }) as typeof window.scrollTo);
  page(2800);
  createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
  await flush();
});
afterEach(() => {
  ctl.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

describe("scroll position", () => {
  it("reports scrolling, throttled, with the nonce", async () => {
    page(2800, 300);
    window.dispatchEvent(new Event("scroll"));
    page(2800, 600);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(300);
    expect(scrolls()).toEqual([
      { oa: 1, type: "scroll", top: 600, max: 2000, nonce: N },
    ]);
  });

  it("restores the same offset when the page is as tall", async () => {
    fromShell({ oa: 1, type: "scroll.to", top: 600, max: 2000 });
    await flush();
    expect(scrolledTo.at(-1)).toBe(600);
  });

  it("keeps the same offset when it still fits, even if the page grew", async () => {
    page(4800); // max 4000: a longer version, or a narrower frame
    fromShell({ oa: 1, type: "scroll.to", top: 500, max: 2000 });
    await flush();
    expect(scrolledTo.at(-1)).toBe(500);
  });

  it("falls back to the same fraction when the offset no longer fits", async () => {
    page(1200); // max 400 < 600, and it stays short
    fromShell({ oa: 1, type: "scroll.to", top: 600, max: 2000 });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(scrolledTo.at(-1)).toBe(120);
  });

  it("reports its position after restoring, even without a scroll event", async () => {
    vi.mocked(window.scrollTo).mockImplementation(() => {}); // no scroll event
    Object.defineProperty(window, "scrollY", {
      value: 600,
      configurable: true,
    });
    fromShell({ oa: 1, type: "scroll.to", top: 600, max: 2000 });
    await vi.advanceTimersByTimeAsync(300);
    expect(scrolls().at(-1)).toMatchObject({ top: 600, max: 2000 });
  });

  it("reports again when the frame is resized (the max changes)", async () => {
    page(2800, 600);
    window.dispatchEvent(new Event("scroll"));
    await vi.advanceTimersByTimeAsync(300);
    page(3800, 600); // narrower: the page reflows taller
    window.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(300);
    expect(scrolls().at(-1)).toMatchObject({ top: 600, max: 3000 });
  });

  it("waits for late layout (rendered pages grow after hello), up to 3 s", async () => {
    page(800); // not laid out yet: nothing to scroll
    fromShell({ oa: 1, type: "scroll.to", top: 600, max: 2000 });
    await flush();
    page(2800);
    await vi.advanceTimersByTimeAsync(200);
    expect(scrolledTo.at(-1)).toBe(600);
    const n = scrolledTo.length;
    page(5000);
    await vi.advanceTimersByTimeAsync(4000);
    // Done once it got there: later growth isn't chased.
    expect(scrolledTo.length).toBe(n);
  });
});

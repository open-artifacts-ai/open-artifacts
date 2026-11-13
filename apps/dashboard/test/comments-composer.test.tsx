// #2234: the composer is an outlined field that grows with its text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIELD_MAX,
  focusField,
  growField,
} from "../src/viewer/comments/CommentsBody";

function box(scrollHeight: number) {
  const el = document.createElement("textarea");
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  return el;
}

describe("composer growth (#2234)", () => {
  // The script fallback runs where `field-sizing: content` is missing.
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("height follows the text", () => {
    const a = box(42);
    const b = box(120);
    growField(a);
    growField(b);
    expect(Number.parseInt(a.style.height)).toBe(42);
    expect(Number.parseInt(b.style.height)).toBe(120);
  });
  it("caps at the max, then scrolls inside", () => {
    const el = box(900);
    growField(el);
    expect(el.style.height).toBe(`${FIELD_MAX}px`);
  });
});

it("#2234: phones get a 16px field so iOS does not zoom on focus", async () => {
  const { FIELD } = await import("../src/viewer/comments/CommentsBody");
  expect(FIELD).toContain("max-[599px]:text-[16px]");
  expect(FIELD).toContain("[@media(pointer:coarse)]:text-[16px]");
});

describe("composer scroll and measure (#2234)", () => {
  beforeEach(() => {
    vi.stubGlobal("CSS", { supports: () => false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("counts the border so the text is not 2px short", () => {
    const el = box(100);
    Object.defineProperty(el, "offsetHeight", { value: 102 });
    Object.defineProperty(el, "clientHeight", { value: 100 });
    growField(el);
    expect(el.style.height).toBe("102px");
  });

  it("puts the scroller's scrollTop back after measuring", () => {
    const sc = document.createElement("div");
    sc.style.overflowY = "auto";
    const el = box(60);
    sc.append(el);
    document.body.append(sc);
    sc.scrollTop = 80;
    // Measuring shortens the list: the browser clamps the scroller.
    const set = vi.spyOn(el.style, "height", "set").mockImplementation((v) => {
      if (v === "auto") sc.scrollTop = 10;
    });
    growField(el);
    expect(sc.scrollTop).toBe(80);
    set.mockRestore();
    sc.remove();
  });

  it("focus brings a field hidden under the header into the panel, never scrolling the document", () => {
    const sc = document.createElement("div");
    sc.style.overflowY = "auto";
    sc.innerHTML = "<div data-comments-header></div>";
    const head = sc.firstElementChild as HTMLElement;
    Object.defineProperty(head, "offsetHeight", { value: 50 });
    const el = document.createElement("textarea");
    sc.append(el);
    document.body.append(sc);
    sc.scrollTop = 200;
    sc.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
    el.getBoundingClientRect = () => ({ top: 10, bottom: 60 }) as DOMRect;
    const scrollIntoView = vi.fn();
    el.scrollIntoView = scrollIntoView;
    const focus = vi.spyOn(el, "focus");
    focusField(el);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(sc.scrollTop).toBe(160); // 200 - (50 - 10)
    expect(scrollIntoView).not.toHaveBeenCalled();
    sc.remove();
  });
});

// #2239: the keyboard and the action row, as helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusField, growField } from "../src/viewer/comments/CommentsBody";
import {
  fieldCap,
  keyboardInset,
  onViewport,
  trackViewportVar,
  viewBottom,
  viewHeight,
} from "../src/viewer/comments/viewport";

const vv = (height: number, offsetTop = 0) => {
  const t = new EventTarget() as EventTarget & Record<string, number>;
  t.height = height;
  t.offsetTop = offsetTop;
  vi.stubGlobal("visualViewport", t);
  Object.defineProperty(window, "visualViewport", {
    value: t,
    configurable: true,
  });
  return t;
};

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "visualViewport", {
    value: undefined,
    configurable: true,
  });
});

describe("viewport helpers (#2239)", () => {
  it("fall back to the window without a visual viewport", () => {
    expect(viewHeight()).toBe(window.innerHeight);
    expect(viewBottom()).toBe(window.innerHeight);
    expect(keyboardInset()).toBe(0);
    expect(onViewport(() => {})).toBeTypeOf("function");
  });
  it("a shrunk visual viewport is the keyboard", () => {
    vv(window.innerHeight - 300);
    expect(viewHeight()).toBe(window.innerHeight - 300);
    expect(keyboardInset()).toBe(300);
  });
  it("panning with the keyboard open (offsetTop 300) is still a keyboard", () => {
    vv(window.innerHeight - 300, 300);
    expect(keyboardInset()).toBe(300);
  });
  it("pinch zoom (scale 2, no keyboard) is not a keyboard and keeps the full height", () => {
    const t = vv(window.innerHeight / 2);
    t.scale = 2;
    expect(keyboardInset()).toBe(0);
    expect(viewHeight()).toBe(window.innerHeight);
    expect(fieldCap(1e6)).toBe(window.innerHeight * 0.4);
  });
  it("browser chrome is not a keyboard", () => {
    vv(window.innerHeight - 60);
    expect(keyboardInset()).toBe(0);
  });
  it("the cap is 40% of the visible height", () => {
    vv(500);
    expect(fieldCap(240)).toBe(200);
    expect(fieldCap(144)).toBe(144);
  });
  it("growField caps under the keyboard", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    vv(300);
    const el = document.createElement("textarea");
    Object.defineProperty(el, "scrollHeight", { value: 900 });
    growField(el);
    expect(el.style.height).toBe("120px");
  });
  it("publishes --oa-vvh and follows resizes, then cleans up", () => {
    const t = vv(800);
    const off = trackViewportVar();
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--oa-vvh")).toBe("8px");
    t.height = 400;
    t.dispatchEvent(new Event("resize"));
    expect(root.getPropertyValue("--oa-vvh")).toBe("4px");
    off();
    expect(root.getPropertyValue("--oa-vvh")).toBe("");
  });
});

describe("focusField re-measures after layout (#2239)", () => {
  it("clears the action row once its height is known, and again when the keyboard shrinks the view", () => {
    vi.useFakeTimers();
    const cbs: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          cbs.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    const t = vv(window.innerHeight);
    const sc = document.createElement("div");
    sc.style.overflowY = "auto";
    sc.innerHTML = "<div data-oa-action-outlet></div><textarea></textarea>";
    const outlet = sc.firstElementChild as HTMLElement;
    const el = sc.lastElementChild as HTMLTextAreaElement;
    let rowH = 0; // 0 at focus time: the sheet has not claimed the outlet yet
    Object.defineProperty(outlet, "offsetHeight", { get: () => rowH });
    sc.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
    el.getBoundingClientRect = () => ({ top: 330, bottom: 380 }) as DOMRect;
    document.body.append(sc);
    sc.scrollTop = 0;
    focusField(el);
    expect(sc.scrollTop).toBe(0); // nothing covers it yet
    rowH = 60; // layout settles: the row now covers 340..400
    for (const cb of cbs) cb();
    expect(sc.scrollTop).toBe(40); // field bottom 380 -> 340
    // The keyboard leaves 300px: the field must end above that too.
    sc.scrollTop = 0;
    rowH = 0;
    t.height = 300;
    t.dispatchEvent(new Event("resize"));
    expect(sc.scrollTop).toBe(80); // field bottom 380 -> 300
    vi.advanceTimersByTime(1100);
    t.dispatchEvent(new Event("resize"));
    sc.scrollTop = 0;
    t.dispatchEvent(new Event("resize"));
    expect(sc.scrollTop).toBe(0); // the watch ended
    vi.useRealTimers();
    sc.remove();
  });
});

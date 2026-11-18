// #2276: the phone doc toolbar rides the keyboard and hides without one.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  phoneToolbarHidden,
  sheetLift,
  toolbarEdge,
  toolbarTop,
  trackViewportVar,
  useKeyboardOpen,
} from "../src/viewer/comments/viewport";

/** A device whose primary pointer is coarse (a phone) or fine (a mouse). */
const pointer = (coarse: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === "(pointer: coarse)" ? coarse : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));

const vv = (height: number, offsetTop = 0) => {
  const t = new EventTarget() as EventTarget & Record<string, number>;
  t.height = height;
  t.offsetTop = offsetTop;
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

describe("phone doc toolbar (#2276)", () => {
  it("is hidden with no keyboard, shown with one, on a touch screen", () => {
    pointer(true);
    vv(window.innerHeight);
    expect(phoneToolbarHidden(false)).toBe(true);
    expect(phoneToolbarHidden(true)).toBe(false);
  });
  it("is never hidden on a fine pointer, keyboard or not", () => {
    pointer(false);
    vv(window.innerHeight);
    expect(phoneToolbarHidden(false)).toBe(false);
    expect(phoneToolbarHidden(true)).toBe(false);
  });
  it("is shown where matchMedia is missing", () => {
    vv(window.innerHeight);
    expect(phoneToolbarHidden(false)).toBe(false);
  });
  it("stays shown (at bottom 0) when there is no visual viewport", () => {
    expect(phoneToolbarHidden(false)).toBe(false);
    expect(sheetLift()).toBe(0);
  });
  it("follows the keyboard opening and closing", () => {
    const t = vv(window.innerHeight);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(false);
    act(() => {
      t.height = window.innerHeight - 300;
      t.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);
    act(() => {
      t.height = window.innerHeight;
      t.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });
  it("lifts the bar to the visible bottom as the view pans and resizes", () => {
    vi.stubGlobal("innerHeight", 844);
    const t = vv(844);
    const stop = trackViewportVar();
    const kb = () => document.documentElement.style.getPropertyValue("--oa-kb");
    expect(kb()).toBe("0px");
    t.height = 500;
    t.dispatchEvent(new Event("resize"));
    expect(kb()).toBe("344px");
    t.offsetTop = 300;
    t.dispatchEvent(new Event("scroll"));
    expect(kb()).toBe("44px");
    stop();
  });

  it("publishes the visible area's top (--oa-vv-top), panned or not", () => {
    vi.stubGlobal("innerHeight", 844);
    const t = vv(844);
    const stop = trackViewportVar();
    const top = () =>
      document.documentElement.style.getPropertyValue("--oa-vv-top");
    const bottom = () =>
      document.documentElement.style.getPropertyValue("--oa-vv-bottom");
    expect(top()).toBe("0px");
    expect(bottom()).toBe("844px");
    t.height = 500;
    t.dispatchEvent(new Event("resize"));
    expect(top()).toBe("0px");
    expect(bottom()).toBe("500px");
    t.offsetTop = 300;
    t.dispatchEvent(new Event("scroll"));
    expect(top()).toBe("300px");
    // Independent of innerHeight: a collapsed Safari bar changes it.
    vi.stubGlobal("innerHeight", 900);
    t.dispatchEvent(new Event("scroll"));
    expect(bottom()).toBe("800px");
    stop();
    expect(top()).toBe("");
    expect(bottom()).toBe("");
  });
  it("places the bar on the chosen edge of the visible area", () => {
    vi.stubGlobal("innerHeight", 844);
    const t = vv(500);
    expect(toolbarEdge("top")).toEqual({ top: 0 });
    expect(toolbarEdge("bottom")).toEqual({ bottom: 344 });
    t.offsetTop = 300;
    expect(toolbarEdge("top")).toEqual({ top: 300 });
    expect(toolbarEdge("bottom")).toEqual({ bottom: 44 });
    // Panned past the layout viewport's bottom: never a negative lift.
    t.offsetTop = 400;
    expect(toolbarEdge("bottom")).toEqual({ bottom: 0 });
  });
  it("is shown when scrolled with the keyboard open, hidden when scrolled without", () => {
    pointer(true);
    vi.stubGlobal("innerHeight", 844);
    const t = vv(500, 300);
    const { result } = renderHook(() => useKeyboardOpen());
    expect(result.current).toBe(true);
    expect(phoneToolbarHidden(result.current)).toBe(false);
    act(() => {
      t.height = 844;
      t.offsetTop = 300;
      t.dispatchEvent(new Event("resize"));
    });
    expect(phoneToolbarHidden(result.current)).toBe(true);
  });

  it("top edge: under the header while it shows, at the visible top once it scrolls away", () => {
    expect(toolbarTop(157, 0)).toBe(157);
    // Panned part way: the header is still the lower edge.
    expect(toolbarTop(157, 100)).toBe(157);
    // Panned past the header: the visible top.
    expect(toolbarTop(157, 200)).toBe(200);
    // No header on screen: the visible top.
    expect(toolbarTop(0, 0)).toBe(0);
  });
  it("publishes --oa-bar-top from the header's bottom and the visible top", () => {
    vi.stubGlobal("innerHeight", 844);
    const t = vv(844);
    const header = document.createElement("div");
    header.className = "oa-vt";
    let bottom = 157;
    header.getBoundingClientRect = () => ({ bottom }) as DOMRect;
    document.body.append(header);
    const stop = trackViewportVar();
    const bar = () =>
      document.documentElement.style.getPropertyValue("--oa-bar-top");
    expect(bar()).toBe("157px");
    t.offsetTop = 300;
    t.dispatchEvent(new Event("scroll"));
    expect(bar()).toBe("300px");
    // The header moved (the page scrolled): follows on a window scroll.
    t.offsetTop = 0;
    bottom = 40;
    window.dispatchEvent(new Event("scroll"));
    expect(bar()).toBe("40px");
    stop();
    header.remove();
    expect(bar()).toBe("");
  });
});

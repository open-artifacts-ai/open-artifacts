// #2276: the phone doc toolbar rides the keyboard and hides without one.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  phoneToolbarHidden,
  sheetLift,
  trackViewportVar,
  useKeyboardOpen,
} from "../src/viewer/comments/viewport";

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
  it("is hidden with no keyboard, shown with one", () => {
    vv(window.innerHeight);
    expect(phoneToolbarHidden(false)).toBe(true);
    expect(phoneToolbarHidden(true)).toBe(false);
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
});

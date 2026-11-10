import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommentsResizer,
  clampWidth,
  DEFAULT_WIDTH,
  KEY,
  loadWidth,
  MIN_WIDTH,
  maxWidth,
  resetWidthStore,
  useCommentsWidth,
  useCommentsWidthVar,
} from "../src/viewer/commentsWidth";

const setWin = (w: number) => {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
};

function Probe() {
  const { width, enabled } = useCommentsWidth();
  return (
    <div data-testid="p" data-enabled={String(enabled)}>
      {width}
    </div>
  );
}
function Holder({ onRender }: { onRender: () => void }) {
  onRender();
  const ref = useRef<HTMLDivElement>(null);
  useCommentsWidthVar(ref);
  return <div ref={ref} data-testid="root" />;
}
const handle = () => screen.getByRole("separator");
const val = () => Number(handle().getAttribute("aria-valuenow"));

beforeEach(() => {
  localStorage.clear();
  resetWidthStore();
  setWin(1280);
});
afterEach(() => localStorage.clear());

describe("#1986 clamp math", () => {
  it("max is the smaller of 560 and window - 600, never below min", () => {
    expect(maxWidth(1280)).toBe(560);
    expect(maxWidth(960)).toBe(360);
    expect(maxWidth(1000)).toBe(400);
    expect(maxWidth(700)).toBe(MIN_WIDTH);
  });
  it("clamps to [min, max]", () => {
    expect(clampWidth(100, 1280)).toBe(300);
    expect(clampWidth(9999, 1280)).toBe(560);
    expect(clampWidth(450.4, 1280)).toBe(450);
    expect(clampWidth(500, 960)).toBe(360);
  });
  it("a bad or missing stored value is the default", () => {
    expect(loadWidth()).toBe(DEFAULT_WIDTH);
    for (const bad of ["abc", "", "NaN", "-5", "0", "Infinity"]) {
      localStorage.setItem(KEY, bad);
      expect(loadWidth()).toBe(DEFAULT_WIDTH);
    }
    localStorage.setItem(KEY, "420");
    expect(loadWidth()).toBe(420);
  });
});

describe("#1986 width var", () => {
  it("sets --oa-comments-w on the root and follows a drag without re-rendering it", () => {
    let renders = 0;
    render(
      <>
        <Holder onRender={() => renders++} />
        <CommentsResizer />
      </>,
    );
    const root = screen.getByTestId("root");
    expect(root.style.getPropertyValue("--oa-comments-w")).toBe("352px");
    const before = renders;
    const h = handle();
    h.setPointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 800 });
    expect(root.style.getPropertyValue("--oa-comments-w")).toBe("452px");
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 700 });
    expect(renders).toBe(before);
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 700 });
  });
});

describe("#1986 handle", () => {
  it("is a labelled vertical separator with value, min and max", () => {
    render(<CommentsResizer />);
    const h = handle();
    expect(h).toHaveAttribute("aria-orientation", "vertical");
    expect(h).toHaveAttribute("aria-label", "Resize comments");
    expect(h).toHaveAttribute("tabindex", "0");
    expect(val()).toBe(352);
    expect(h).toHaveAttribute("aria-valuemin", "300");
    expect(h).toHaveAttribute("aria-valuemax", "560");
  });
  it("arrows move 16, shift 64: left widens, right narrows; limits hold", () => {
    render(<CommentsResizer />);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(val()).toBe(368);
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(val()).toBe(336);
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(val()).toBe(400);
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(val()).toBe(336);
    for (let i = 0; i < 10; i++)
      fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(val()).toBe(300);
  });
  it("Home and End jump to the limits; Enter and double-click reset", () => {
    render(<CommentsResizer />);
    fireEvent.keyDown(handle(), { key: "End" });
    expect(val()).toBe(560);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(val()).toBe(300);
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(val()).toBe(352);
    fireEvent.keyDown(handle(), { key: "End" });
    fireEvent.doubleClick(handle());
    expect(val()).toBe(352);
  });
  it("persists to localStorage and restores", () => {
    const { unmount } = render(<CommentsResizer />);
    fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(localStorage.getItem(KEY)).toBe("416");
    unmount();
    resetWidthStore();
    render(<CommentsResizer />);
    expect(val()).toBe(416);
  });
  it("drag: pointer capture, left widens, one save on release", () => {
    render(<CommentsResizer />);
    const h = handle();
    h.setPointerCapture = () => {};
    h.releasePointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 850 });
    expect(val()).toBe(402);
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 0 });
    expect(val()).toBe(560);
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 0 });
    expect(localStorage.getItem(KEY)).toBe("560");
  });
  const bodyWith = () => {
    const body = document.createElement("div");
    document.body.append(body);
    return body;
  };
  it("unmounting mid-drag clears data-resizing and the draft", () => {
    const body = bodyWith();
    const { unmount } = render(<CommentsResizer />, {
      container: body,
    });
    const h = handle();
    h.setPointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 800 });
    expect(body.dataset.resizing).toBe("");
    unmount();
    expect(body.dataset.resizing).toBeUndefined();
    resetWidthStore();
    render(<CommentsResizer />);
    expect(val()).toBe(352);
    expect(localStorage.getItem(KEY)).toBeNull();
    body.remove();
  });
  it("the handle going away below 960px mid-drag clears the drag too", () => {
    const body = bodyWith();
    render(<CommentsResizer />, {
      container: body,
    });
    const h = handle();
    h.setPointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 800 });
    setWin(900);
    expect(body.dataset.resizing).toBeUndefined();
    setWin(1280);
    expect(val()).toBe(352);
    body.remove();
  });
  it("lost pointer capture ends the drag and saves the width", () => {
    const body = bodyWith();
    render(<CommentsResizer />, {
      container: body,
    });
    const h = handle();
    h.setPointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(h, { pointerId: 1, clientX: 800 });
    fireEvent.lostPointerCapture(h, { pointerId: 1 });
    expect(body.dataset.resizing).toBeUndefined();
    expect(localStorage.getItem(KEY)).toBe("452");
    body.remove();
  });
  it("a click with no movement stores nothing", () => {
    render(<CommentsResizer />);
    const h = handle();
    h.setPointerCapture = () => {};
    fireEvent.pointerDown(h, { pointerId: 1, clientX: 900 });
    fireEvent.pointerUp(h, { pointerId: 1, clientX: 900 });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
  it("clamps the stored width on load and on window resize without overwriting it", () => {
    localStorage.setItem(KEY, "550");
    resetWidthStore();
    render(<CommentsResizer />);
    expect(val()).toBe(550);
    setWin(1000);
    expect(val()).toBe(400);
    expect(localStorage.getItem(KEY)).toBe("550");
    setWin(1400);
    expect(val()).toBe(550);
  });
  it("a bad stored value gives the default", () => {
    localStorage.setItem(KEY, "wide");
    resetWidthStore();
    render(<CommentsResizer />);
    expect(val()).toBe(352);
  });
  it("is off below 960px: no handle, hook says disabled", () => {
    setWin(959);
    render(
      <>
        <CommentsResizer />
        <Probe />
      </>,
    );
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("p").dataset.enabled).toBe("false");
    setWin(960);
    expect(handle()).toBeInTheDocument();
    expect(val()).toBe(352);
    expect(handle()).toHaveAttribute("aria-valuemax", "360");
  });
});

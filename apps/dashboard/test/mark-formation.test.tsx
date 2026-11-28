import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkFormation } from "../src/pages/MarkFormation";

let reduced = false;
let hidden = false;
let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
let preferenceListeners: Set<() => void>;
let observers: { disconnect: ReturnType<typeof vi.fn> }[];
let requestFrame: ReturnType<typeof vi.fn>;
const fill = vi.fn();

beforeEach(() => {
  reduced = false;
  hidden = false;
  nextFrame = 0;
  frames = new Map();
  preferenceListeners = new Set();
  observers = [];
  fill.mockClear();
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 256,
    height: 256,
  } as DOMRect);
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media) =>
      ({
        get matches() {
          return reduced;
        },
        media,
        onchange: null,
        addEventListener: (_event: string, listener: () => void) => {
          preferenceListeners.add(listener);
        },
        removeEventListener: (_event: string, listener: () => void) => {
          preferenceListeners.delete(listener);
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal("Path2D", class {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor() {
        observers.push(this);
      }
    },
  );
  requestFrame = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  const noop = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: noop,
    save: noop,
    restore: noop,
    scale: noop,
    beginPath: noop,
    arc: noop,
    fill,
    translate: noop,
    rotate: noop,
    moveTo: noop,
    lineTo: noop,
    closePath: noop,
    clip: noop,
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function advanceFrame(time: number) {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(time);
  });
}

function visual(container: HTMLElement) {
  const svg = container.querySelector("svg");
  const canvas = container.querySelector("canvas");
  if (!svg || !canvas)
    throw new Error("Expected static and animated logo surfaces");
  return { svg, canvas };
}

it("keeps an immediate static logo, plays once, and does not replay when provider content changes", () => {
  const page = (provider: string) => (
    <>
      <MarkFormation />
      <p>{provider}</p>
    </>
  );
  const { container, rerender } = render(page("Checking sign-in methods"));
  const { svg, canvas } = visual(container);
  expect(canvas).toHaveAttribute("hidden");
  expect(svg.style.visibility).not.toBe("hidden");
  expect(screen.queryByRole("button")).toBeNull();
  advanceFrame(200);
  expect(canvas).not.toHaveAttribute("hidden");
  expect(svg.style.visibility).toBe("hidden");
  expect(fill).toHaveBeenCalled();
  const requests = requestFrame.mock.calls.length;
  rerender(page("Continue with Google"));
  expect(requestFrame).toHaveBeenCalledTimes(requests);
  advanceFrame(2200);
  expect(canvas).toHaveAttribute("hidden");
  expect(svg.style.visibility).toBe("visible");
  expect(frames.size).toBe(0);
  rerender(page("Sign-in didn't finish"));
  expect(requestFrame).toHaveBeenCalledTimes(requests);
});

it("shows the static logo with reduced motion, including when the preference changes mid-animation", () => {
  reduced = true;
  const first = render(<MarkFormation />);
  expect(visual(first.container).canvas).toHaveAttribute("hidden");
  expect(frames.size).toBe(0);
  first.unmount();
  reduced = false;
  const second = render(<MarkFormation />);
  advanceFrame(200);
  expect(visual(second.container).canvas).not.toHaveAttribute("hidden");
  act(() => {
    reduced = true;
    for (const listener of preferenceListeners) listener();
  });
  expect(visual(second.container).canvas).toHaveAttribute("hidden");
  expect(visual(second.container).svg.style.visibility).toBe("visible");
  expect(frames.size).toBe(0);
  act(() => {
    reduced = false;
    for (const listener of preferenceListeners) listener();
  });
  expect(frames.size).toBe(0);
});

it("completes when the tab is hidden and does not restart on return", () => {
  const { container } = render(<MarkFormation />);
  advanceFrame(200);
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(visual(container).canvas).toHaveAttribute("hidden");
  expect(visual(container).svg.style.visibility).toBe("visible");
  expect(frames.size).toBe(0);
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(frames.size).toBe(0);
});

it("retains a static fallback when canvas rendering is unavailable", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const { container } = render(<MarkFormation />);
  expect(visual(container).canvas).toHaveAttribute("hidden");
  expect(visual(container).svg.style.visibility).not.toBe("hidden");
  expect(frames.size).toBe(0);
});

it("leaves one animation under StrictMode and removes frames, observers and listeners on unmount", () => {
  const remove = vi.spyOn(document, "removeEventListener");
  const { unmount } = render(
    <StrictMode>
      <MarkFormation />
    </StrictMode>,
  );
  expect(frames.size).toBe(1);
  expect(preferenceListeners.size).toBe(1);
  expect(observers).toHaveLength(2);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  advanceFrame(200);
  unmount();
  expect(frames.size).toBe(0);
  expect(preferenceListeners.size).toBe(0);
  expect(observers[1].disconnect).toHaveBeenCalledOnce();
  expect(
    remove.mock.calls.filter(([type]) => type === "visibilitychange"),
  ).toHaveLength(2);
});

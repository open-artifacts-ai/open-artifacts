// #2503: the one-row title bar gives way a step at a time, never in a loop.
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAR_STAGES, useBarStage } from "../src/viewer/TitleBar";

/** What the row needs at each stage (px); the bar is `width` wide. */
let needs: number[] = [];
let width = 0;
let renders = 0;
let observe: (() => void) | null = null;

function Bar({
  content,
  active = true,
}: {
  content: string;
  active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stage = useBarStage(ref, active, content);
  renders++;
  return (
    <div ref={ref} data-stage={stage}>
      <div data-group="" />
    </div>
  );
}

/** The bar is `width` wide and needs `needs[stage]`; its groups never overflow. */
function mountBar(content = "a") {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.stage !== undefined ? width : 10;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      const at = this.dataset.stage;
      return at !== undefined ? Math.max(width, needs[Number(at)] ?? 0) : 10;
    },
  );
  const r = render(<Bar content={content} />);
  return { ...r, el: r.container.firstElementChild as HTMLElement };
}

beforeEach(() => {
  renders = 0;
  observe = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observe = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useBarStage (#2503)", () => {
  it("steps up one stage at a time until the row fits, then stops", () => {
    needs = [700, 660, 630, 600];
    width = 640;
    const { el } = mountBar();
    expect(el.dataset.stage).toBe("2");
    const n = renders;
    act(() => observe?.());
    // A re-check that still fits sets nothing more.
    expect(el.dataset.stage).toBe("2");
    expect(renders - n).toBeLessThanOrEqual(1);
  });

  it("stops at the last stage even if the row still overflows", () => {
    needs = [900, 900, 900, 900];
    width = 610;
    const { el } = mountBar();
    expect(el.dataset.stage).toBe(String(BAR_STAGES));
    expect(renders).toBeLessThan(12);
  });

  it("steps back only once the bar is as wide as the stage before needed", () => {
    needs = [700, 660, 630, 600];
    width = 610;
    const { el } = mountBar();
    expect(el.dataset.stage).toBe("3");
    width = 629; // still short of stage 2's 630
    act(() => observe?.());
    expect(el.dataset.stage).toBe("3");
    width = 665; // room for stage 2 and 1, not 0
    act(() => observe?.());
    expect(el.dataset.stage).toBe("1");
    width = 700;
    act(() => observe?.());
    expect(el.dataset.stage).toBe("0");
  });

  it("new content measures again from the start", () => {
    needs = [700, 660, 630, 600];
    width = 640;
    const { el, rerender } = mountBar("pill");
    expect(el.dataset.stage).toBe("2");
    needs = [620, 600, 600, 600]; // the pill went into the panel
    rerender(<Bar content="no pill" />);
    expect(el.dataset.stage).toBe("0");
  });

  it("is 0 outside the in-between widths", () => {
    needs = [900, 900, 900, 900];
    width = 610;
    const r = render(<Bar content="a" active={false} />);
    expect((r.container.firstElementChild as HTMLElement).dataset.stage).toBe(
      "0",
    );
  });
});

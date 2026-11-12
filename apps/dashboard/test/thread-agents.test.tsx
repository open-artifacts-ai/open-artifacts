import type { CommentThread, ThreadAgent } from "@oa/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadAgents } from "../src/viewer/comments/threadAgents";

// #2035: the reply box's "Notifying" chips.

const mutate = vi.fn();
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", RO);
vi.mock("../src/api/comments", () => ({
  useThreadAgent: () => ({ mutate, isPending: false }),
  useCommentErrorCtx: () => ({}),
  commentError: () => "nope",
}));

const agent = (name: string, canRemove: boolean): ThreadAgent => ({
  key: `k-${name}`,
  name,
  for: "Sam Rivera",
  canRemove,
});
const thread = (agents: ThreadAgent[]) =>
  ({ id: "t1", agents }) as unknown as CommentThread;
const api = { artifactId: "a1", guest: false, capped: false } as never;

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

describe("ThreadAgents", () => {
  it("shows nothing without agents", () => {
    const { container } = render(<ThreadAgents t={thread([])} api={api} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a removed agent is not a chip", () => {
    const gone = { ...agent("OA Billing", true), removed: true };
    const { container } = render(<ThreadAgents t={thread([gone])} api={api} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("× removes at once with no confirm; Undo restores and takes focus", () => {
    mutate.mockImplementation((_v, o) => o.onSuccess());
    render(<ThreadAgents t={thread([agent("OA Billing", true)])} api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: true,
    });
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    expect(mutate.mock.calls[1]?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: false,
    });
  });

  it("a view-only chip has no ×; a tap, hover or focus shows who can remove it", async () => {
    render(<ThreadAgents t={thread([agent("OA Billing", false)])} api={api} />);
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
    const chip = document.querySelector("[data-thread-agent]");
    if (!chip) throw new Error("no chip");
    expect(chip.getAttribute("title")).toBeNull();
    fireEvent.click(chip);
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe(
      "Only Sam Rivera, whose agent it is, or the artifact's owner can remove it.",
    );
    expect(chip.getAttribute("aria-describedby")).toBeTruthy();
    // A second tap closes it.
    fireEvent.click(chip);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("the × has a tooltip on focus", async () => {
    render(<ThreadAgents t={thread([agent("OA Billing", true)])} api={api} />);
    fireEvent.focus(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Stop notifying OA Billing in this thread");
  });

  describe("one line", () => {
    const widths = (el: HTMLElement) =>
      el.textContent === "Notifying"
        ? 60
        : /^\+\d+$/.test(el.textContent ?? "")
          ? 40
          : 100;
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
        function (this: HTMLElement) {
          return widths(this);
        },
      );
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        300,
      );
    });
    afterEach(() => vi.restoreAllMocks());

    it("shows as many chips as fit, then +N, without wrapping", () => {
      const four = ["A1", "A2", "A3", "A4"].map((n) => agent(n, true));
      render(<ThreadAgents t={thread(four)} api={api} />);
      const row = document.querySelector("[data-thread-agents] > div");
      expect(row?.className).toContain("flex-nowrap");
      expect(
        document.querySelectorAll(
          "div[data-thread-agents] [data-thread-agent]",
        ),
      ).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Show 3 more notified" })
          .textContent,
      ).toBe("+3");
    });

    it("a wider line shows more; all that fit means no +N", () => {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        900,
      );
      const four = ["A1", "A2", "A3", "A4"].map((n) => agent(n, true));
      render(<ThreadAgents t={thread(four)} api={api} />);
      expect(
        screen.queryByRole("button", { name: /more notified/ }),
      ).toBeNull();
    });

    it("+N expands in place, and wrapping is then allowed", () => {
      const four = ["A1", "A2", "A3", "A4"].map((n) => agent(n, true));
      render(<ThreadAgents t={thread(four)} api={api} />);
      fireEvent.click(
        screen.getByRole("button", { name: "Show 3 more notified" }),
      );
      expect(
        document.querySelector('[data-thread-agent="k-A4"]'),
      ).not.toBeNull();
      expect(
        document.querySelector("[data-thread-agents] > div")?.className,
      ).toContain("flex-wrap");
    });
  });

  it("Undo after a removal puts it back", () => {
    mutate.mockImplementation((_v, o) => o.onSuccess());
    render(<ThreadAgents t={thread([agent("OA Billing", true)])} api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    expect(
      screen.getByText(/OA Billing won't get replies in this thread\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ removed: false });
  });
});

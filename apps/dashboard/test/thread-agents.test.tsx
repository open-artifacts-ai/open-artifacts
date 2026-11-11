import type { CommentThread, ThreadAgent } from "@oa/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadAgents } from "../src/viewer/comments/threadAgents";

// #2035: the reply box's "Notifying" chips.

const mutate = vi.fn();
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

  it("× opens the confirm; Keep closes it; Remove sends the removal", () => {
    render(<ThreadAgents t={thread([agent("OA Billing", true)])} api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    expect(
      screen.getByText(
        "Remove OA Billing from this thread? It won't get replies here until someone @-mentions it.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: true,
    });
  });

  it("a view-only chip has no × and says who can remove it", () => {
    render(<ThreadAgents t={thread([agent("OA Billing", false)])} api={api} />);
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
    expect(
      screen
        .getByText("OA Billing")
        .closest("[data-thread-agent]")
        ?.getAttribute("title"),
    ).toBe(
      "Only Sam Rivera, whose agent it is, or the artifact's owner can remove it.",
    );
  });

  it("two chips, then +N that expands in place", () => {
    const four = ["A1", "A2", "A3", "A4"].map((n) => agent(n, true));
    render(<ThreadAgents t={thread(four)} api={api} />);
    expect(screen.queryByText("A3")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Show 2 more notified" }),
    );
    expect(screen.getByText("A4")).toBeTruthy();
  });

  it("Undo after a removal puts it back", () => {
    mutate.mockImplementation((_v, o) => o.onSuccess());
    render(<ThreadAgents t={thread([agent("OA Billing", true)])} api={api} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Stop notifying OA Billing" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      screen.getByText(/OA Billing won't get replies in this thread\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({ removed: false });
  });
});

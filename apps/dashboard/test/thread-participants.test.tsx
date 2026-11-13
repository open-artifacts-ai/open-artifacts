import type { CommentThread, ThreadAgent } from "@oa/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadParticipants } from "../src/viewer/comments/threadParticipants";

// #2174: who is in a thread, at its top.

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
  linked: false,
  canRemove,
});
const person = (name: string) => ({
  id: `u-${name}`,
  kind: "user" as const,
  name,
});
const thread = (agents: ThreadAgent[] | undefined) =>
  ({
    id: "t1",
    comments: [
      { id: "c1", author: person("Leo Urbina") },
      { id: "c2", author: person("Sam Rivera") },
      { id: "c3", author: person("Leo Urbina") },
    ],
    ...(agents ? { agents } : {}),
  }) as unknown as CommentThread;
const api = (guest = false, canComment = true) =>
  ({ artifactId: "a1", guest, capped: false, canComment }) as never;
const trigger = () =>
  document.querySelector("[data-participants-trigger]") as HTMLElement;
const count = () =>
  document.querySelector("[data-participants-count]")?.textContent;
const list = () => document.querySelector("[data-participants-list]");

afterEach(() => {
  cleanup();
  mutate.mockReset();
  vi.useRealTimers();
});

describe("ThreadParticipants", () => {
  it("is closed to start, with a count of people and agents", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    expect(list()).toBeNull();
    expect(count()).toBe("3");
    expect(trigger().getAttribute("aria-label")).toBe(
      "2 people and 1 agent in this thread",
    );
  });

  it("opens on mouse hover and closes when it leaves", () => {
    vi.useFakeTimers();
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    const box = document.querySelector("[data-thread-participants]") as Element;
    fireEvent.pointerEnter(box, { pointerType: "mouse" });
    expect(list()?.textContent).toContain("Leo Urbina");
    expect(list()?.textContent).toContain("OA Billing");
    expect(list()?.textContent).toContain("Gets replies");
    // A click while hovering keeps it open.
    fireEvent.pointerDown(trigger(), { pointerType: "mouse" });
    fireEvent.click(trigger());
    expect(list()).not.toBeNull();
    fireEvent.pointerLeave(box, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(list()).toBeNull();
  });

  it("a tap opens it and a second tap closes it", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
    fireEvent.pointerDown(trigger(), { pointerType: "touch" });
    fireEvent.click(trigger());
    expect(list()).not.toBeNull();
    fireEvent.pointerDown(trigger(), { pointerType: "touch" });
    fireEvent.click(trigger());
    expect(list()).toBeNull();
  });

  it("keyboard focus opens it; Escape closes it", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    fireEvent.focus(trigger());
    expect(list()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(list()).toBeNull();
  });

  it("× removes at once, no confirm; then the row reads Not notified with Undo", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    fireEvent.focus(trigger());
    const x = () =>
      screen.getByRole("button", {
        name: "Stop notifying OA Billing in this thread",
      });
    fireEvent.click(x());
    const call = mutate.mock.calls[0];
    expect(call?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: true,
    });
    expect(document.querySelector("[data-off]")?.textContent).toContain(
      "Not notified",
    );
    expect(list()?.textContent).toContain(
      "OA Billing won't get replies in this thread.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(mutate.mock.calls[1]?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: false,
    });
    expect(document.querySelector("[data-off]")).toBeNull();
  });

  it("a refused × puts the row back and shows the error (optimistic rollback)", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    fireEvent.focus(trigger());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop notifying OA Billing in this thread",
      }),
    );
    // At once, before any answer.
    expect(list()?.textContent).toContain(
      "OA Billing won't get replies in this thread.",
    );
    act(() => mutate.mock.calls[0]?.[1].onError(new Error("x")));
    expect(list()?.textContent).not.toContain("won't get replies");
    expect(document.querySelector("[data-off]")).toBeNull();
  });

  it("after Undo the list stays open and focus returns to the restored ×", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api()}
      />,
    );
    fireEvent.focus(trigger());
    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop notifying OA Billing in this thread",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(list()).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Stop notifying OA Billing in this thread",
      }),
    );
  });

  it("canRemove false shows no ×", () => {
    render(
      <ThreadParticipants t={thread([agent("OA Bus", false)])} api={api()} />,
    );
    fireEvent.focus(trigger());
    expect(list()?.textContent).toContain("OA Bus");
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
  });

  it("a view-only agent shows whose it is, with the reason on focus", async () => {
    render(
      <ThreadParticipants t={thread([agent("OA Bus", false)])} api={api()} />,
    );
    fireEvent.focus(trigger());
    const who = document.querySelector("[data-view-only]") as HTMLElement;
    expect(who.textContent).toBe("Sam's agent");
    fireEvent.focus(who);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Only Sam Rivera, whose agent it is, or the artifact's owner can remove it.",
    );
  });

  it("more than three shows +N", () => {
    const many = ["A", "B", "C"].map((n) => agent(n, true));
    render(<ThreadParticipants t={thread(many)} api={api()} />);
    expect(count()).toBe("+2");
  });

  it("a removed agent from the server reads Not notified, struck through, with Add back for who may", () => {
    const gone = { ...agent("OA Billing", true), removed: true };
    const other = { ...agent("OA Bus", false), removed: true };
    render(<ThreadParticipants t={thread([gone, other])} api={api()} />);
    fireEvent.focus(trigger());
    const rows = document.querySelectorAll("[data-off]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Not notified");
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Notify OA Billing in this thread again",
      }),
    );
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: false,
    });
    // Another person's removed agent offers no Add back.
    expect(screen.getAllByRole("button", { name: /again/ })).toHaveLength(1);
  });

  it("a member who cannot reply sees the agents but no × and no Add back", () => {
    const gone = { ...agent("OA Product", true), removed: true };
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true), gone])}
        api={api(false, false)}
      />,
    );
    fireEvent.focus(trigger());
    expect(list()?.textContent).toContain("OA Billing");
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /again/ })).toBeNull();
  });

  it("a guest sees people only, no agents", () => {
    render(
      <ThreadParticipants
        t={thread([agent("OA Billing", true)])}
        api={api(true)}
      />,
    );
    expect(count()).toBe("2");
    expect(trigger().getAttribute("aria-label")).toBe(
      "2 people in this thread",
    );
    fireEvent.focus(trigger());
    expect(list()?.textContent).not.toContain("OA Billing");
    expect(list()?.textContent).not.toContain("Agents");
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
  });

  it("a logged-in caller with no agent list sees people only", () => {
    render(<ThreadParticipants t={thread(undefined)} api={api()} />);
    expect(count()).toBe("2");
  });
});

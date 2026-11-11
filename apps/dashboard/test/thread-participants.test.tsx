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
const api = (guest = false) =>
  ({ artifactId: "a1", guest, capped: false }) as never;
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

  it("× asks first; Keep sends nothing; Remove sends, then the row reads Not notified with Undo", () => {
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
    expect(
      screen.getByText(
        "Remove OA Billing from this thread? It won't get replies here until someone @-mentions it.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(x());
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const call = mutate.mock.calls[0];
    expect(call?.[0]).toEqual({
      thread: "t1",
      key: "k-OA Billing",
      removed: true,
    });
    act(() => call?.[1].onSuccess());
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
    act(() => mutate.mock.calls[1]?.[1].onSuccess());
    expect(document.querySelector("[data-off]")).toBeNull();
  });

  it("canRemove false shows no ×", () => {
    render(
      <ThreadParticipants t={thread([agent("OA Bus", false)])} api={api()} />,
    );
    fireEvent.focus(trigger());
    expect(list()?.textContent).toContain("OA Bus");
    expect(screen.queryByRole("button", { name: /Stop notifying/ })).toBeNull();
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

  it("a signed-in caller with no agent list sees people only", () => {
    render(<ThreadParticipants t={thread(undefined)} api={api()} />);
    expect(count()).toBe("2");
  });
});

// #2512: the bell (Me.inbox) and "For you" (R.meInbox), on the mocks.
import { type Inbox, type InboxItem, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { focusManager } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  calls,
  events,
  findVisibleToast,
  installHarness,
  mount,
  server,
} from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const bell = () =>
  screen.findByRole("button", { name: /^For you/ }, { timeout: FIRST_LOAD_MS });

const forYou = (variant: "mixed" | "calm" | "empty" | "back") =>
  server.use(...createHandlers({ events, forYou: variant }));

const openPanel = async () => {
  fireEvent.click(await bell());
  const panel = await screen.findByRole("dialog", { name: "For you" });
  await within(panel).findByRole("region", { name: "Needs you" });
  return panel;
};

describe("the bell", () => {
  it("is absent when Me has no inbox, and asks for nothing", async () => {
    const gets = calls("GET");
    mount("/");
    await screen.findByRole(
      "button",
      { name: "Account menu" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(screen.queryByRole("button", { name: /^For you/ })).toBeNull();
    expect(gets.some((c) => c.path.startsWith(R.meInbox))).toBe(false);
  });

  it("counts only what needs you, from Me.inbox, before the list loads", async () => {
    const gets = calls("GET");
    forYou("mixed");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, 2 need you");
    expect(b.querySelector("[data-bell-count]")).toHaveTextContent("2");
    expect(b.querySelector("[data-bell-dot]")).toBeNull();
    expect(gets.some((c) => c.path === R.meInbox)).toBe(false);
  });

  it("shows a dot, not a number, when only updates are new", async () => {
    forYou("calm");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, new updates");
    expect(b.querySelector("[data-bell-count]")).toBeNull();
    expect(b.querySelector("[data-bell-dot]")).not.toBeNull();
  });

  it("has no number and no dot with nothing at all", async () => {
    forYou("empty");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you");
    expect(b.querySelector("[data-bell-count], [data-bell-dot]")).toBeNull();
  });

  it("is in the viewer's title bar too", async () => {
    forYou("mixed");
    mount("/a/Cd5fGhJkLm6nPqRs");
    expect(await bell()).toHaveAccessibleName("For you, 2 need you");
  });
});

describe("For you", () => {
  it("keeps the server's order and splits Needs you from Updates", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const needs = within(panel).getByRole("region", { name: "Needs you" });
    const rows = within(needs).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-for-you-item"))).toEqual([
      "ask:fyAskComment1",
      "itm:machine1",
    ]);
    expect(rows[0]).toHaveTextContent("waiting 4 min");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "Review" }),
    ).toHaveAttribute("href", "/agents");
    const ups = within(panel).getByRole("region", { name: "Updates" });
    expect(
      within(ups).getByRole("button", { name: "Mark all read" }),
    ).toBeInTheDocument();
    expect(
      within(ups).getByRole("link", { name: "OA Design replied, unread" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "Settings" }),
    ).toHaveAttribute("href", "/settings/notifications");
  });

  it("never re-sorts what the server sent", async () => {
    const it = (id: string, waitMin: number): InboxItem => ({
      id: `ask:${id}`,
      level: "needs_you",
      kind: "ask",
      urgency: "waiting",
      waitingSince: new Date(Date.now() - waitMin * 60_000).toISOString(),
      artifact: { id: "Cd5fGhJkLm6nPqRs", title: "Landing page" },
      actor: null,
      text: id,
      href: "/a/Cd5fGhJkLm6nPqRs",
      createdAt: new Date().toISOString(),
      readAt: null,
    });
    const body: Inbox = {
      needsYou: [it("short", 1), it("long", 90)],
      later: [],
      updates: [],
      cursor: null,
      counts: { needsYou: 2, unreadUpdates: 0 },
    };
    forYou("mixed");
    server.use(http.get(`*${R.meInbox}`, () => HttpResponse.json(body)));
    mount("/");
    const panel = await openPanel();
    const ids = within(panel)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-for-you-item"));
    expect(ids).toEqual(["ask:short", "ask:long"]);
  });

  it("a mute keeps the row and says so quietly", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    const posts = calls("POST");
    const more = within(row).getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    await findVisibleToast("Muted OA Design.");
    await waitFor(() =>
      expect(posts.find((c) => c.path === R.meInboxMutes)?.body).toEqual({
        kind: "agent",
        id: "agent:design",
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("dialog", { name: "For you" })
          .querySelector('[data-for-you-item="itm:reply1"]'),
      ).not.toBeNull(),
    );
  });

  it("first time with nothing at all: You're all caught up.", async () => {
    forYou("empty");
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(
      await within(panel).findByText("You're all caught up."),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent(
      "When an agent asks you something or someone replies to you, it shows here.",
    );
  });

  it("a returned item is marked, with no Later", async () => {
    forYou("back");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:machine1"]',
    ) as HTMLElement;
    expect(row).toHaveTextContent("Back from later");
    expect(within(row).queryByRole("button", { name: "Later" })).toBeNull();
  });
});

describe("staying fresh", () => {
  it("refreshes the counts every minute while visible and on focus, never while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const gets = calls("GET");
      forYou("mixed");
      mount("/");
      const b = await bell();
      expect(b).toHaveAccessibleName("For you, 2 need you");
      const meGets = () => gets.filter((c) => c.path === R.me).length;
      // The server's counts change: the next refresh shows them.
      let needsYou = 5;
      server.use(
        http.get("*/api/v1/me", () =>
          HttpResponse.json({
            ...fixtures.me,
            inbox: { needsYou, unreadUpdates: 0 },
          }),
        ),
      );
      const n0 = meGets();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      await waitFor(() =>
        expect(b).toHaveAccessibleName("For you, 5 need you"),
      );
      expect(meGets()).toBeGreaterThan(n0);

      // Hidden: no polling at all.
      act(() => focusManager.setFocused(false));
      needsYou = 7;
      const n1 = meGets();
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      expect(meGets()).toBe(n1);
      expect(b).toHaveAccessibleName("For you, 5 need you");

      // Back in focus: it asks at once.
      act(() => focusManager.setFocused(true));
      await waitFor(() =>
        expect(b).toHaveAccessibleName("For you, 7 need you"),
      );
      expect(meGets()).toBe(n1 + 1);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
});

describe("Show more", () => {
  const upd = (id: string): InboxItem => ({
    id,
    level: "update",
    kind: "reply",
    artifact: { id: "De6gHjKmNp7qRsTu", title: "Meeting notes" },
    actor: { kind: "person", name: "Sam Rivera" },
    text: `Reply ${id}`,
    href: "/a/De6gHjKmNp7qRsTu",
    createdAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
  });
  const page = (updates: InboxItem[], cursor: string | null): Inbox => ({
    needsYou: [],
    later: [],
    updates,
    cursor,
    counts: { needsYou: 0, unreadUpdates: 0 },
  });

  it("loads the next page of Updates while there is a cursor", async () => {
    const gets = calls("GET");
    forYou("empty");
    server.use(
      http.get(`*${R.meInbox}`, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get("cursor") === "p2"
            ? page([upd("itm:u2")], null)
            : page([upd("itm:u1")], "p2"),
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    const ups = within(panel).getByRole("region", { name: "Updates" });
    expect(
      within(ups)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Reply itm:u1"]);
    fireEvent.click(within(ups).getByRole("button", { name: "Show more" }));
    await within(ups).findByRole("link", { name: "Reply itm:u2" });
    expect(
      gets.some((c) => c.path === R.meInbox && c.search.get("cursor") === "p2"),
    ).toBe(true);
    // The last page has no cursor: no more to show.
    expect(within(ups).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("has no Show more without a cursor", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    expect(
      within(panel).queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });
});

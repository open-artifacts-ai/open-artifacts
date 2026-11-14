// #2512: the bell (Me.inbox) and "For you" (R.meInbox), on the mocks.
import { type Inbox, type InboxItem, R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  calls,
  events,
  findVisibleToast,
  installHarness,
  mount,
  seen,
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
    mount("/");
    await screen.findByRole(
      "button",
      { name: "Account menu" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(screen.queryByRole("button", { name: /^For you/ })).toBeNull();
    expect(seen.some((u) => u.pathname.startsWith(R.meInbox))).toBe(false);
  });

  it("counts only what needs you, from Me.inbox, before the list loads", async () => {
    forYou("mixed");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, 2 need you");
    expect(b.querySelector("[data-bell-count]")).toHaveTextContent("2");
    expect(b.querySelector("[data-bell-dot]")).toBeNull();
    expect(seen.some((u) => u.pathname === R.meInbox)).toBe(false);
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

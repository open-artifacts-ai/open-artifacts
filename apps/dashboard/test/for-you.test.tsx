// #2512: the bell (Me.inbox) and "For you" (R.meInbox), on the mocks.
import { R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { focusManager } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { List as Inbox, Item as InboxItem } from "../src/foryou/contract";
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

const LANDING_ID = "Cd5fGhJkLm6nPqRs";

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
      "itm:mention1",
    ]);
    expect(rows[0]).toHaveTextContent("waiting 4 min");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "Open" }),
    ).toHaveAttribute("href", "/a/De6gHjKmNp7qRsTu");
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

  it("shows an agent with its tile, as comments do, and a person with initials", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const reply = panel.querySelector('[data-for-you-item="itm:reply1"]');
    expect(
      reply?.querySelector('[data-avatar="agent"][data-linked="true"]'),
    ).toHaveAttribute("data-animal", "fox");
    const decided = panel.querySelector('[data-for-you-item="itm:decided1"]');
    expect(decided?.querySelector('[data-avatar="agent"]')).toBeNull();
    expect(decided).toHaveTextContent(/^SR/);
  });

  it("an opened ask shows the agent's tile before its name, only here", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    const from = await waitFor(() => {
      const el = panel.querySelector("[data-for-you-ask] [data-ask-from]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const tile = from.firstElementChild;
    expect(tile).toHaveAttribute("data-avatar", "agent");
    expect(tile).toHaveAttribute("data-animal", "owl");
    expect(from).toHaveTextContent(/^OA Manager\s*agent\s*asks you$/);
  });

  it("skips items it can't read, so a new kind never blanks the list", async () => {
    const ok: InboxItem = {
      id: "itm:ok",
      level: "update",
      kind: "reply",
      artifact: { id: LANDING_ID, title: "Landing page" },
      actor: null,
      text: "Sam replied",
      href: `/a/${LANDING_ID}`,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    forYou("mixed");
    server.use(
      http.get(`*${R.meInbox}`, () =>
        HttpResponse.json({
          // A kind from the future and approval rows (machine, v6's proposal): none show.
          needsYou: [
            { ...ok, id: "itm:future", level: "needs_you", kind: "teleport" },
            {
              ...ok,
              id: "itm:machine",
              level: "needs_you",
              kind: "machine",
              artifact: null,
            },
            // Contract v6's approval row: v1 shows none.
            {
              ...ok,
              id: "itm:proposal",
              level: "needs_you",
              kind: "proposal",
              urgency: "approval",
              artifact: null,
              proposal: { id: "p", kind: "role", agentName: "OA Design" },
            },
          ],
          later: [],
          updates: [ok, { ...ok, id: "itm:bad", href: "//evil.example" }],
          cursor: null,
          counts: { needsYou: 2, unreadUpdates: 1 },
        }),
      ),
    );
    mount("/");
    const panel = await openPanel();
    expect(
      [...panel.querySelectorAll("[data-for-you-item]")].map((r) =>
        r.getAttribute("data-for-you-item"),
      ),
    ).toEqual(["itm:ok"]);
    expect(
      within(panel).getByText("Nothing is waiting on you."),
    ).toBeInTheDocument();
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

  it("an update's menu offers Mark as read, Stop following, Mute; Mark as read clears the dot and Mark all read", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    expect(row.querySelector("[data-unread-dot]")).not.toBeNull();
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More actions" }),
      { button: 0, pointerType: "mouse" },
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Mark as read", "Stop following this page", "Mute OA Design"]);
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Mark as read" }),
    );
    await waitFor(() =>
      expect(row.querySelector("[data-unread-dot]")).toBeNull(),
    );
    expect(
      within(panel).queryByRole("button", { name: "Mark all read" }),
    ).toBeNull();
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
    await findVisibleToast(
      "Muted OA Design. Its asks to you still show in For you.",
    );
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

  it("nothing needs you: the away summary, and Show them marks it read so it goes", async () => {
    forYou("calm");
    mount("/");
    const panel = await openPanel();
    expect(
      within(panel).getByText("Nothing is waiting on you."),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/^6 updates on 3 pages since 22:00/),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Show them" }));
    await waitFor(() =>
      expect(within(panel).queryByText("While you were away")).toBeNull(),
    );
  });

  it("Updates empty while something needs you: No updates yet., Needs you stays", async () => {
    forYou("back");
    mount("/");
    const panel = await openPanel();
    const updates = within(panel).getByRole("region", { name: "Updates" });
    expect(within(updates).getByText("No updates yet.")).toBeInTheDocument();
    expect(within(panel).queryByText("Nothing is waiting on you.")).toBeNull();
  });

  it("nothing at all: one caught-up state, no group messages", async () => {
    forYou("mixed");
    server.use(
      http.get(`*${R.meInbox}`, () =>
        HttpResponse.json({
          needsYou: [],
          later: [],
          updates: [],
          cursor: null,
          counts: { needsYou: 0, unreadUpdates: 0 },
        }),
      ),
    );
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    // Nothing at all is the single "all caught up" state, not two group messages.
    expect(
      await within(panel).findByText("You're all caught up."),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("No updates yet.")).toBeNull();
  });

  it("Updates has rows: no empty message", async () => {
    forYou("calm");
    mount("/");
    const panel = await openPanel();
    const updates = within(panel).getByRole("region", { name: "Updates" });
    expect(within(updates).queryByText("No updates yet.")).toBeNull();
  });

  it("a returned item is marked, with no Later", async () => {
    forYou("back");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:mention1"]',
    ) as HTMLElement;
    expect(row).toHaveTextContent("Back from later");
    expect(within(row).queryByRole("button", { name: "Later" })).toBeNull();
  });
});

describe("staying fresh", () => {
  it("refreshes the counts every minute while visible and on focus, never while hidden", async () => {
    vi.useFakeTimers();
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
    actor: { kind: "user", name: "Sam Rivera", me: false },
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

const LANDING = "Cd5fGhJkLm6nPqRs";

/** The seeded ask with this question on the Landing page: its thread and comment ids. */
async function seeded(question: string) {
  const res = await fetch(
    new URL(`${R.comments(LANDING)}?status=all`, "http://localhost").href,
    { headers: { cookie: "oa_session=test" } },
  );
  const { threads } = (await res.json()) as {
    threads: {
      id: string;
      comments: { id: string; ask?: { question: string } }[];
    }[];
  };
  for (const t of threads)
    for (const c of t.comments)
      if (c.ask?.question === question) return { thread: t.id, comment: c.id };
  throw new Error(`no seeded ask: ${question}`);
}

/**
 * The inbox holds just this ask until a pick reaches the server (the server
 * drops an answered ask). Opens the panel and the card.
 */
async function openAsk(
  question: string,
  level: InboxItem["level"] = "needs_you",
) {
  server.use(
    ...createHandlers({
      events,
      forYou: "mixed",
      commentAsks: true,
      commentDeciders: true,
      commentPasskey: "ok",
    }),
  );
  const ids = await seeded(question);
  let answered = false;
  const other: InboxItem = {
    id: "itm:read1",
    level: "update",
    kind: "reply",
    artifact: { id: LANDING, title: "Landing page" },
    actor: null,
    text: "Sam replied",
    href: `/a/${LANDING}`,
    createdAt: new Date().toISOString(),
    readAt: new Date().toISOString(),
  };
  const item: InboxItem = {
    id: `ask:${ids.comment}`,
    level,
    kind: "ask",
    urgency: "plain",
    artifact: { id: LANDING, title: "Landing page" },
    actor: null,
    text: question,
    href: `/a/${LANDING}?thread=${ids.thread}`,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  server.use(
    http.post("*/api/v1/artifacts/:id/comments/:t/comments/:c/answer", () => {
      answered = true;
      return undefined;
    }),
    http.get(`*${R.meInbox}`, () =>
      HttpResponse.json({
        needsYou: level === "needs_you" && !answered ? [item] : [],
        later: [],
        // One read update keeps the list from being empty after the answer.
        updates: level === "update" ? [item] : [other],
        cursor: null,
        counts: {
          needsYou: level === "needs_you" && !answered ? 1 : 0,
          unreadUpdates: level === "update" ? 1 : 0,
        },
      } satisfies Inbox),
    ),
  );
  mount("/");
  const panel = await openPanel();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: new RegExp(question.replace(/[?]/g, "\\?")),
    }),
  );
  const card = await waitFor(() => {
    const el = panel.querySelector(
      "[data-for-you-ask] [data-ask], [data-for-you-ask] [data-ask-decided]",
    );
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
  return { panel, card, ids };
}

describe("an ask opened in the panel", () => {
  it("answers through the page's own route, then returns focus to the list", async () => {
    const posts = calls("POST");
    const { panel, card, ids } = await openAsk("Which layout do we ship?");
    fireEvent.click(within(card).getByRole("button", { name: /Compact hero/ }));
    await waitFor(() =>
      expect(panel.querySelector("[data-for-you-ask]")).toBeNull(),
    );
    expect(posts.map((c) => c.path)).toContain(
      R.commentAnswer(LANDING, ids.thread, ids.comment),
    );
    // The row is gone: focus goes to the next row, never <body>.
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName("Sam replied"),
    );
  });

  it("back to the list focuses the row it came from", async () => {
    const { panel } = await openAsk("Which layout do we ship?");
    fireEvent.click(within(panel).getByRole("button", { name: /^For you$/ }));
    await waitFor(() =>
      expect(document.activeElement).toHaveAccessibleName(
        "Which layout do we ship?",
      ),
    );
  });

  it("a weigh-in shows who decides, and weighing in leaves the list", async () => {
    const posts = calls("POST");
    const { panel, card, ids } = await openAsk(
      "Which pricing table goes on the landing page?",
    );
    expect(card).toHaveTextContent("Maya Chen decides");
    fireEvent.click(
      within(card).getByRole("button", { name: /B: two columns/ }),
    );
    // Weighed in: it no longer waits for you, so the card closes and the row goes.
    await waitFor(() =>
      expect(panel.querySelector("[data-for-you-ask]")).toBeNull(),
    );
    expect(posts.map((c) => c.path)).toContain(
      R.commentAnswer(LANDING, ids.thread, ids.comment),
    );
    expect(
      panel.querySelector(`[data-for-you-item="ask:${ids.comment}"]`),
    ).toBeNull();
  });

  it("a pick an old server refuses with passkey_required is a plain error, with no passkey flow (#2864)", async () => {
    const { card, ids } = await openAsk("Ship the changelog?");
    // The shared mock no longer refuses (#2885): stand in for an old server.
    server.use(
      http.post(`*${R.commentAnswer(LANDING, ids.thread, ids.comment)}`, () =>
        HttpResponse.json(
          { error: { code: "passkey_required", message: "x" } },
          { status: 403 },
        ),
      ),
    );
    fireEvent.click(within(card).getByRole("button", { name: /Ship it/ }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Couldn't send your answer. Reload the page and try again.",
    );
    expect(card).not.toHaveTextContent(/Pick again|passkey|terminal/i);
  });

  it("a risky ask shows no passkey line or prompt (#2864)", async () => {
    const { card } = await openAsk("Merge the release PR?");
    expect(card).not.toHaveTextContent(/passkey/i);
    expect(card.querySelector("[data-passkey-hint]")).toBeNull();
  });

  it("a closed ask shows its decision", async () => {
    const { panel } = await openAsk("Which plan card is shown first?");
    expect(
      panel.querySelector("[data-for-you-ask] [data-ask-decided]"),
    ).not.toBeNull();
  });

  it("an update-level ask opens its card too", async () => {
    const { card } = await openAsk("Which layout do we ship?", "update");
    expect(card).toHaveTextContent("Which layout do we ship?");
  });

  it("says so when the ask can't be loaded", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    server.use(
      http.get(`*${R.comments(LANDING)}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    expect(
      await within(panel).findByText("Couldn't open this ask."),
    ).toBeInTheDocument();
  });

  it("Try again loads the card after a failure", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    let fail = true;
    server.use(
      http.get(`*${R.comments(LANDING)}`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: "not_found", message: "Not found" } },
              { status: 404 },
            )
          : undefined,
      ),
    );
    mount("/");
    const panel = await openPanel();
    fireEvent.click(
      within(panel).getByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    await within(panel).findByText("Couldn't open this ask.");
    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(
      await within(panel).findByRole("button", { name: /Yes, ship it/ }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("Couldn't open this ask.")).toBeNull();
  });
});

describe("failures and announcements", () => {
  it("a list that fails to load offers Try again", async () => {
    forYou("mixed");
    let fail = true;
    server.use(
      http.get(`*${R.meInbox}`, () =>
        fail
          ? HttpResponse.json(
              { error: { code: "bad_request", message: "No" } },
              { status: 400 },
            )
          : undefined,
      ),
    );
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(
      await within(panel).findByText("Couldn't load For you."),
    ).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(
      await within(panel).findByRole("region", { name: "Needs you" }),
    ).toBeInTheDocument();
  });

  it("Undo on the mute toast unmutes", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    const dels = calls("DELETE");
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More actions" }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    await findVisibleToast(
      "Muted OA Design. Its asks to you still show in For you.",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(dels.map((c) => c.path)).toContain(
        R.meInboxMute("agent", "agent:design"),
      ),
    );
  });

  it("an Undo that fails says so", async () => {
    forYou("mixed");
    server.use(
      http.delete("*/api/v1/me/inbox/mutes/:kind/:id", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Something went wrong" } },
          { status: 500 },
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    const row = panel.querySelector(
      '[data-for-you-item="itm:reply1"]',
    ) as HTMLElement;
    fireEvent.pointerDown(
      within(row).getByRole("button", { name: "More actions" }),
      { button: 0, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mute OA Design" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    // The app's error copy: the server's message here.
    await findVisibleToast("Something went wrong");
  });

  it("a Later that fails puts the row back and says so", async () => {
    forYou("mixed");
    server.use(
      http.post("*/api/v1/me/inbox/:id/later", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    mount("/");
    const panel = await openPanel();
    const row = () =>
      panel.querySelector('[data-for-you-item="itm:mention1"]') as HTMLElement;
    fireEvent.pointerDown(
      within(row()).getByRole("button", { name: /Later/ }),
      {
        button: 0,
        pointerType: "mouse",
      },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tomorrow morning" }),
    );
    await findVisibleToast("Not found");
    await waitFor(() => expect(row()).not.toBeNull());
    expect(await bell()).toHaveAccessibleName("For you, 2 need you");
  });

  it("Later sends the browser's time zone, and omits it when unknown", async () => {
    const bodies: unknown[] = [];
    const run = async () => {
      forYou("mixed");
      server.use(
        http.post("*/api/v1/me/inbox/:id/later", async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 },
          );
        }),
      );
      mount("/");
      const panel = await openPanel();
      const row = panel.querySelector(
        '[data-for-you-item="itm:mention1"]',
      ) as HTMLElement;
      fireEvent.pointerDown(
        within(row).getByRole("button", { name: /Later/ }),
        { button: 0, pointerType: "mouse" },
      );
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Tomorrow morning" }),
      );
      await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    };
    const spy = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({
        timeZone: "Asia/Tokyo",
      } as Intl.ResolvedDateTimeFormatOptions);
    await run();
    expect(bodies[0]).toEqual({ until: "morning", timeZone: "Asia/Tokyo" });
    spy.mockReturnValue({
      timeZone: undefined,
    } as unknown as Intl.ResolvedDateTimeFormatOptions);
    bodies.length = 0;
    cleanup();
    await run();
    spy.mockRestore();
    expect(bodies[0]).toEqual({ until: "morning" });
  });

  it("announces a change in the count, politely", async () => {
    forYou("mixed");
    mount("/");
    const panel = await openPanel();
    const live = document.querySelector("[data-for-you-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("");
    const row = panel.querySelector(
      '[data-for-you-item="itm:mention1"]',
    ) as HTMLElement;
    fireEvent.pointerDown(within(row).getByRole("button", { name: /Later/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tomorrow morning" }),
    );
    await waitFor(() => expect(live).toHaveTextContent("For you, 1 needs you"));
  });
});

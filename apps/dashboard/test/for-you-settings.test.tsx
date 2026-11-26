// #2512 slices 2 and 3: Settings › Notifications for For you
// (R.meNotificationPrefs, R.meInboxMutes) and this browser's notifications
// (R.mePushKey, R.mePushSubscriptions, PATCH R.mePushSubscription, #2774).
import { type NotificationPrefs, NotificationPrefsSchema, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { muteErrorCopy } from "../src/foryou/prefsContract";
import {
  dismissNudge,
  nudgeDismissed,
  pushSubsKey,
  SW_SCOPE,
  SW_URL,
} from "../src/foryou/push";
import { pushSwitchHandlers } from "../src/mockPushSwitches";
import { prefsToSave, thisBrowser } from "../src/settings/ForYouPrefs";
import { installClock, settle } from "./clock";
import {
  calls,
  events,
  findVisibleToast,
  installHarness,
  lastClient,
  mount,
  server,
} from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();
installClock();

const ME_ID = fixtures.me.user.id;

/** A browser that can do web push, with our worker and its subscription faked. */
// The mock API's push key as bytes: a subscription made with it counts as on (#3024).
const MOCK_KEY = Uint8Array.from(
  atob(
    "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"
      .replace(/-/g, "+")
      .replace(/_/g, "/") + "=",
  ),
  (c) => c.charCodeAt(0),
).buffer;

function fakePush(start: NotificationPermission, answer = start) {
  let sub: object | null = null;
  const subscription = {
    endpoint: "https://push.example.com/abc",
    options: { applicationServerKey: MOCK_KEY },
    toJSON: () => ({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez" },
    }),
    unsubscribe: async () => {
      sub = null;
      return true;
    },
  };
  // A browser that kept an id (subscribed()) has its subscription too.
  if (localStorage.getItem("oa.push.subscription.v2")) sub = subscription;
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: vi.fn(async () => {
      sub = subscription;
      return subscription;
    }),
  };
  const reg = {
    scope: `${location.origin}${SW_SCOPE}`,
    active: {},
    installing: null,
    waiting: null,
    pushManager,
  };
  const register = vi.fn(async () => reg);
  const n = {
    permission: start,
    requestPermission: vi.fn(async () => {
      n.permission = answer;
      return answer;
    }),
  };
  vi.stubGlobal("Notification", n);
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
      getRegistration: async (scope: string) =>
        scope === SW_SCOPE && sub ? reg : undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  return { register, pushManager, n };
}
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  localStorage.clear();
});

const needs = () =>
  screen.findByRole(
    "switch",
    { name: "Needs you in this browser" },
    { timeout: FIRST_LOAD_MS },
  );

const page = async () => {
  fakePush("default");
  mount("/settings/notifications");
  return screen.findByRole(
    "switch",
    { name: "Needs you in this browser" },
    { timeout: FIRST_LOAD_MS },
  );
};

const err = (code: string, status: number) =>
  HttpResponse.json({ error: { code, message: code } }, { status });

describe("For you settings", () => {
  it("are absent on a server without For you; the email switch stays", async () => {
    const gets = calls("GET");
    mount("/settings/notifications");
    await screen.findByRole(
      "region",
      { name: "Notifications" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(
      screen.queryByRole("switch", { name: "Needs you in this browser" }),
    ).toBeNull();
    expect(gets.some((c) => c.path === R.meNotificationPrefs)).toBe(false);
  });

  it("shows the levels, quiet hours, interrupts, lock screens and mutes", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const needs = await page();
    expect(needs).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Quiet hours are on: agents are told, with the real end time.
    expect(
      screen.getByText(
        /Your own agents see "away until 07:30" and can plan around it\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Interrupt me for" }),
    ).toHaveTextContent("Waiting asks and approvals");
    expect(
      screen.getByRole("combobox", { name: "On lock screens" }),
    ).toHaveTextContent("Hide details");
    const muted = screen.getByRole("region", { name: "Muted" });
    expect(within(muted).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByRole("switch", { name: "Email me about comments" }),
    ).toBeInTheDocument();
  });

  it("quiet hours, interrupts and lock screens are live: enabled, no Coming later", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    const box = screen.getByRole("region", { name: "When to interrupt" });
    expect(box).not.toHaveAccessibleDescription("Coming later");
    for (const name of [
      "Quiet hours start",
      "Quiet hours end",
      "Interrupt me for",
      "On lock screens",
    ])
      expect(screen.getByRole("combobox", { name })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeEnabled();
  });

  it("the away line follows the end time, and is gone with quiet hours off", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Quiet hours end" }),
      {
        key: "Enter",
      },
    );
    fireEvent.click(await screen.findByRole("option", { name: "06:00" }));
    expect(
      await screen.findByText(/"away until 06:00" and can plan around it/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() => expect(screen.queryByText(/away until/)).toBeNull());
  });

  it("a change saves the whole prefs with the browser's zone", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    const puts = calls("PUT");
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() => expect(puts[0]?.body).toBeDefined());
    expect(puts[0]?.path).toBe(R.meNotificationPrefs);
    expect(puts[0]?.body).toMatchObject({
      quietHours: null,
      needsYou: { inApp: true },
      browserAllAsks: false,
      lockScreenDetail: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Quiet hours" }),
      ).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("a failed save puts the choice back and says so", async () => {
    server.use(
      http.put(`*${R.meNotificationPrefs}`, () => err("boom", 500)),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    await page();
    const sw = screen.getByRole("switch", { name: "Quiet hours" });
    fireEvent.click(sw);
    await findVisibleToast("Couldn't save. Try again.");
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Quiet hours" }),
      ).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("an API-set true never shows the browser switches on without a subscription (#2769)", async () => {
    server.use(
      http.get(`*${R.meNotificationPrefs}`, () =>
        HttpResponse.json({
          needsYou: { inApp: true, browser: true },
          updates: { inApp: true, browser: true },
          browserAllAsks: true,
          quietHours: null,
          timeZone: "UTC",
          lockScreenDetail: true,
        }),
      ),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    const needs = await page();
    expect(needs).toHaveAttribute("aria-checked", "false");
    const updates = screen.getByRole("switch", {
      name: "Updates in this browser",
    });
    expect(updates).toHaveAttribute("aria-checked", "false");
    expect(updates).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Interrupt me for" }),
    ).toHaveTextContent("Every ask put to me");
  });

  it("unmutes", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    const dels = calls("DELETE");
    const muted = screen.getByRole("region", { name: "Muted" });
    fireEvent.click(
      within(muted).getByRole("button", { name: "Unmute OA Polish" }),
    );
    await waitFor(() =>
      expect(within(muted).getAllByRole("listitem")).toHaveLength(1),
    );
    expect(dels.map((c) => c.path)).toContain(
      R.meInboxMute("agent", "agent:polish"),
    );
  });

  it("an unmute of something already gone says so and refreshes the list", async () => {
    server.use(
      http.delete("*/api/v1/me/inbox/mutes/:kind/:id", () =>
        err("not_found", 404),
      ),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    await page();
    const muted = screen.getByRole("region", { name: "Muted" });
    fireEvent.click(
      within(muted).getByRole("button", { name: "Unmute OA Polish" }),
    );
    await findVisibleToast("That's already unmuted.");
    await waitFor(() =>
      expect(within(muted).getAllByRole("listitem")).toHaveLength(2),
    );
  });

  it("an end time that isn't HH:MM (an ISO string) never parses", () => {
    expect(
      NotificationPrefsSchema.shape.quietHours.safeParse({
        start: "22:00",
        end: "2026-11-17T07:30:00.000Z",
      }).success,
    ).toBe(false);
  });
});

/** This browser's subscription on the server, with its switches. */
function subscribed(over: Record<string, unknown> = {}, patchStatus = 200) {
  localStorage.setItem(
    "oa.push.subscription.v2",
    JSON.stringify({ userId: ME_ID, id: "sub_9" }),
  );
  let item = {
    id: "sub_9",
    label: "Chrome on this Mac",
    createdAt: "2026-11-17T10:00:00.000Z",
    lastSentAt: null,
    needsYou: true,
    updates: false,
    ...over,
  };
  const patches: unknown[] = [];
  const handlers = [
    http.get(`*${R.mePushSubscriptions}`, () =>
      HttpResponse.json({ items: [item] }),
    ),
    http.patch("*/api/v1/me/push/subscriptions/:id", async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      if (patchStatus !== 200) return err("internal", patchStatus);
      item = { ...item, ...(body as object) };
      return HttpResponse.json({
        needsYou: item.needsYou,
        updates: item.updates,
      });
    }),
  ];
  return { patches, handlers };
}

describe("this browser's notifications (slice 3, S5)", () => {
  it("reads this browser's own switches from the subscription list", async () => {
    const sub = subscribed({ needsYou: true, updates: false });
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const sw = await page();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(sw).toBeEnabled();
    expect(sw).toHaveAccessibleDescription("On for Chrome on this Mac");
    const updates = screen.getByRole("switch", {
      name: "Updates in this browser",
    });
    expect(updates).toHaveAttribute("aria-checked", "false");
    expect(updates).toBeEnabled();
  });

  it("removes the enrolled device from the cache after the server turns it off", async () => {
    const sub = subscribed({ needsYou: true, updates: false });
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const device = await page();
    await waitFor(() => expect(device).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(device);
    await waitFor(() => expect(sub.patches).toEqual([{ needsYou: false }]));
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Updates in this browser" }),
      ).toBeDisabled(),
    );
  });

  it("a toggle PATCHes the switch at once and keeps it", async () => {
    const sub = subscribed();
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const sw = await page();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const updates = screen.getByRole("switch", {
      name: "Updates in this browser",
    });
    fireEvent.click(updates);
    await waitFor(() =>
      expect(updates).toHaveAttribute("aria-checked", "true"),
    );
    await waitFor(() => expect(sub.patches).toEqual([{ updates: true }]));
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    await waitFor(() =>
      expect(sub.patches).toEqual([{ updates: true }, { needsYou: false }]),
    );
    // Off keeps the subscription (Updates is still on): no unsubscribe, no DELETE.
    expect(updates).toHaveAttribute("aria-checked", "true");
  });

  it("while the browser's key check is unknown, the switch is never On (#3024)", async () => {
    const sub = subscribed();
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const f = fakePush("default");
    f.pushManager.getSubscription = () => new Promise(() => {});
    mount("/settings/notifications");
    const sw = await needs();
    // Everything else has loaded (the list lists this browser); the check hasn't.
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("a failed PATCH puts the switch back and says so", async () => {
    const sub = subscribed({}, 500);
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const sw = await page();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const updates = screen.getByRole("switch", {
      name: "Updates in this browser",
    });
    fireEvent.click(updates);
    await findVisibleToast("Couldn't save. Try again.");
    await waitFor(() =>
      expect(updates).toHaveAttribute("aria-checked", "false"),
    );
    expect(sub.patches).toEqual([{ updates: true }]);
  });

  it("no subscription: Needs you is off and asks only on the click, Updates waits", async () => {
    const base = createHandlers({ events, forYou: "mixed" });
    server.use(...pushSwitchHandlers(() => base), ...base);
    const f = fakePush("default", "granted");
    const posts = calls("POST");
    const puts = calls("PUT");
    mount("/settings/notifications");
    const sw = await needs();
    expect(sw).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(sw).toBeEnabled());
    const updates = screen.getByRole("switch", {
      name: "Updates in this browser",
    });
    expect(updates).toBeDisabled();
    expect(updates).toHaveAccessibleDescription("Turn on Needs you here first");
    // Nothing is asked before the click.
    expect(f.n.requestPermission).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(f.n.requestPermission).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledWith(SW_URL, { scope: SW_SCOPE });
    expect(f.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(
      posts.find((c) => c.path === R.mePushSubscriptions)?.body,
    ).toMatchObject({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez" },
    });
    await waitFor(() =>
      expect(
        (
          puts.find((c) => c.path === R.meNotificationPrefs)?.body as
            | { needsYou: { browser: boolean } }
            | undefined
        )?.needsYou.browser,
      ).toBe(true),
    );
    expect(sw).toHaveAccessibleDescription(/^On for /);
    expect(updates).toBeEnabled();
  });

  it("a refusal: Blocked in the cell, how to unblock under the row", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const f = fakePush("default", "denied");
    mount("/settings/notifications");
    const sw = await needs();
    await waitFor(() => expect(sw).toBeEnabled());
    fireEvent.click(sw);
    expect(
      await screen.findByText("Blocked in this browser"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Needs you in this browser" }),
    ).toBeNull();
    const note = document.querySelector("[data-push-note]") as HTMLElement;
    expect(note.textContent).toBe(
      "Your browser is blocking notifications from this site. Allow them in your browser's site settings.",
    );
    expect(note).toHaveAttribute("colspan", "3");
    expect(f.register).not.toHaveBeenCalled();
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toBeDisabled();
  });

  it("a browser that can't, key present: Not available, the line under the row, account controls stay on", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    mount("/settings/notifications");
    expect(
      await screen.findByText("Not available", {}, { timeout: FIRST_LOAD_MS }),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-push-note]")?.textContent).toBe(
      "This browser can't show notifications.",
    );
    expect(
      screen.queryByRole("switch", { name: "Needs you in this browser" }),
    ).toBeNull();
    expect(
      screen.queryByText(/Browser notifications aren't (set up|available)/),
    ).toBeNull();
    for (const name of ["Interrupt me for", "On lock screens"])
      expect(screen.getByRole("combobox", { name })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeEnabled();
    expect(
      screen.getByText("These apply as soon as notifications reach a browser."),
    ).toBeInTheDocument();
  });

  it("no push key on the server: both switches off and disabled, in plain words", async () => {
    const sub = subscribed();
    server.use(
      // First: server.use's earlier handlers win.
      http.get(`*${R.mePushKey}`, () =>
        HttpResponse.json(
          { error: { code: "push_unavailable", message: "No key" } },
          { status: 404 },
        ),
      ),
      ...sub.handlers,
      ...createHandlers({ events, forYou: "mixed" }),
    );
    const sw = await page();
    for (const el of [
      sw,
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ]) {
      expect(el).toHaveAttribute("aria-checked", "false");
      expect(el).toBeDisabled();
      expect(el).toHaveAccessibleDescription("Off for this site");
    }
    // An owner step, in plain words, once, under the table.
    expect(
      screen.getByText(
        /^Browser notifications aren't turned on for .+ yet\. Upgrading the instance turns them on: it adds the keys they need\. Everything else on this page works now\.$/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("These apply as soon as notifications reach a browser."),
    ).toBeInTheDocument();
    // The account settings never wait on push (#2943).
    expect(
      screen.getByRole("combobox", { name: "On lock screens" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Interrupt me for" }),
    ).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeEnabled();
  });

  it("no push key, a member: says who can turn it on, by the owner's name", async () => {
    server.use(
      http.get(`*${R.mePushKey}`, () => err("push_unavailable", 404)),
      http.get("*/api/v1/me", async ({ request }) => {
        const res = await getResponse(
          createHandlers({ events, forYou: "mixed" }),
          request,
        );
        const me = (await res?.json()) as Record<string, any>;
        return HttpResponse.json({
          ...me,
          user: { ...me.user, role: "member" },
          instanceOwner: { name: "Leo Urbina" },
        });
      }),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    fakePush("default");
    mount("/settings/notifications");
    expect(
      await screen.findByText(
        /^Browser notifications aren't turned on for .+ yet\. Leo Urbina, who runs this site, can turn them on\. Everything else on this page works now\.$/,
        {},
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
  });

  it("no push key: the interrupts box still saves", async () => {
    server.use(
      http.get(`*${R.mePushKey}`, () => err("push_unavailable", 404)),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    fakePush("default");
    mount("/settings/notifications");
    const puts = calls("PUT");
    fireEvent.keyDown(
      await screen.findByRole(
        "combobox",
        { name: "On lock screens" },
        { timeout: FIRST_LOAD_MS },
      ),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Show details" }),
    );
    await waitFor(() =>
      expect(
        puts.find((c) => c.path === R.meNotificationPrefs)?.body,
      ).toMatchObject({
        lockScreenDetail: true,
      }),
    );
  });
});

/** An iPhone or iPad, in a Safari tab or opened from the Home Screen. */
function ios(standalone: boolean) {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: standalone,
  });
}
const realUa = navigator.userAgent;
const resetIos = () => {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: realUa,
  });
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: undefined,
  });
};

describe("iPhone and iPad (#2943)", () => {
  afterEach(resetIos);

  it("in a Safari tab: says to add it to the Home Screen, not 'can't show notifications'", async () => {
    ios(false);
    server.use(...createHandlers({ events, forYou: "mixed" }));
    mount("/settings/notifications");
    expect(
      (
        await screen.findAllByText(
          "Add to Home Screen first",
          {},
          { timeout: FIRST_LOAD_MS },
        )
      )[0],
    ).toBeInTheDocument();
    expect(document.querySelector("[data-push-note]")?.textContent).toMatch(
      /^On iPhone and iPad, notifications work only once this site is on your Home Screen\. Tap Share, then Add to Home Screen, and open it from there\.$/,
    );
    expect(
      screen.queryByText("This browser can't show notifications."),
    ).toBeNull();
    // OA Product-2: the Updates cell says the same, not "Turn on Needs you here first".
    expect(screen.getAllByText("Add to Home Screen first")).toHaveLength(2);
    expect(screen.queryByText("Turn on Needs you here first")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "On lock screens" }),
    ).toBeEnabled();
    expect(
      screen.getByText("These apply as soon as notifications reach a browser."),
    ).toBeInTheDocument();
  });

  it("an iPad that reports a Mac is treated as iOS too", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });
    server.use(...createHandlers({ events, forYou: "mixed" }));
    mount("/settings/notifications");
    expect(
      (
        await screen.findAllByText(
          "Add to Home Screen first",
          {},
          { timeout: FIRST_LOAD_MS },
        )
      )[0],
    ).toBeInTheDocument();
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: 0,
    });
  });

  it("from the Home Screen it is the normal case: a switch, no iOS line", async () => {
    ios(true);
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const sw = await page();
    await waitFor(() => expect(sw).toBeEnabled());
    expect(document.querySelector("[data-push-note]")).toBeNull();
    expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
    expect(
      screen.queryByText(
        "These apply as soon as notifications reach a browser.",
      ),
    ).toBeNull();
  });

  it("For you says it instead of hiding the ask silently", async () => {
    ios(false);
    server.use(...createHandlers({ events, forYou: "mixed" }));
    mount("/");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^For you/ },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    const panel = await screen.findByRole("dialog", { name: "For you" });
    const note = await waitFor(() => {
      const el = panel.querySelector("[data-push-ios]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(note).toHaveTextContent("Tap Share, then Add to Home Screen");
  });
});

describe("the nudge's Not now (Design)", () => {
  it("keeps it away on this browser for at least 30 days", () => {
    const t0 = Date.UTC(2026, 10, 16);
    expect(nudgeDismissed(t0)).toBe(false);
    dismissNudge(t0);
    expect(nudgeDismissed(t0 + 29 * 24 * 3600_000)).toBe(true);
    expect(nudgeDismissed(t0 + 30 * 24 * 3600_000 - 1)).toBe(true);
    // An older build's "for good" still counts.
    localStorage.setItem("oa.push.nudge.dismissed", "1");
    expect(nudgeDismissed(t0 + 400 * 24 * 3600_000)).toBe(true);
  });
});

describe("mute errors in plain words (#2769)", () => {
  it("mutes_full, not found, and the rest", () => {
    expect(muteErrorCopy({ status: 409, code: "mutes_full" }, "mute")).toMatch(
      /muted as many as we allow \(200\)/,
    );
    expect(muteErrorCopy({ code: "mutes_full" }, "mute")).toMatch(/200/);
    expect(muteErrorCopy({ status: 404 }, "mute")).toMatch(/gone/);
    expect(muteErrorCopy({ status: 404 }, "unmute")).toBe(
      "That's already unmuted.",
    );
    expect(muteErrorCopy({ status: 500 }, "mute")).toBe("Couldn't mute that.");
    expect(muteErrorCopy(null, "unmute")).toBe("Couldn't unmute that.");
  });
});

describe("prefsToSave", () => {
  it("sends quiet hours as set, with the browser's zone", () => {
    const prefs = {
      needsYou: { browser: false },
      quietHours: { start: "22:00", end: "07:30" },
    } as unknown as NotificationPrefs;
    const out = prefsToSave(prefs);
    expect(out.quietHours).toEqual({ start: "22:00", end: "07:30" });
    expect(out.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("thisBrowser", () => {
  it("names the browser and the device", () => {
    expect(
      thisBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Chrome on this Mac");
    expect(
      thisBrowser(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
      ),
    ).toBe("Firefox on this PC");
    expect(
      thisBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on this iPhone");
  });
});

describe("the mock's per-browser switches", () => {
  it("lists them, PATCH changes them, an unknown id is 404", async () => {
    const base = createHandlers({ events, forYou: "mixed" });
    server.use(...pushSwitchHandlers(() => base), ...base);
    const origin = location.origin;
    const json = { "Content-Type": "application/json", "X-OA-Request": "1" };
    await fetch(`${origin}${R.mePushSubscriptions}`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        endpoint: "https://push.example.com/x",
        keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez" },
      }),
    });
    const get = async () =>
      (
        (await (await fetch(`${origin}${R.mePushSubscriptions}`)).json()) as {
          items: { id: string; needsYou: boolean; updates: boolean }[];
        }
      ).items;
    expect((await get())[0]).toMatchObject({ needsYou: true, updates: false });
    const id = (await get())[0]?.id ?? "";
    const ok = await fetch(`${origin}${R.mePushSubscription(id)}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ updates: true }),
    });
    expect(await ok.json()).toEqual({ needsYou: true, updates: true });
    expect((await get())[0]).toMatchObject({ updates: true });
    const gone = await fetch(`${origin}${R.mePushSubscription("nope")}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ updates: true }),
    });
    expect(gone.status).toBe(404);
  });
});

describe("a subscription left by someone else (Axe)", () => {
  const KEY = "oa.push.subscription.v2";
  const keep = (userId: string) =>
    localStorage.setItem(KEY, JSON.stringify({ userId, id: "sub_9" }));
  const live = async () => {
    const f = fakePush("granted");
    await f.pushManager.subscribe();
    return f;
  };

  it("another member signs in: the browser's subscription goes, and Settings shows it off", async () => {
    keep("someone-else");
    const f = await live();
    server.use(
      http.get(`*${R.mePushSubscriptions}`, () =>
        HttpResponse.json({ items: [] }),
      ),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    mount("/settings/notifications");
    const sw = await needs();
    await waitFor(async () =>
      expect(await f.pushManager.getSubscription()).toBeNull(),
    );
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("oa.push.subscription")).toBeNull();
  });

  it("an old unscoped id is never read as this member's", async () => {
    localStorage.setItem("oa.push.subscription", "sub_9");
    const sub = subscribed();
    localStorage.removeItem(KEY);
    localStorage.setItem("oa.push.subscription", "sub_9");
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    const sw = await page();
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem("oa.push.subscription")).toBeNull();
  });

  it("the same member reloading keeps it", async () => {
    keep(ME_ID);
    const f = await live();
    const sub = subscribed();
    keep(ME_ID);
    server.use(...sub.handlers, ...createHandlers({ events, forYou: "mixed" }));
    mount("/settings/notifications");
    const sw = await needs();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(await f.pushManager.getSubscription()).not.toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("a list that fails to load removes nothing", async () => {
    keep("someone-else");
    const f = await live();
    server.use(
      http.get(`*${R.mePushSubscriptions}`, () => err("internal", 500)),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    mount("/settings/notifications");
    await needs();
    // The list's failure is the event: only after it could anything be removed.
    await waitFor(() =>
      expect(lastClient.getQueryState(pushSubsKey)?.status).toBe("error"),
    );
    await settle(300);
    expect(await f.pushManager.getSubscription()).not.toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });
});

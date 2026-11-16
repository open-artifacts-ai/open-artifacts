// #2512 slices 2 and 3: Settings › Notifications for For you
// (R.meNotificationPrefs, R.meInboxMutes) and this browser's notifications
// (R.mePushKey, R.mePushSubscriptions).
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissNudge,
  nudgeDismissed,
  SW_SCOPE,
  SW_URL,
} from "../src/foryou/push";
import { prefsToSave, thisBrowser } from "../src/settings/ForYouPrefs";
import { calls, events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

/** A browser that can do web push, with our worker and its subscription faked. */
function fakePush(start: NotificationPermission, answer = start) {
  let sub: object | null = null;
  const subscription = {
    endpoint: "https://push.example.com/abc",
    toJSON: () => ({
      endpoint: "https://push.example.com/abc",
      keys: { p256dh: "BNcRdreALRFX", auth: "tBHItJI5svbpez" },
    }),
    unsubscribe: async () => {
      sub = null;
      return true;
    },
  };
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

const levels = async () => {
  mount("/settings/notifications");
  return screen.findByRole("table", {}, { timeout: FIRST_LOAD_MS });
};
const needs = () =>
  screen.findByRole(
    "switch",
    { name: "Needs you in this browser" },
    { timeout: FIRST_LOAD_MS },
  );

describe("For you settings", () => {
  it("are absent on a server without For you; the email switch stays", async () => {
    const gets = calls("GET");
    mount("/settings/notifications");
    await screen.findByRole(
      "region",
      { name: "Notifications" },
      { timeout: FIRST_LOAD_MS },
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(gets.some((c) => c.path === R.meNotificationPrefs)).toBe(false);
  });

  it("shows the levels, quiet hours, interrupts, lock screens and mutes", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    fakePush("default");
    mount("/settings/notifications");
    expect(await needs()).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toBeDisabled();
    // Slice 3: live, so quiet hours show as the server has them (on).
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/away until 07:30/)).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Interrupt me for" }),
    ).toHaveTextContent("Asks waiting for you");
    expect(
      screen.getByRole("combobox", { name: "On lock screens" }),
    ).toHaveTextContent("Hide details");
    const muted = screen.getByRole("region", { name: "Muted" });
    expect(within(muted).getAllByRole("listitem")).toHaveLength(2);
    expect(
      screen.getByRole("switch", { name: "Email me about comments" }),
    ).toBeInTheDocument();
  });

  // Slice 3: the interrupt settings are live with browser notifications.
  it("saves the whole prefs in the browser's zone (quiet hours off)", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    fakePush("default");
    mount("/settings/notifications");
    await needs();
    const puts = calls("PUT");
    expect(screen.queryByText("Coming later", { selector: "p" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(puts.find((c) => c.path === R.meNotificationPrefs)?.body).toEqual({
        needsYou: { inApp: true, browser: false },
        updates: { inApp: true, browser: false },
        browserAllAsks: false,
        quietHours: null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lockScreenDetail: false,
      }),
    );
  });

  it("unmutes", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    fakePush("default");
    mount("/settings/notifications");
    await needs();
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
});

describe("this browser's notifications (slice 3)", () => {
  it("are asked for only on the click, then subscribe, register and save", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const f = fakePush("default", "granted");
    const posts = calls("POST");
    const puts = calls("PUT");
    mount("/settings/notifications");
    const sw = await needs();
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
  });

  it("turning off removes this browser's subscription", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    fakePush("default", "granted");
    const dels = calls("DELETE");
    mount("/settings/notifications");
    const sw = await needs();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(dels.map((c) => c.path)).toContain(R.mePushSubscription("sub_1"));
  });

  it("a refusal: Blocked in the cell, how to unblock under the row; interrupts stay live", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const f = fakePush("default", "denied");
    mount("/settings/notifications");
    fireEvent.click(await needs());
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
    // Blocked here isn't "can't": the interrupt settings stay live.
    expect(
      screen.getByRole("combobox", { name: "Interrupt me for" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("Browser notifications aren't available here."),
    ).toBeNull();
  });

  it("a browser that can't: Not available, the line under the row, interrupts off", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await levels();
    expect(await screen.findByText("Not available")).toBeInTheDocument();
    expect(document.querySelector("[data-push-note]")?.textContent).toBe(
      "This browser can't show notifications.",
    );
    expect(
      screen.queryByRole("switch", { name: "Needs you in this browser" }),
    ).toBeNull();
    expect(
      screen.getByText("Browser notifications aren't available here."),
    ).toBeInTheDocument();
    for (const name of ["Interrupt me for", "On lock screens"])
      expect(screen.getByRole("combobox", { name })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeDisabled();
  });

  it("no push key on the server: no browser column at all", async () => {
    server.use(
      // First: server.use's earlier handlers win.
      http.get(`*${R.mePushKey}`, () =>
        HttpResponse.json(
          { error: { code: "push_unavailable", message: "No key" } },
          { status: 404 },
        ),
      ),
      ...createHandlers({ events, forYou: "mixed" }),
    );
    fakePush("default");
    const t = await levels();
    expect(within(t).queryByText("This browser")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Needs you in this browser" }),
    ).toBeNull();
    expect(
      screen.getByText("Browser notifications aren't available here."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "On lock screens" }),
    ).toBeDisabled();
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

describe("quiet hours while Coming later (#2674)", () => {
  const prefs = {
    needsYou: { browser: false },
    quietHours: { start: "22:00", end: "07:30" },
  } as unknown as Parameters<typeof prefsToSave>[0];
  it("a save never sends them on", () => {
    expect(prefsToSave(prefs, false).quietHours).toBeNull();
  });
  it("once live, they are sent as set", () => {
    expect(prefsToSave(prefs, true).quietHours).toEqual({
      start: "22:00",
      end: "07:30",
    });
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

// #2512 slice 2: Settings › Notifications for For you (R.meNotificationPrefs, R.meInboxMutes).
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { thisBrowser } from "../src/settings/ForYouPrefs";
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

const page = async () => {
  mount("/settings/notifications");
  return screen.findByRole(
    "switch",
    { name: "Needs you in this browser" },
    { timeout: FIRST_LOAD_MS },
  );
};

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
    expect(needs).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/^On for .+ on this .+$/)).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText(/away until 07:30/)).toBeInTheDocument();
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

  it("saves the whole prefs in the browser's zone (quiet hours off)", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    const puts = calls("PUT");
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(puts.find((c) => c.path === R.meNotificationPrefs)?.body).toEqual({
        needsYou: { inApp: true, browser: true },
        updates: { inApp: true, browser: false },
        browserAllAsks: false,
        quietHours: null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        lockScreenDetail: false,
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Quiet hours start" }),
    ).toBeDisabled();
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

  it("the browser switch is a stub until slice 3: no permission prompt, no change", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const ask = vi.fn();
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: ask,
    });
    const needs = await page();
    const puts = calls("PUT");
    fireEvent.click(needs);
    await findVisibleToast("Browser notifications are coming soon.");
    expect(needs).toHaveAttribute("aria-checked", "true");
    expect(puts).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
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

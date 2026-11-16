// #2512 slice 2: Settings › Notifications for For you (R.meNotificationPrefs, R.meInboxMutes).
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { prefsToSave, thisBrowser } from "../src/settings/ForYouPrefs";
import { calls, events, installHarness, mount, server } from "./harness";
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
    expect(needs).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toBeDisabled();
    // Design (#2674): drawn off while "Coming later", though the server has them on.
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute(
      "aria-checked",
      "false",
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

  // Design (#2512 slice 2 review): these wait for browser notifications.
  it("quiet hours, interrupts and lock screens wait: disabled under Coming later, nothing saved", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    await page();
    const puts = calls("PUT");
    const box = screen.getByRole("region", { name: "When to interrupt" });
    expect(box).toHaveAccessibleDescription("Coming later");
    for (const name of [
      "Quiet hours start",
      "Quiet hours end",
      "Interrupt me for",
      "On lock screens",
    ])
      expect(screen.getByRole("combobox", { name })).toBeDisabled();
    const quiet = screen.getByRole("switch", { name: "Quiet hours" });
    expect(quiet).toBeDisabled();
    fireEvent.click(quiet);
    await new Promise((r) => setTimeout(r, 50));
    expect(puts.filter((c) => c.path === R.meNotificationPrefs)).toEqual([]);
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

  it("the browser switches wait for slice 3: disabled, Coming later, no prompt", async () => {
    server.use(...createHandlers({ events, forYou: "mixed" }));
    const ask = vi.fn();
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: ask,
    });
    const needs = await page();
    const puts = calls("PUT");
    expect(needs).toBeDisabled();
    expect(needs).toHaveAccessibleDescription("Coming later");
    expect(
      screen.getByRole("switch", { name: "Updates in this browser" }),
    ).toHaveAccessibleDescription("Coming later");
    fireEvent.click(needs);
    expect(puts).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("quiet hours while Coming later (#2674)", () => {
  const prefs = {
    needsYou: { browser: false },
    quietHours: { start: "22:00", end: "07:30" },
  } as unknown as Parameters<typeof prefsToSave>[0];
  it("a save never sends them on", () => {
    expect(prefsToSave(prefs).quietHours).toBeNull();
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

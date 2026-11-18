// #2512 slice 2: Settings › Notifications for For you (R.meNotificationPrefs, R.meInboxMutes).

import type { NotificationPrefs } from "@oa/shared";
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { muteErrorCopy } from "../src/foryou/prefsContract";
import { prefsToSave, thisBrowser } from "../src/settings/ForYouPrefs";
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
    expect(screen.queryByText(/away until/)).toBeNull();
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

  it("an API-set true never shows the browser switches on while they wait (#2769)", async () => {
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
    expect(needs).toBeDisabled();
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

  it("the per-browser switches wait for push: disabled, Coming later, no prompt", async () => {
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

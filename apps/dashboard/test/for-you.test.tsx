// #2512: the bell in the app header and "For you", on the mocks (PROVISIONAL contract).
import { type ForYouItem, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { events, installHarness, mount, seen, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const bell = () =>
  screen.findByRole("button", { name: /^For you/ }, { timeout: FIRST_LOAD_MS });

const forYou = (variant: "mixed" | "calm" | "empty" | "back") =>
  server.use(...createHandlers({ events, forYou: variant }));

describe("the bell", () => {
  it("is hidden on a server without For you", async () => {
    mount("/");
    await screen.findByRole(
      "button",
      { name: "Account menu" },
      { timeout: FIRST_LOAD_MS },
    );
    await waitFor(() =>
      expect(seen.some((u) => u.pathname === R.forYou)).toBe(true),
    );
    expect(screen.queryByRole("button", { name: /^For you/ })).toBeNull();
  });

  it("counts only what needs you, with an accessible name", async () => {
    forYou("mixed");
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you, 2 need you");
    expect(b.querySelector("[data-bell-count]")).toHaveTextContent("2");
    expect(b.querySelector("[data-bell-dot]")).toBeNull();
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
});

describe("For you", () => {
  it("lists Needs you longest wait first, then Updates", async () => {
    forYou("mixed");
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    const needs = within(panel).getByRole("region", { name: "Needs you" });
    const rows = within(needs).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-for-you-item"))).toEqual([
      "fy-ask",
      "fy-machine",
    ]);
    expect(rows[0]).toHaveTextContent("waiting 4 min");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "Review" }),
    ).toBeInTheDocument();
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

  it("shows billing to owners and admins only", async () => {
    const bill: ForYouItem = {
      id: "fy-bill",
      level: "needs",
      kind: "billing",
      title: "Billing item",
      context: "Plan",
      at: new Date().toISOString(),
      read: false,
      audience: "admins",
    };
    const member = (role: string) =>
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role },
        }),
      );
    server.use(
      http.get(`*${R.forYou}`, () =>
        HttpResponse.json({ items: [bill], away: null }),
      ),
      member("member"),
    );
    mount("/");
    const b = await bell();
    expect(b).toHaveAccessibleName("For you");
    fireEvent.click(b);
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(within(panel).queryByText("Billing item")).toBeNull();
    expect(
      within(panel).getByText("You're all caught up."),
    ).toBeInTheDocument();
  });

  it("shows billing to an owner", async () => {
    server.use(
      http.get(`*${R.forYou}`, () =>
        HttpResponse.json({
          items: [
            {
              id: "fy-bill",
              level: "needs",
              kind: "billing",
              title: "Billing item",
              context: "Plan",
              at: new Date().toISOString(),
              read: false,
              audience: "admins",
            },
          ],
          away: null,
        }),
      ),
    );
    mount("/");
    expect(await bell()).toHaveAccessibleName("For you, 1 needs you");
  });

  it("first time with nothing at all: You're all caught up.", async () => {
    forYou("empty");
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    expect(panel).toHaveTextContent(
      "You're all caught up.When an agent asks you something or someone replies to you, it shows here.",
    );
  });

  it("a returned item sits on top, marked, with no Later", async () => {
    forYou("back");
    mount("/");
    fireEvent.click(await bell());
    const panel = await screen.findByRole("dialog", { name: "For you" });
    const row = panel.querySelector('[data-for-you-item="fy-machine"]');
    expect(row).toHaveTextContent("Back from later");
    expect(
      within(row as HTMLElement).queryByRole("button", { name: "Later" }),
    ).toBeNull();
  });
});

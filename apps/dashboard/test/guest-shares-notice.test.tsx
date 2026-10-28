// Parity 2 (A6): the self-hosted owner's one-time notice of guest editor
// shares that became view-only, with a link per artifact and Got it.
import { R } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import {
  calls,
  findVisibleToast,
  installHarness,
  mountHosted,
} from "./harness";

installHarness();

const notice = () =>
  screen.findByRole("list", { name: "Shares that became view-only" });

it("the owner sees each changed share, linked to its artifact", async () => {
  mountHosted("/", { selfHosted: true, guestShares: 2 });
  const list = await notice();
  const items = within(list).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent("Landing page · guest");
  expect(
    within(items[0] as HTMLElement).getByRole("link", { name: "Landing page" }),
  ).toHaveAttribute("href", expect.stringMatching(/^\/a\//));
  expect(screen.getByText("Guests can now only view")).toBeVisible();
  expect(screen.queryByText(/Plus others not listed/)).toBeNull();
});

it("Got it posts the dismiss and hides the notice", async () => {
  const seen = calls("POST");
  mountHosted("/", { selfHosted: true, guestShares: 1 });
  await notice();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("list", { name: "Shares that became view-only" }),
    ).toBeNull(),
  );
  expect(seen.some((c) => c.path === R.noticeDismiss("guest_shares"))).toBe(
    true,
  );
});

it("a failed dismiss toasts and the notice comes back", async () => {
  mountHosted("/", { selfHosted: true, guestShares: 1 }, undefined, [
    http.post(`*${R.noticeDismiss("guest_shares")}`, () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Dismiss failed" } },
        { status: 500 },
      ),
    ),
  ]);
  await notice();
  fireEvent.click(screen.getByRole("button", { name: "Got it" }));
  await findVisibleToast("Dismiss failed");
  expect(await notice()).toBeVisible();
});

it("more than 50 says there are others", async () => {
  mountHosted("/", { selfHosted: true, guestShares: 51 });
  expect(within(await notice()).getAllByRole("listitem")).toHaveLength(50);
  expect(
    screen.getByText(
      "Plus others not listed here. Check Share on your artifacts for other guest editors.",
    ),
  ).toBeVisible();
});

it("hosted: no notice", async () => {
  mountHosted("/", { guestShares: 2 });
  await screen.findAllByText("Landing page");
  expect(
    screen.queryByRole("list", { name: "Shares that became view-only" }),
  ).toBeNull();
});

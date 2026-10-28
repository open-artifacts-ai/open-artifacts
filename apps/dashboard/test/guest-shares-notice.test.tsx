// Parity 2 (A6, Manager's ruling): on Access-only installs, each member's
// one-time notice of guest editor shares on their own artifacts, and the org
// owner's install-wide summary with Transfer for guests who own artifacts.
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

const SHARES = "Your shares that became view-only";
const OWNERS = "Guests who own artifacts";
const shares = () => screen.findByRole("list", { name: SHARES });

it("a member sees each changed share on their artifacts, linked", async () => {
  mountHosted("/", { selfHosted: true, guestShares: 2 });
  const items = within(await shares()).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent("Landing page · guest");
  expect(
    within(items[0] as HTMLElement).getByRole("link", { name: "Landing page" }),
  ).toHaveAttribute("href", expect.stringMatching(/^\/a\//));
  expect(screen.queryByText(/Plus others not listed/)).toBeNull();
});

it("Got it dismisses guest_shares only", async () => {
  const seen = calls("POST");
  mountHosted("/", { selfHosted: true, guestShares: 1 });
  await shares();
  const summary = await screen.findByText(
    "Guests can now only view, everywhere on this instance",
  );
  const own = (await shares()).closest("[data-slot=alert]") as HTMLElement;
  fireEvent.click(within(own).getByRole("button", { name: "Got it" }));
  await waitFor(() =>
    expect(screen.queryByRole("list", { name: SHARES })).toBeNull(),
  );
  expect(summary).toBeVisible();
  expect(seen.map((c) => c.path)).toContain(R.noticeDismiss("guest_shares"));
  expect(seen.map((c) => c.path)).not.toContain(
    R.noticeDismiss("guest_summary"),
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
  const own = (await shares()).closest("[data-slot=alert]") as HTMLElement;
  fireEvent.click(within(own).getByRole("button", { name: "Got it" }));
  await findVisibleToast("Dismiss failed");
  expect(await shares()).toBeVisible();
});

it("more than 50 says there are others", async () => {
  mountHosted("/", { selfHosted: true, guestShares: 51 });
  expect(within(await shares()).getAllByRole("listitem")).toHaveLength(50);
  expect(
    screen.getByText(
      "Plus others not listed here. Check Share on your artifacts.",
    ),
  ).toBeVisible();
});

it("the owner's summary: counts, and Transfer for a guest who owns artifacts", async () => {
  const seen = calls("POST");
  mountHosted("/", { selfHosted: true, guestShares: 2, guestOwners: 1 });
  expect(
    await screen.findByText(
      "2 guest shares with edit access, on 1 person's artifacts, now work as view-only. Each of those people sees their own list.",
    ),
  ).toBeVisible();
  const owners = await screen.findByRole("list", { name: OWNERS });
  expect(owners).toHaveTextContent("owner1@outside.example · 1 artifact");
  fireEvent.click(
    within(owners).getByRole("button", {
      name: "Transfer owner1@outside.example's artifacts",
    }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Transfer owner1@outside.example's 1 personal artifact",
  });
  fireEvent.click(within(d).getByRole("combobox", { name: "Give them to" }));
  fireEvent.click(await screen.findByRole("option", { name: "Bob Builder" }));
  fireEvent.click(within(d).getByRole("button", { name: "Transfer 1" }));
  await waitFor(() =>
    expect(
      seen.find((c) => c.path === R.memberTransfer("Go0001AbCdEfGhIj"))?.body,
    ).toEqual({ to: { kind: "user", userId: "Bc4eFgHjKm5nPqRs" } }),
  );
});

it("direct sign-in (not Access-only) and hosted: no notices", async () => {
  mountHosted("/", { selfHosted: true, mode: "direct", guestShares: 2 });
  await screen.findAllByText("Landing page");
  expect(screen.queryByRole("list", { name: SHARES })).toBeNull();
  expect(screen.queryByText(/everywhere on this instance/)).toBeNull();
});

it("hosted: no notices", async () => {
  mountHosted("/", { guestShares: 2, guestOwners: 1 });
  await screen.findAllByText("Landing page");
  expect(screen.queryByRole("list", { name: SHARES })).toBeNull();
  expect(screen.queryByRole("list", { name: OWNERS })).toBeNull();
});

// Directory connect confirm step (Backend P3 T12, #564; Design's recommended
// copy): a pre-Google dialog with no count, then pending_confirm asks "Add N
// people?" before anyone is added. Confirm, Cancel, an expired confirmation
// (409) and nothing pending (404).
import { R } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { calls, installHarness, mountHosted } from "./harness";

installHarness();

const EXPIRES = "2026-10-26T15:30:00.000Z";
const BASE = {
  mode: "google",
  healthy: null,
  unhealthySince: null,
  lastError: null,
  nextRunAt: null,
  alertedAt: null,
  customerMismatch: null,
  held: [],
  lastSuccessAt: null,
  staleAt: null,
  binding: {
    provider: "google",
    customerId: "C01abc",
    domain: "example.com",
    connectedBy: "ada@example.com",
    connectedAt: "2026-10-25T15:30:00.000Z",
  },
};
const PENDING = {
  ...BASE,
  state: "pending_confirm",
  pendingCount: 12,
  pendingCountCapped: false,
  pendingExpiresAt: EXPIRES,
};
const OFF = {
  ...BASE,
  mode: "off",
  state: "never",
  binding: null,
  pendingCount: null,
  pendingCountCapped: false,
  pendingExpiresAt: null,
};
const status = () => screen.findByRole("status", { name: "Sync status" });
/** GET /directory answers `first`, then `next` once `flip()` is called. */
const serve = (first: object, nextBody?: object) => {
  let flipped = false;
  return {
    flip: () => {
      flipped = true;
    },
    handler: http.get("*/api/v1/directory", () =>
      HttpResponse.json(flipped && nextBody ? nextBody : first),
    ),
  };
};
// The row date rule: no year when it's this year.
const expiryText = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  ...(new Date(EXPIRES).getFullYear() === new Date().getFullYear()
    ? {}
    : { year: "numeric" }),
  hour: "numeric",
  minute: "2-digit",
}).format(new Date(EXPIRES));

it("Connect opens the pre-Google dialog: no count, Cancel and Continue to Google", async () => {
  mountHosted("/settings/directory", { directory: "off" });
  fireEvent.click(
    within(await status()).getByRole("button", {
      name: "Connect Google Workspace",
    }),
  );
  const d = await screen.findByRole("dialog", {
    name: "Connect Google Workspace",
  });
  expect(d).toHaveTextContent(
    "Connecting adds everyone active in your Google directory in example.com as a member of Acme Artifacts.",
  );
  expect(d).toHaveTextContent(
    "You'll see how many people before anything changes.",
  );
  const go = within(d).getByRole("link", { name: "Continue to Google" });
  expect(go).toHaveAttribute("href", R.directoryConnect);
  expect(within(d).getByRole("button", { name: "Cancel" })).toBeVisible();
});

it("pending_confirm: Add N people?, the domain, the expiry in your zone, Cancel and Add N people", async () => {
  const s = serve(PENDING);
  mountHosted("/settings/directory", true, undefined, [s.handler]);
  const h = await status();
  expect(within(h).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Add 12 people?",
  );
  expect(h).toHaveTextContent(
    "This adds 12 people from example.com as members. They can sign in with Google right away.",
  );
  expect(h).toHaveTextContent(`Confirm by ${expiryText}, or connect again.`);
  expect(within(h).getByRole("button", { name: "Cancel" })).toBeVisible();
  expect(
    within(h).getByRole("button", { name: "Add 12 people" }),
  ).toBeVisible();
  // Cancel is the way out while pending: no Connection card or Disconnect.
  expect(screen.queryByRole("region", { name: "Connection" })).toBeNull();
});

it("one person: singular throughout", async () => {
  const s = serve({ ...PENDING, pendingCount: 1 });
  mountHosted("/settings/directory", true, undefined, [s.handler]);
  const h = await status();
  expect(within(h).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Add 1 person?",
  );
  expect(h).toHaveTextContent(
    "This adds 1 person from example.com as a member. They can sign in with Google right away.",
  );
  expect(within(h).getByRole("button", { name: "Add 1 person" })).toBeVisible();
});

it("a non-owner waits for the owner: named, the expiry, no buttons", async () => {
  const s = serve(PENDING);
  mountHosted(
    "/settings/directory",
    true,
    (m) => ({ ...m, user: { ...m.user, role: "admin" } }),
    [s.handler],
  );
  const h = await status();
  expect(within(h).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Waiting for the owner to confirm",
  );
  expect(h).toHaveTextContent(
    "Ada Lovelace needs to confirm who to add. Nobody is added until then.",
  );
  expect(h).toHaveTextContent(`Expires ${expiryText}.`);
  expect(h.textContent).not.toMatch(/Confirm by/);
  expect(within(h).queryByRole("button")).toBeNull();
});

it("capped: Add 500+ people?, more than 500 people, Add people", async () => {
  const s = serve({ ...PENDING, pendingCount: 500, pendingCountCapped: true });
  mountHosted("/settings/directory", true, undefined, [s.handler]);
  const h = await status();
  expect(within(h).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Add 500+ people?",
  );
  expect(h).toHaveTextContent(
    "This adds more than 500 people from example.com as members.",
  );
  expect(within(h).getByRole("button", { name: "Add people" })).toBeVisible();
});

it("Confirm posts and shows the new status", async () => {
  const posts = calls("POST");
  const NEVER = {
    ...PENDING,
    state: "never",
    pendingCount: null,
    pendingExpiresAt: null,
  };
  const s = serve(PENDING, NEVER);
  mountHosted("/settings/directory", true, undefined, [
    s.handler,
    http.post("*/api/v1/directory/confirm", () => {
      s.flip();
      return HttpResponse.json(NEVER);
    }),
  ]);
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Add 12 people" }),
  );
  await waitFor(() =>
    expect(posts.some((c) => c.path === R.directoryConfirm)).toBe(true),
  );
  await waitFor(async () =>
    expect(
      within(await status()).getByRole("heading", { level: 2 }),
    ).toHaveTextContent("Not synced yet"),
  );
});

it("Cancel posts and says nobody was added, with Connect again", async () => {
  const posts = calls("POST");
  const s = serve(PENDING, OFF);
  mountHosted("/settings/directory", true, undefined, [
    s.handler,
    http.post("*/api/v1/directory/cancel", () => {
      s.flip();
      return new HttpResponse(null, { status: 204 });
    }),
  ]);
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Cancel" }),
  );
  await waitFor(() =>
    expect(posts.some((c) => c.path === R.directoryCancel)).toBe(true),
  );
  expect(
    await screen.findByText("Not connected. Nobody was added."),
  ).toBeVisible();
  expect(
    within(await status()).getByRole("button", {
      name: "Connect Google Workspace",
    }),
  ).toBeVisible();
});

it("409 conflict: expired, back to Connect with the warning", async () => {
  const s = serve(PENDING, OFF);
  mountHosted("/settings/directory", true, undefined, [
    s.handler,
    http.post("*/api/v1/directory/confirm", () => {
      s.flip();
      return HttpResponse.json(
        { error: { code: "conflict", message: "expired" } },
        { status: 409 },
      );
    }),
  ]);
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Add 12 people" }),
  );
  expect(
    await screen.findByText(
      "This confirmation expired after 24 hours. Connect again to see the current count.",
    ),
  ).toBeVisible();
  expect(
    within(await status()).getByRole("button", {
      name: "Connect Google Workspace",
    }),
  ).toBeVisible();
});

it("404: nothing pending any more, so the status is fetched again", async () => {
  const gets = calls("GET");
  const s = serve(PENDING, OFF);
  mountHosted("/settings/directory", true, undefined, [
    s.handler,
    http.post("*/api/v1/directory/confirm", () => {
      s.flip();
      return HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      );
    }),
  ]);
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Add 12 people" }),
  );
  await waitFor(async () =>
    expect(
      within(await status()).getByRole("heading", { level: 2 }),
    ).toHaveTextContent("Not connected"),
  );
  expect(gets.filter((c) => c.path === R.directory).length).toBeGreaterThan(1);
  expect(screen.queryByText(/expired/)).toBeNull();
});

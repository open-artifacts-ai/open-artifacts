// Hosted P4 Tasks 17 and 18: /settings/directory, Design D12 B (status first),
// copy from the build spec t6cjQuskQ6zrZaJd v5 (lost sync freezes access, no
// deadline: staleAt is never shown).
import { type Me, R } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, it, onTestFinished, vi } from "vitest";
import { calls, installHarness, lastClient, mountHosted } from "./harness";

installHarness();

const asAdmin = (m: Me): Me => ({ ...m, user: { ...m.user, role: "admin" } });

const STATUS = {
  mode: "google",
  healthy: true,
  state: "ok",
  unhealthySince: null,
  lastError: null,
  nextRunAt: null,
  alertedAt: null,
  customerMismatch: null,
  held: [],
  binding: {
    provider: "google",
    customerId: "C01abc",
    domain: "example.com",
    connectedBy: "ada@example.com",
    connectedAt: "2026-10-01T09:00:00.000Z",
  },
  lastSuccessAt: "2026-10-20T09:00:00.000Z",
  staleAt: "2026-10-27T09:00:00.000Z",
};
const serveStatus = (o: object) => [
  http.get("*/api/v1/directory", () => HttpResponse.json({ ...STATUS, ...o })),
];
const status = () => screen.findByRole("status", { name: "Sync status" });

// -- Task 17: header, connect, Sync now, disconnect

it("owner sees a healthy header, the domain and the connection", async () => {
  mountHosted("/settings/directory");
  const s = await status();
  expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Healthy",
  );
  expect(s).toHaveTextContent(/example\.com · last synced /);
  const conn = screen.getByRole("region", { name: "Connection" });
  expect(within(conn).getByText("Workspace").nextSibling).toHaveTextContent(
    "example.com",
  );
  expect(within(conn).getByText("Connected by").nextSibling).toHaveTextContent(
    /^ada@example\.com on /,
  );
});

it("the last sync time is exact on hover and for screen readers", async () => {
  mountHosted("/settings/directory", true, undefined, serveStatus({}));
  const s = await status();
  const t = s.querySelector("time")!;
  expect(t).toHaveAttribute("dateTime", "2026-10-20T09:00:00.000Z");
  expect(t.getAttribute("title")).toMatch(/Oct 20, 2026/);
});

it("staleAt is never shown: no deadline, access is frozen as of the last sync", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      healthy: false,
      state: "backoff",
      unhealthySince: "2026-10-20T10:00:00.000Z",
      lastError: {
        at: "2026-10-20T12:00:00.000Z",
        message: "Google returned 503",
      },
    }),
  );
  const s = await status();
  expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Retrying",
  );
  expect(s).toHaveTextContent(/^.*Failing since .+\(.+\)\./);
  expect(s).toHaveTextContent(
    /Access is frozen as of the last sync \(.+\)\. Changes in Google, including people who left, won't apply here until sync recovers\./,
  );
  expect(s).toHaveTextContent(
    "Nobody loses access while sync is down. While sync is down, people sign in again every 24 hours.",
  );
  expect(s).not.toHaveTextContent("After 24 hours");
  expect(s).toHaveTextContent("Last error: Google returned 503.");
  expect(document.body.textContent).not.toMatch(
    /Oct 27|lose access by|recover by/,
  );
});

/** What a sighted reader sees: the text without the screen-reader-only copies. */
const seen = (el: HTMLElement) => {
  const c = el.cloneNode(true) as HTMLElement;
  for (const n of c.querySelectorAll(".sr-only")) n.remove();
  return c.textContent ?? "";
};
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", o).format(new Date(iso));

it("times from another day show the date: frozen as of, failing since", async () => {
  const day = "2026-10-20T04:44:00.000Z";
  const since = "2026-10-20T06:10:00.000Z";
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      healthy: false,
      state: "backoff",
      unhealthySince: since,
      lastSuccessAt: day,
    }),
  );
  const s = await status();
  const dayTime = (iso: string) =>
    fmt(iso, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  expect(seen(s)).toContain(`Failing since ${dayTime(since)} (`);
  expect(seen(s)).toContain(
    `Access is frozen as of the last sync (${dayTime(day)}).`,
  );
  expect(dayTime(day)).toMatch(/^Oct 20, /);
});

it("times from today show the time only", async () => {
  // Local midday, so "a minute ago" is always today. Only Date is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  vi.setSystemTime(noon);
  const now = Date.now();
  const today = new Date(now - 60_000).toISOString();
  const since = new Date(now - 30_000).toISOString();
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      healthy: false,
      state: "backoff",
      unhealthySince: since,
      lastSuccessAt: today,
    }),
  );
  const s = await status();
  const time = (iso: string) =>
    fmt(iso, { hour: "numeric", minute: "2-digit" });
  expect(seen(s)).toContain(`Failing since ${time(since)} (`);
  expect(seen(s)).toContain(
    `Access is frozen as of the last sync (${time(today)}).`,
  );
  expect(seen(s)).not.toContain(fmt(today, { month: "short", day: "numeric" }));
});

it("frozen from another day: kept as of the date and time", async () => {
  const day = "2026-10-20T04:44:00.000Z";
  mountHosted(
    "/settings/directory",
    { directory: "frozen" },
    undefined,
    serveStatus({ mode: "frozen", lastSuccessAt: day }),
  );
  const s = await status();
  expect(seen(s)).toContain(
    `Space memberships were kept as of ${fmt(day, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} and are managed manually.`,
  );
});

it("unhealthy (mock): Retrying, the last error and the tokens line", async () => {
  mountHosted("/settings/directory", { unhealthy: true });
  const s = await status();
  expect(s).toHaveTextContent("Retrying");
  expect(s).toHaveTextContent("Google returned 503");
  expect(s).toHaveTextContent(
    "Agent tokens aren't being re-checked. If someone left, remove them in Members.",
  );
  expect(within(s).getByRole("button", { name: "Sync now" })).toBeEnabled();
});

it.each([
  [
    "auth_failed",
    "Google access lost",
    /Our connection to Google was revoked or expired on .+\./,
    "Reconnect with a Google super admin account.",
  ],
  [
    "scope_missing",
    "Permission removed",
    /A permission we need was removed in Google on .+\./,
    "Reconnect and allow every permission Google asks for.",
  ],
])(
  "%s: label, cause, Reconnect and the frozen line",
  async (state, label, cause, fix) => {
    mountHosted(
      "/settings/directory",
      true,
      undefined,
      serveStatus({
        healthy: false,
        state,
        unhealthySince: "2026-10-20T13:12:00.000Z",
      }),
    );
    const s = await status();
    expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
      label,
    );
    expect(s).toHaveTextContent(cause);
    expect(s).toHaveTextContent(fix);
    expect(s).toHaveTextContent(
      /Access is frozen as of the last sync \(.+\)\. Changes in Google, including people who left, won't apply here until you reconnect\./,
    );
    expect(within(s).getByRole("link", { name: "Reconnect" })).toHaveAttribute(
      "href",
      R.directoryConnect,
    );
    expect(within(s).queryByRole("button", { name: "Sync now" })).toBeNull();
  },
);

it("the mock's scope_missing state reaches the header", async () => {
  mountHosted("/settings/directory", {
    unhealthy: true,
    unhealthyState: "scope_missing",
  });
  expect(
    within(await status()).getByRole("heading", { level: 2 }),
  ).toHaveTextContent("Permission removed");
});

it("a customer mismatch shows both ids to the owner", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      healthy: false,
      state: "customer_mismatch",
      customerMismatch: { expected: "C01abc", actual: "C09xyz" },
    }),
  );
  const s = await status();
  expect(s).toHaveTextContent("Wrong Google Workspace");
  expect(s).toHaveTextContent(
    "Sync stopped: the connection now points to a different organization.",
  );
  expect(s).toHaveTextContent(
    "Connected: customer C01abc. Now: C09xyz. Nothing was changed. Reconnect with the example.com Google Workspace, as a super admin.",
  );
});

it.each(["auth_failed", "scope_missing"] as const)(
  "admins in %s: ask the owner to reconnect or disconnect, no buttons",
  async (state) => {
    mountHosted(
      "/settings/directory",
      true,
      asAdmin,
      serveStatus({ healthy: false, state }),
    );
    const s = await status();
    expect(s).toHaveTextContent(
      "Ask the owner, Ada Lovelace, to reconnect or disconnect.",
    );
    expect(screen.queryByRole("link", { name: "Reconnect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  },
);

it("admins see a customer mismatch without the ids", async () => {
  mountHosted(
    "/settings/directory",
    true,
    asAdmin,
    serveStatus({
      healthy: false,
      state: "customer_mismatch",
      customerMismatch: { expected: "C01abc", actual: "C09xyz" },
    }),
  );
  const s = await status();
  expect(s).toHaveTextContent("Wrong Google Workspace");
  expect(s).not.toHaveTextContent("C01abc");
  expect(s).not.toHaveTextContent("C09xyz");
  expect(within(s).queryByRole("link", { name: "Reconnect" })).toBeNull();
  expect(s).toHaveTextContent(
    "Ask the owner, Ada Lovelace, to reconnect or disconnect.",
  );
});

it("not synced yet", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({ healthy: null, state: "never", lastSuccessAt: null }),
  );
  const s = await status();
  expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Not synced yet",
  );
  expect(s).toHaveTextContent(/example\.com · first sync started /);
  expect(within(s).queryByRole("button", { name: "Sync now" })).toBeNull();
});

it("mode off: the owner connects through a full-page link", async () => {
  mountHosted("/settings/directory", { directory: "off" });
  const s = await status();
  expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Not connected",
  );
  expect(s).toHaveTextContent(
    "Connect your Google Workspace so space access follows your Google groups.",
  );
  expect(s).toHaveTextContent(
    "Read-only access to your users, groups, domains and admin activity log. We never change anything in Google.",
  );
  expect(s).toHaveTextContent(
    "The connecting account must be a Google super admin.",
  );
  // Connect first explains (no count yet), then goes to Google (#564).
  fireEvent.click(
    within(s).getByRole("button", { name: "Connect Google Workspace" }),
  );
  const link = within(await screen.findByRole("dialog")).getByRole("link", {
    name: "Continue to Google",
  });
  expect(link).toHaveAttribute("href", "/api/v1/directory/connect");
  fireEvent.click(link);
  expect(link).toHaveTextContent("Opening Google…");
  expect(screen.queryByRole("region", { name: "Connection" })).toBeNull();
});

it("mode off: admins are told only the owner can connect", async () => {
  mountHosted("/settings/directory", { directory: "off" }, asAdmin);
  const s = await status();
  expect(s).toHaveTextContent(
    "Only the owner, Ada Lovelace, can connect Google Workspace.",
  );
  expect(within(s).queryByRole("link")).toBeNull();
});

it("frozen: kept memberships, no Sync now, no Disconnect", async () => {
  mountHosted("/settings/directory", { directory: "frozen" });
  const s = await status();
  expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Frozen",
  );
  expect(s).toHaveTextContent(
    /Space memberships were kept as of .+ and are managed manually\./,
  );
  expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/comes back|turns back on/);
});

it("admins see the header without buttons, and who can act", async () => {
  mountHosted("/settings/directory", true, asAdmin);
  const s = await status();
  expect(s).toHaveTextContent(
    "Only the owner, Ada Lovelace, can run a sync, apply held changes or disconnect.",
  );
  for (const name of ["Sync now", "Disconnect"])
    expect(screen.queryByRole("button", { name })).toBeNull();
});

it("?connected=1 shows success", async () => {
  mountHosted("/settings/directory?connected=1");
  expect(await screen.findByText("Google Workspace connected.")).toBeVisible();
  expect(
    screen.getByText(
      "The first sync is running. It usually takes a few minutes.",
    ),
  ).toBeVisible();
});

it.each([
  [
    "not_super_admin",
    "Connect with a Google super admin account. Other accounts can't see every group.",
  ],
  [
    "domain_mismatch",
    "That Google Workspace isn't example.com. Sign in with a example.com super admin.",
  ],
  [
    "customer_mismatch",
    "That Google Workspace belongs to a different organization. Reconnect the one you connected before.",
  ],
  [
    "scopes",
    "Allow every requested permission, then try again. It's read-only: we never change anything in Google.",
  ],
  ["denied", "Google access was declined. Nothing was connected."],
  ["expired", "The connection took too long. Try again."],
  ["failed", null],
])("?error=%s", async (error, copy) => {
  mountHosted(`/settings/directory?error=${error}`);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't connect Google Workspace.");
  if (copy) expect(alert).toHaveTextContent(copy);
  else expect(alert).not.toHaveTextContent("Try again.");
  expect(
    within(alert).getByRole("link", { name: "Try again" }),
  ).toHaveAttribute("href", R.directoryConnect);
});

it("an unknown ?error= shows only the title and is never echoed", async () => {
  mountHosted("/settings/directory?error=%3Cimg%20src%3Dx%3E");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't connect Google Workspace.",
  );
  expect(document.body.innerHTML).not.toContain("<img src=x>");
  expect(document.body.textContent).not.toContain("img src");
});

it("dismissing the connect error clears the query", async () => {
  const router = mountHosted("/settings/directory?error=denied");
  const alert = await screen.findByRole("alert");
  fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(router.state.location.href).toBe("/settings/directory"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("Sync now POSTs, then shows Syncing… until the status changes", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory");
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Sync now" }),
  );
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory/sync"));
  const s = await status();
  await waitFor(() =>
    expect(within(s).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Syncing…",
    ),
  );
  expect(s).toHaveTextContent("example.com · started just now");
});

it("Sync now while sync is off: the copy under the header, no link", async () => {
  mountHosted("/settings/directory", true, undefined, [
    http.post("*/api/v1/directory/sync", () =>
      HttpResponse.json(
        { error: { code: "directory_sync_off", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await status()).getByRole("button", { name: "Sync now" }),
  );
  expect(
    await screen.findAllByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("link", { name: "Open directory settings" }),
  ).toBeNull();
  expect(screen.queryByText("server text")).toBeNull();
});

it("Disconnect warns that memberships freeze and nobody loses access", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/directory");
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Disconnect Google Workspace?");
  expect(d).toHaveTextContent(
    "Sync stops. Space memberships stay as they are and are managed manually. Nobody loses access.",
  );
  expect(d).toHaveTextContent(
    "People who leave in Google keep their access here until you remove them in Members. Restricted groups stay in force until you lift them.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe("/api/v1/directory"));
});

it("reauth_required offers a fresh Google sign-in back to this page", async () => {
  mountHosted("/settings/directory", true, undefined, [
    http.get("*/api/v1/directory", () =>
      HttpResponse.json(
        { error: { code: "reauth_required", message: "Sign in again" } },
        { status: 401 },
      ),
    ),
  ]);
  expect(
    await screen.findByRole("heading", { name: "Sign in again to continue" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "For your security, sign in with Google again to manage the directory.",
    ),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Sign in with Google again" }),
  ).toHaveAttribute("href", "/auth/login/google?next=%2Fsettings%2Fdirectory");
  expect(
    screen.getByText(
      "You'll come straight back here. It's needed while sync is down.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("status", { name: "Sync status" })).toBeNull();
  expect(
    screen.queryByRole("link", { name: "Continue with Cloudflare Access" }),
  ).toBeNull();
  expect(lastClient.getQueryState(["me"])?.status).toBe("success");
});

it("the Directory tab shows for owners and admins on a hosted instance", async () => {
  mountHosted("/settings/profile");
  expect(
    await screen.findByRole("link", { name: /^Directory/ }),
  ).toHaveAttribute("href", "/settings/directory");
});

it("members are sent away from /settings/directory", async () => {
  const router = mountHosted("/settings/directory", true, (m) => ({
    ...m,
    user: { ...m.user, role: "member" },
  }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/agents"),
  );
});

// -- Task 18: held sweeps and restricted groups

const held = () =>
  screen.findByRole("region", { name: "Waiting for your confirmation" });

it("a held sweep says how many would lose access and why", async () => {
  mountHosted("/settings/directory");
  const h = await held();
  expect(h).toHaveTextContent(
    "These changes from Google would remove a lot of people at once, so we held them. Nobody loses access until you apply one.",
  );
  expect(h).toHaveTextContent("Sales (sales@example.com)");
  expect(h).toHaveTextContent(
    /4 of 4 members would lose access · Google lists the group as empty · since /,
  );
});

it("a partial held sweep names the other reason", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      held: [
        {
          groupId: "gEng01",
          email: "eng@example.com",
          name: "Engineering",
          wouldRemove: 6,
          members: 10,
          since: "2026-10-20T09:12:00.000Z",
        },
      ],
    }),
  );
  expect(await held()).toHaveTextContent(
    /6 of 10 members would lose access · more than half the group · since /,
  );
});

it("no held sweeps: no region", async () => {
  mountHosted("/settings/directory", true, undefined, serveStatus({}));
  await status();
  expect(
    screen.queryByRole("region", { name: "Waiting for your confirmation" }),
  ).toBeNull();
});

it("the owner applies a held sweep", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory");
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Apply Sales" }),
  );
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Remove 4 people from Sales?");
  expect(d).toHaveTextContent(
    "Google lists sales@example.com as empty. Applying this takes away what Sales gives them in spaces, within a minute. Their artifacts stay where they are.",
  );
  expect(d).toHaveTextContent(
    "If this looks wrong, fix the group in Google Admin and leave it waiting.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Remove 4 people" }));
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe("/api/v1/directory/held/gSales03/confirm"),
  );
});

it("Cancel leaves the sweep waiting", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory");
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Apply Sales" }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(seen).toHaveLength(0);
  expect(await held()).toBeVisible();
});

it("a held sweep on a restricted group says it lifts the restriction", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      held: [
        {
          groupId: "gCon04",
          email: "contractors@example.com",
          name: "Contractors",
          wouldRemove: 1,
          members: 1,
          since: "2026-10-20T09:12:00.000Z",
        },
      ],
    }),
  );
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Apply Contractors" }),
  );
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent(
    "Applying this lifts the restriction for 1 person.",
  );
  expect(
    within(d).getByRole("button", { name: "Remove 1 person" }),
  ).toBeVisible();
});

it("admins see held sweeps but can't apply them", async () => {
  mountHosted("/settings/directory", true, asAdmin);
  const h = await held();
  expect(within(h).queryByRole("button", { name: /^Apply/ })).toBeNull();
});

it("restricted groups list Contractors and add through the group picker", async () => {
  const seen = calls("PUT");
  mountHosted("/settings/directory");
  const r = await screen.findByRole("region", { name: "Restricted groups" });
  expect(r).toHaveTextContent(
    "People in these groups can only view, everywhere: no publishing, editing or live-data writes.",
  );
  expect(
    await within(r).findByRole("row", {
      name: /contractors@example.com · 1 person/,
    }),
  ).toBeVisible();
  fireEvent.change(
    within(r).getByRole("combobox", { name: "Add a restricted group" }),
    { target: { value: "sa" } },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: /sales@example.com/ }),
  );
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(
      "/api/v1/directory/restricted-groups/gSales03",
    ),
  );
});

it("the group picker searches from 2 characters and is keyboard driven", async () => {
  mountHosted("/settings/directory");
  const box = await screen.findByRole("combobox", {
    name: "Add a restricted group",
  });
  fireEvent.change(box, { target: { value: "s" } });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(box, { target: { value: "sa" } });
  const opt = await screen.findByRole("option", { name: /sales@example.com/ });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(box).toHaveAttribute("aria-activedescendant", opt.id);
  fireEvent.keyDown(box, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("Lift asks first, then DELETEs", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/directory");
  const row = await screen.findByRole("row", {
    name: /contractors@example.com/,
  });
  fireEvent.click(
    within(row).getByRole("button", {
      name: "Lift restriction on Contractors",
    }),
  );
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Lift the Contractors restriction?");
  expect(d).toHaveTextContent(
    "1 person gets back the roles their spaces and groups give them. Anyone restricted manually stays restricted.",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Lift restriction" }));
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(
      "/api/v1/directory/restricted-groups/gCon04",
    ),
  );
});

it("Lift is a real button styled like Apply", async () => {
  mountHosted("/settings/directory");
  const row = await screen.findByRole("row", {
    name: /contractors@example.com/,
  });
  const lift = within(row).getByRole("button", {
    name: "Lift restriction on Contractors",
  });
  const apply = within(await held()).getByRole("button", {
    name: "Apply Sales",
  });
  expect(lift.className).toBe(apply.className);
});

it("admins manage restricted groups too", async () => {
  mountHosted("/settings/directory", true, asAdmin);
  const row = await screen.findByRole("row", {
    name: /contractors@example.com/,
  });
  expect(
    within(row).getByRole("button", {
      name: "Lift restriction on Contractors",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Add a restricted group" }),
  ).toBeVisible();
});

it("frozen: no new restricted groups, but an existing one can be lifted", async () => {
  const seen = calls("DELETE");
  mountHosted("/settings/directory", { directory: "frozen" });
  const row = await screen.findByRole("row", {
    name: /contractors@example.com/,
  });
  expect(
    screen.queryByRole("combobox", { name: "Add a restricted group" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Adding restricted groups needs group sync (Business). To restrict one person, use Members.",
    ),
  ).toBeVisible();
  fireEvent.click(
    within(row).getByRole("button", {
      name: "Lift restriction on Contractors",
    }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Lift restriction",
    }),
  );
  await waitFor(() =>
    expect(seen.at(-1)?.path).toBe(
      "/api/v1/directory/restricted-groups/gCon04",
    ),
  );
});

it("adding a restricted group while off shows the copy inline, not as a toast", async () => {
  mountHosted("/settings/directory", true, undefined, [
    http.put("*/api/v1/directory/restricted-groups/:g", () =>
      HttpResponse.json(
        { error: { code: "directory_sync_off", message: "server text" } },
        { status: 409 },
      ),
    ),
  ]);
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Add a restricted group" }),
    { target: { value: "sa" } },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: /sales@example.com/ }),
  );
  const r = screen.getByRole("region", { name: "Restricted groups" });
  expect(
    await within(r).findByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toBeVisible();
  expect(
    screen.getAllByText(
      "Directory sync is off, so this isn't available right now.",
    ),
  ).toHaveLength(1);
});

it("no copy contains an em dash", async () => {
  vi.useRealTimers();
  mountHosted("/settings/directory", { unhealthy: true });
  await held();
  expect(document.body.textContent).not.toContain("—");
});

// -- #412: snooze a held sweep

const SNOOZED = {
  groupId: "gEng01",
  email: "eng@example.com",
  name: "Engineering",
  wouldRemove: 6,
  members: 10,
  since: "2026-10-20T09:12:00.000Z",
  snoozedUntil: "2026-11-19T09:12:00.000Z",
  snoozeReason: "Admin is fixing the group",
};
const snoozedStatus = (o: object = {}) =>
  serveStatus({ held: [{ ...SNOOZED, ...o }] });
const snoozeRoute = "/api/v1/directory/held/gSales03/snooze";

it("the owner sees Snooze and Apply on a held row", async () => {
  mountHosted("/settings/directory");
  const h = await held();
  expect(within(h).getByRole("button", { name: "Snooze Sales" })).toBeVisible();
  expect(within(h).getByRole("button", { name: "Apply Sales" })).toBeVisible();
});

it("an admin sees no Snooze", async () => {
  mountHosted("/settings/directory", true, asAdmin);
  const h = await held();
  expect(within(h).queryByRole("button", { name: /^Snooze/ })).toBeNull();
});

it("Snooze posts the reason and refetches the status", async () => {
  const seen = calls("POST");
  let statusReads = 0;
  mountHosted("/settings/directory", true, undefined, [
    http.get("*/api/v1/directory", () => {
      statusReads++;
      return HttpResponse.json({
        ...STATUS,
        held: [
          {
            groupId: "gSales03",
            email: "sales@example.com",
            name: "Sales",
            wouldRemove: 4,
            members: 4,
            since: "2026-10-20T09:12:00.000Z",
          },
        ],
      });
    }),
    http.post(`*${snoozeRoute}`, () => HttpResponse.json(STATUS)),
  ]);
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Snooze Sales" }),
  );
  const d = screen.getByRole("alertdialog");
  expect(d).toHaveTextContent("Snooze Sales?");
  expect(d).toHaveTextContent(
    "Snooze until the group changes. Nobody loses access while it's snoozed. It comes back if Google's membership for this group changes, or after 30 days.",
  );
  const before = statusReads;
  fireEvent.change(within(d).getByLabelText("Reason (optional)"), {
    target: { value: "Admin is fixing the group" },
  });
  fireEvent.click(within(d).getByRole("button", { name: "Snooze" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe(snoozeRoute));
  await waitFor(() =>
    expect(seen.at(-1)?.body).toEqual({
      reason: "Admin is fixing the group",
    }),
  );
  await waitFor(() => expect(statusReads).toBeGreaterThan(before));
});

it("Snooze with the field empty sends no reason", async () => {
  const seen = calls("POST");
  mountHosted("/settings/directory", true, undefined, [
    http.post(`*${snoozeRoute}`, () => HttpResponse.json(STATUS)),
  ]);
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Snooze Sales" }),
  );
  const d = screen.getByRole("alertdialog");
  expect(within(d).getByLabelText("Reason (optional)")).toHaveAttribute(
    "maxLength",
    "200",
  );
  fireEvent.click(within(d).getByRole("button", { name: "Snooze" }));
  await waitFor(() => expect(seen.at(-1)?.path).toBe(snoozeRoute));
  await waitFor(() => expect(seen.at(-1)?.body).toBeUndefined());
});

it("a snoozed row shows when it ends and why; Unsnooze sends DELETE; Apply still works", async () => {
  const dels = calls("DELETE");
  const posts = calls("POST");
  mountHosted("/settings/directory", true, undefined, [
    ...snoozedStatus(),
    http.delete("*/api/v1/directory/held/gEng01/snooze", () =>
      HttpResponse.json(STATUS),
    ),
    http.post("*/api/v1/directory/held/gEng01/confirm", () =>
      HttpResponse.json(STATUS),
    ),
  ]);
  const h = await held();
  expect(h).toHaveTextContent(/Snoozed until /);
  expect(h).toHaveTextContent("“Admin is fixing the group”");
  expect(h).toHaveTextContent("Snoozed holds don't light the Settings dot.");
  expect(
    within(h).queryByRole("button", { name: "Snooze Engineering" }),
  ).toBeNull();
  fireEvent.click(
    within(h).getByRole("button", { name: "Unsnooze Engineering" }),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() =>
    expect(dels.at(-1)?.path).toBe("/api/v1/directory/held/gEng01/snooze"),
  );
  fireEvent.click(within(h).getByRole("button", { name: "Apply Engineering" }));
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: /^Remove/,
    }),
  );
  await waitFor(() =>
    expect(posts.at(-1)?.path).toBe("/api/v1/directory/held/gEng01/confirm"),
  );
});

it("an admin sees a snoozed row without buttons", async () => {
  mountHosted("/settings/directory", true, asAdmin, snoozedStatus());
  const h = await held();
  expect(h).toHaveTextContent("Snoozed until ");
  expect(within(h).queryByRole("button")).toBeNull();
});

it("a 404 on Snooze refetches /me and shows the owner-only line", async () => {
  let me = 0;
  mountHosted("/settings/directory", true, (m) => (++me > 1 ? asAdmin(m) : m), [
    http.post(`*${snoozeRoute}`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    ),
  ]);
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Snooze Sales" }),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Snooze",
    }),
  );
  await status();
  await waitFor(() =>
    expect(
      screen.getByRole("status", { name: "Sync status" }),
    ).toHaveTextContent(/Only the owner/),
  );
  expect(me).toBeGreaterThan(1);
});

it("two held rows: each row's buttons are found by name", async () => {
  mountHosted(
    "/settings/directory",
    true,
    undefined,
    serveStatus({
      held: [
        { ...SNOOZED, snoozedUntil: null, snoozeReason: null },
        {
          ...SNOOZED,
          groupId: "gOps02",
          name: "Ops",
          email: "ops@example.com",
        },
      ],
    }),
  );
  const h = await held();
  for (const name of [
    "Snooze Engineering",
    "Apply Engineering",
    "Unsnooze Ops",
    "Apply Ops",
  ])
    expect(within(h).getByRole("button", { name })).toBeVisible();
  expect(
    within(h).queryByRole("button", { name: "Unsnooze Engineering" }),
  ).toBeNull();
});

it("closing the Snooze dialog clears the reason", async () => {
  mountHosted("/settings/directory");
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Snooze Sales" }),
  );
  fireEvent.change(
    within(screen.getByRole("alertdialog")).getByLabelText("Reason (optional)"),
    { target: { value: "draft" } },
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(
    within(await held()).getByRole("button", { name: "Snooze Sales" }),
  );
  expect(
    within(screen.getByRole("alertdialog")).getByLabelText("Reason (optional)"),
  ).toHaveValue("");
});

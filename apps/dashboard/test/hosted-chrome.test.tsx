// Hosted P4 Task 4: the directory sync-health banner (D13 B) and usage_off.
import type { InstanceDirectory, Me } from "@oa/shared";
import { R } from "@oa/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();
afterEach(() => vi.useRealTimers());

/** 4:10 PM local: the mock's outage began 2 hours earlier, at 2:10 PM today. */
const at410 = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 21, 16, 10));
};

/** A long-past outage: always the 24 h (danger) stage, with a fixed date. */
const OLD = new Date(2020, 0, 5, 14, 10).toISOString();
const dir =
  (d: Partial<InstanceDirectory>, role?: Me["user"]["role"]) => (m: Me) => ({
    ...m,
    user: role ? { ...m.user, role } : m.user,
    instance: {
      ...m.instance,
      directory: { ...(m.instance.directory as InstanceDirectory), ...d },
    },
  });
const sync = (role: "status" | "alert") =>
  screen.findByRole(role, { name: "Directory sync" });
const FROZEN_RETRY =
  "Access is frozen as of then: changes in Google, including people who left, won't apply here until sync recovers.";
const FROZEN_RECONNECT =
  "Access is frozen as of then: changes in Google, including people who left, won't apply here until you reconnect.";
const TOKENS =
  "Agent tokens aren't being re-checkedTokens and connected AI agents keep working for people Google has removed. If someone left, remove them in Members.";

it("owner: backoff in its first 24 hours is a warning", async () => {
  at410();
  mountHosted("/", { unhealthy: true, unhealthyState: "backoff" });
  const b = await sync("status");
  expect(b).toHaveTextContent("Google directory sync is failing");
  expect(b).toHaveTextContent(
    `Google directory sync is failingGoogle sync stopped at 2:10 PM and we keep retrying. ${FROZEN_RETRY}`,
  );
  expect(b).not.toHaveTextContent("Sign-ins now last at most 24 hours.");
  expect(b).toHaveTextContent(TOKENS);
  expect(
    within(b).getByRole("link", { name: "Open directory settings" }),
  ).toHaveAttribute("href", "/settings/directory");
  expect(within(b).queryByRole("link", { name: "Reconnect" })).toBeNull();
  expect(within(b).getByRole("button", { name: "Dismiss" })).toBeVisible();
});

it("owner: backoff turns danger at 24 hours, with the sign-in line and no Dismiss", async () => {
  mountHosted(
    "/",
    { unhealthy: true },
    dir({ unhealthySince: OLD, tokensUnverified: false }),
  );
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    `Google directory sync is failingGoogle sync stopped Jan 5 at 2:10 PM and we keep retrying. ${FROZEN_RETRY} Sign-ins now last at most 24 hours.`,
  );
  expect(b).not.toHaveTextContent("Agent tokens");
  expect(within(b).queryByRole("button", { name: "Dismiss" })).toBeNull();
});

it.each([
  [
    "auth_failed",
    "our connection was revoked or expired.",
    "Reconnect with a Google super admin.",
  ],
  [
    "scope_missing",
    "a permission we need was removed in Google.",
    "Reconnect and allow every permission.",
  ],
  [
    "customer_mismatch",
    "the connection points to a different Google Workspace.",
    "Reconnect with your company's Google Workspace.",
  ],
] as const)("owner: %s is danger from the start", async (state, why, fix) => {
  mountHosted(
    "/",
    { unhealthy: true, unhealthyState: state },
    dir({ unhealthySince: OLD }),
  );
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    `Google directory sync stoppedGoogle sync stopped Jan 5 at 2:10 PM: ${why} ${FROZEN_RECONNECT} ${fix} Sign-ins now last at most 24 hours.`,
  );
  expect(b).toHaveTextContent(TOKENS);
  expect(within(b).getByRole("link", { name: "Reconnect" })).toHaveAttribute(
    "href",
    R.directoryConnect,
  );
  expect(
    within(b).getByRole("link", { name: "Open directory settings" }),
  ).toHaveAttribute("href", "/settings/directory");
  expect(within(b).queryByRole("button", { name: "Dismiss" })).toBeNull();
});

it("owner: a danger state from today says only the time", async () => {
  at410();
  mountHosted("/", { unhealthy: true, unhealthyState: "auth_failed" });
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    "Google sync stopped at 2:10 PM: our connection was revoked or expired.",
  );
  expect(b).not.toHaveTextContent("Sign-ins now last at most 24 hours.");
});

it("an outage from yesterday under 24 hours old gets its date", async () => {
  at410();
  mountHosted(
    "/",
    { unhealthy: true, unhealthyState: "auth_failed" },
    dir({ unhealthySince: new Date(2026, 9, 20, 22, 5).toISOString() }),
  );
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    "Google sync stopped Oct 20 at 10:05 PM: our connection was revoked or expired.",
  );
  expect(b).not.toHaveTextContent("Sign-ins now last at most 24 hours.");
});

it("never: the first sync hasn't finished", async () => {
  mountHosted(
    "/",
    { unhealthy: true },
    dir({ state: "never", tokensUnverified: false }),
  );
  expect(await sync("status")).toHaveTextContent(
    "The first Google sync hasn't finishedWe keep trying. Group access starts once it does.Open directory settings",
  );
});

it("admin: the owner fixes it; View status; admins may dismiss danger", async () => {
  mountHosted("/", { unhealthy: true }, dir({ unhealthySince: OLD }, "admin"));
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    `Google directory sync is failingGoogle sync stopped Jan 5 at 2:10 PM and we keep retrying. ${FROZEN_RETRY} Sign-ins now last at most 24 hours. The owner can fix it.`,
  );
  expect(within(b).getByRole("link", { name: "View status" })).toHaveAttribute(
    "href",
    "/settings/directory",
  );
  expect(within(b).queryByRole("link", { name: "Reconnect" })).toBeNull();
  expect(
    within(b).queryByRole("link", { name: "Open directory settings" }),
  ).toBeNull();
  expect(within(b).getByRole("button", { name: "Dismiss" })).toBeVisible();
});

it("admin: danger-from-start states drop the owner's fix line", async () => {
  mountHosted(
    "/",
    { unhealthy: true, unhealthyState: "scope_missing" },
    dir({ unhealthySince: OLD }, "admin"),
  );
  const b = await sync("alert");
  expect(b).toHaveTextContent(
    `${FROZEN_RECONNECT} Sign-ins now last at most 24 hours. The owner can fix it.`,
  );
  expect(b).not.toHaveTextContent("Reconnect and allow every permission.");
});

it("dismiss hides the current stage only; a new state shows again", async () => {
  mountHosted("/", { unhealthy: true, unhealthyState: "backoff" });
  fireEvent.click(
    within(await sync("status")).getByRole("button", { name: "Dismiss" }),
  );
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
  // The dot stays.
  expect(
    screen.getByRole("link", { name: "Settings, needs attention" }),
  ).toBeVisible();
  // Dismissed per browser.
  expect(localStorage.getItem("oa.syncBanner.dismissed")).toBe(
    "backoff:warning",
  );
});

it("a dismissed stage stays hidden on the next load", async () => {
  localStorage.setItem("oa.syncBanner.dismissed", "backoff:warning");
  mountHosted("/", { unhealthy: true, unhealthyState: "backoff" });
  await screen.findByRole("link", { name: "Settings, needs attention" });
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
});

it("a dismissed warning shows again once it turns danger", async () => {
  localStorage.setItem("oa.syncBanner.dismissed", "backoff:warning");
  mountHosted("/", { unhealthy: true }, dir({ unhealthySince: OLD }, "admin"));
  expect(await sync("alert")).toBeVisible();
});

it("a dismissed state shows again for a different state", async () => {
  localStorage.setItem("oa.syncBanner.dismissed", "backoff:warning");
  mountHosted("/", { unhealthy: true, unhealthyState: "auth_failed" });
  expect(await sync("alert")).toBeVisible();
});

it("unreadable storage still shows the banner", async () => {
  const get = Storage.prototype.getItem;
  Storage.prototype.getItem = () => {
    throw new Error("blocked");
  };
  try {
    mountHosted("/", { unhealthy: true });
    expect(await sync("status")).toBeVisible();
  } finally {
    Storage.prototype.getItem = get;
  }
});

it("not on /settings/directory", async () => {
  mountHosted("/settings/directory", {
    unhealthy: true,
    unhealthyState: "auth_failed",
  });
  await screen.findByRole("navigation", { name: "Settings sections" });
  expect(screen.queryByRole("alert", { name: "Directory sync" })).toBeNull();
});

it("shows on Settings pages, inside the settings measure", async () => {
  mountHosted("/settings/profile", { unhealthy: true });
  const b = await sync("status");
  expect(b.closest(".oa-sync-banner")?.className).toContain("max-w-[880px]");
});

it("the dot sits on Settings and the Directory tab while unhealthy", async () => {
  mountHosted("/settings/profile", { unhealthy: true });
  expect(
    await screen.findByRole("link", { name: "Settings, needs attention" }),
  ).toHaveAttribute("href", "/settings/members");
  const tabs = screen.getByRole("navigation", { name: "Settings sections" });
  expect(
    within(tabs).getByRole("link", { name: "Directory, needs attention" }),
  ).toHaveAttribute("href", "/settings/directory");
});

it("all holds snoozed: the row is listed but heldSweeps 0 keeps the dot off", async () => {
  mountHosted("/settings/directory", true, dir({ heldSweeps: 0 }), [
    http.get("*/api/v1/directory", () =>
      HttpResponse.json({
        mode: "google",
        healthy: true,
        state: "ok",
        unhealthySince: null,
        lastError: null,
        nextRunAt: null,
        alertedAt: null,
        customerMismatch: null,
        held: [
          {
            groupId: "gEng01",
            email: "eng@example.com",
            name: "Engineering",
            wouldRemove: 6,
            members: 10,
            since: "2026-10-20T09:12:00.000Z",
            snoozedUntil: "2026-11-19T09:12:00.000Z",
            snoozeReason: null,
          },
        ],
        binding: {
          provider: "google",
          customerId: "C01abc",
          domain: "example.com",
          connectedBy: "ada@example.com",
          connectedAt: "2026-10-01T09:00:00.000Z",
        },
        lastSuccessAt: "2026-10-20T09:00:00.000Z",
        staleAt: "2026-10-27T09:00:00.000Z",
      }),
    ),
  ]);
  const row = await screen.findByRole("region", {
    name: "Waiting for your confirmation",
  });
  expect(row).toHaveTextContent("Snoozed until ");
  expect(screen.queryByRole("link", { name: /needs attention/ })).toBeNull();
});

it("a held sweep lights the dot but never raises the banner", async () => {
  mountHosted("/settings/profile"); // healthy; the mock holds gSales03
  expect(
    await screen.findByRole("link", { name: "Settings, needs attention" }),
  ).toBeVisible();
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
  expect(screen.queryByRole("alert", { name: "Directory sync" })).toBeNull();
});

it("healthy with nothing held: no banner, no dot", async () => {
  mountHosted("/settings/profile", true, dir({ heldSweeps: 0 }));
  const tabs = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  expect(
    (await screen.findAllByRole("link", { name: "Settings" })).length,
  ).toBeGreaterThan(0);
  expect(within(tabs).getByRole("link", { name: "Directory" })).toBeVisible();
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
});

it("members see no banner, no dot and no Directory tab", async () => {
  mountHosted(
    "/settings/profile",
    { unhealthy: true, unhealthyState: "auth_failed" },
    dir(
      {
        banner: false,
        tokensUnverified: false,
        state: null,
        staleAt: null,
        heldSweeps: 0,
      },
      "member",
    ),
  );
  const tabs = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  expect(within(tabs).queryByRole("link", { name: /Directory/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /needs attention/ })).toBeNull();
  expect(screen.queryByRole("alert", { name: "Directory sync" })).toBeNull();
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
});

it("self-hosted: no banner, no dot, no Directory tab", async () => {
  mount("/settings/profile");
  const tabs = await screen.findByRole("navigation", {
    name: "Settings sections",
  });
  expect(within(tabs).queryByRole("link", { name: /Directory/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /needs attention/ })).toBeNull();
  expect(screen.queryByRole("status", { name: "Directory sync" })).toBeNull();
  // Self-hosted keeps Usage.
  expect(
    (await screen.findAllByRole("link", { name: "Usage" })).length,
  ).toBeGreaterThan(0);
});

it("usage_off hides Usage and never requests it", async () => {
  const seen = calls("GET");
  mountHosted("/settings/profile");
  await screen.findByRole("navigation", { name: "Settings sections" });
  await screen.findByRole("link", { name: /^Settings/ });
  expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
  expect(seen.some((c) => c.path === R.usage)).toBe(false);
});

it("/settings/usage redirects to /settings/profile under usage_off", async () => {
  const router = mountHosted("/settings/usage");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/profile"),
  );
});

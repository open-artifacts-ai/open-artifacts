// #1628: the upgrade banner on the dashboard shell, for each state and each
// dismiss rule, with a pinned clock.

import type { InstanceUpdate } from "@oa/shared";
import { R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

installHarness();

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const UPDATE: InstanceUpdate = {
  latestVersion: "0.15.0",
  current: "0.14.2",
  custom: false,
  updateAvailable: true,
  breaking: false,
  notesUrl: "https://example.test/notes",
  checkedAt: ago(60_000),
  latestPublishedAt: ago(2 * DAY),
};
const u = (over: Partial<InstanceUpdate>): InstanceUpdate => ({
  ...UPDATE,
  ...over,
});
const CUSTOM = {
  custom: true,
  updateAvailable: false,
  breaking: null,
} as const;

const serve = (update: InstanceUpdate | null, role = "owner") => {
  server.use(...createHandlers({ update }));
  if (role !== "owner")
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role },
          instance: { ...fixtures.me.instance, update },
        }),
      ),
    );
};
const banner = () => screen.findByTestId("update-banner");
const none = async () => {
  await screen.findByRole("heading", { name: "Library" });
  expect(screen.queryByTestId("update-banner")).toBeNull();
};
const clipboard = () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("normal: the spec's copy, Copy, notes, an X; Copy puts the prompt on the clipboard", async () => {
  serve(UPDATE);
  const write = clipboard();
  mount("/");
  const b = await banner();
  expect(b).toHaveTextContent(
    "Open Artifacts v0.15.0 is out. You're on v0.14.2.",
  );
  expect(b.querySelector("[data-slot=alert]")?.className).toContain(
    "bg-brand-soft",
  );
  const notes = screen.getByRole("link", { name: /Release notes/ });
  expect(notes).toHaveAttribute("href", "https://example.test/notes");
  expect(notes).toHaveAttribute("target", "_blank");
  fireEvent.click(screen.getByRole("button", { name: "Copy upgrade prompt" }));
  expect(write).toHaveBeenCalledWith(
    `Upgrade my Open Artifacts instance at ${location.origin} from v0.14.2 to v0.15.0. Follow ${location.origin}/upgrade.md`,
  );
  // The prompt itself is not in the banner.
  expect(b).not.toHaveTextContent("Follow");
  expect(
    await screen.findByText("Copied, paste this into your agent"),
  ).toBeInTheDocument();
});

it("per version: the X hides it for that version, for good; a newer release shows it again", async () => {
  serve(UPDATE);
  const view = mount("/");
  await banner();
  fireEvent.click(
    screen.getByRole("button", { name: "Hide until the next release" }),
  );
  expect(screen.queryByTestId("update-banner")).toBeNull();
  expect(localStorage.getItem("oa.upgrade.dismissed.0.15.0")).not.toBeNull();
  // A reload, ten days later: still hidden.
  vi.setSystemTime(NOW + 10 * DAY);
  await act(() => view.navigate({ to: "/mine" }));
  expect(screen.queryByTestId("update-banner")).toBeNull();
});

it("a newer release brings the X'd banner back", async () => {
  localStorage.setItem("oa.upgrade.dismissed.0.15.0", "1");
  serve(u({ latestVersion: "0.15.1" }));
  mount("/");
  expect(await banner()).toHaveTextContent("v0.15.1 is out");
});

it("breaking: warning tone, no X, Remind me tomorrow hides it for 24 hours", async () => {
  serve(u({ breaking: true }));
  const view = mount("/");
  const b = await banner();
  expect(b).toHaveTextContent(
    "v0.15.0 has breaking changes. Read the release notes before you upgrade.",
  );
  expect(b.querySelector("[data-slot=alert]")?.className).toContain(
    "bg-warning-soft",
  );
  expect(
    screen.queryByRole("button", { name: "Hide until the next release" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remind me tomorrow" }));
  expect(screen.queryByTestId("update-banner")).toBeNull();
  vi.setSystemTime(NOW + DAY - 1);
  await act(() => view.navigate({ to: "/mine" }));
  expect(screen.queryByTestId("update-banner")).toBeNull();
  vi.setSystemTime(NOW + DAY);
  await act(() => view.navigate({ to: "/shared" }));
  await banner();
});

it("breaking prompt asks for a yes first", async () => {
  serve(u({ breaking: true }));
  const write = clipboard();
  mount("/");
  await banner();
  fireEvent.click(screen.getByRole("button", { name: "Copy upgrade prompt" }));
  expect(write).toHaveBeenCalledWith(
    expect.stringContaining(
      "This release has breaking changes: tell me what they mean for my instance and wait for my yes before you start.",
    ),
  );
});

it("stale (over 14 days): keeps its info tone, the X becomes Remind me tomorrow", async () => {
  serve(u({ latestPublishedAt: ago(15 * DAY) }));
  mount("/");
  const b = await banner();
  expect(b.querySelector("[data-slot=alert]")?.className).toContain(
    "bg-brand-soft",
  );
  expect(
    screen.getByRole("button", { name: "Remind me tomorrow" }),
  ).toBeInTheDocument();
});

it("custom build behind the latest: the custom copy and prompt", async () => {
  serve(u({ ...CUSTOM, current: "0.14.0-dev+4f2a9c1" }));
  const write = clipboard();
  mount("/");
  const b = await banner();
  expect(b).toHaveTextContent(
    "This is a custom build (0.14.0-dev+4f2a9c1). The latest release is v0.15.0.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy upgrade prompt" }));
  expect(write).toHaveBeenCalledWith(
    expect.stringContaining(
      "This instance runs a custom build (0.14.0-dev+4f2a9c1): tell me what upgrading will replace before you start.",
    ),
  );
});

it("a dev build of the latest version shows nothing", async () => {
  serve(u({ ...CUSTOM, current: "0.15.0-dev+4f2a9c1" }));
  mount("/");
  await none();
});

it("up to date, no update, members and guests: nothing", async () => {
  serve(u({ updateAvailable: false }));
  mount("/");
  await none();
});

it("a member never sees it", async () => {
  serve(UPDATE, "member");
  mount("/");
  await none();
});

it("shows on settings pages too", async () => {
  serve(UPDATE);
  mount("/settings/instance");
  expect(await banner()).toHaveTextContent("v0.15.0 is out");
  await waitFor(() =>
    expect(screen.getAllByText(/Update available/).length).toBeGreaterThan(0),
  );
});

it("an admin who isn't the owner sees it too", async () => {
  serve(UPDATE, "admin");
  mount("/");
  expect(await banner()).toHaveTextContent("v0.15.0 is out");
});

it("a custom build with a breaking release: the custom copy in the warning tone, breaking first in the prompt", async () => {
  serve(u({ ...CUSTOM, current: "0.14.0-dev+4f2a9c1", breaking: true }));
  const write = clipboard();
  mount("/");
  const b = await banner();
  expect(b).toHaveTextContent(
    "This is a custom build (0.14.0-dev+4f2a9c1). The latest release is v0.15.0.",
  );
  expect(b.querySelector("[data-slot=alert]")?.className).toContain(
    "bg-warning-soft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy upgrade prompt" }));
  const prompt = (write.mock.calls as unknown as string[][])[0]?.[0] ?? "";
  expect(prompt.indexOf("This release has breaking changes")).toBeGreaterThan(
    0,
  );
  expect(prompt.indexOf("This release has breaking changes")).toBeLessThan(
    prompt.indexOf("This instance runs a custom build"),
  );
});

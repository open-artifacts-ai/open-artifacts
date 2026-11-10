// "Update available" (Design's A + B): admins see it, members and a null update don't.
import { type InstanceUpdate, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPIED, upgradePrompt } from "../src/layout/update";
import { installHarness, mount, mountHosted, server, wait } from "./harness";

installHarness();

const NEWER: InstanceUpdate = {
  latestVersion: "0.15.0",
  current: "0.14.2",
  custom: false,
  updateAvailable: true,
  breaking: false,
  notesUrl:
    "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v0.15.0",
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const PROMPT = `Upgrade my Open Artifacts instance at ${location.origin}. Follow ${location.origin}/upgrade.md`;

/** Serve `update` to a user with `role`. */
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
const clipboard = () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
};
afterEach(() => vi.useRealTimers());

it("the prompt matches Design's wording", () => {
  expect(upgradePrompt()).toBe(PROMPT);
  expect(upgradePrompt("https://a.example")).toBe(
    "Upgrade my Open Artifacts instance at https://a.example. Follow https://a.example/upgrade.md",
  );
});

describe("Settings → Instance Version card", () => {
  const card = () => screen.findByRole("region", { name: "Version" });

  it("admin with an update: versions, badge, prompt, Upgrade copies it", async () => {
    serve(NEWER, "admin");
    const write = clipboard();
    mount("/settings/instance");
    const c = await card();
    expect(c).toHaveTextContent("Runningv0.14.2");
    expect(c).toHaveTextContent("Latest releasev0.15.0Update available");
    expect(c).toHaveTextContent("Checked5 minutes ago");
    expect(
      screen.getByRole("heading", { name: "Upgrade to v0.15.0" }),
    ).toBeInTheDocument();
    expect(c).toHaveTextContent(PROMPT);
    expect(c).not.toHaveTextContent("breaking");
    expect(c).not.toHaveTextContent("Check the release notes");
    const up = screen.getByRole("button", { name: "Upgrade" });
    expect(up).toHaveAccessibleDescription(
      /Upgrade copies this prompt\. Paste it into any AI agent/,
    );
    const status = within(c).getByRole("status");
    expect(status).toBeEmptyDOMElement();
    fireEvent.click(up);
    await waitFor(() => expect(write).toHaveBeenCalledWith(PROMPT));
    expect(await screen.findByText(COPIED)).toBeInTheDocument();
    const notes = within(c).getByRole("link", { name: /Release notes/ });
    expect(notes).toHaveAttribute("href", NEWER.notesUrl);
    expect(notes).toHaveAttribute("target", "_blank");
    expect(notes).toHaveTextContent("(opens in new tab)");
  });

  it("the Copied status clears after about 4 seconds", async () => {
    serve(NEWER);
    clipboard();
    mount("/settings/instance");
    const c = await card();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(await screen.findByText(COPIED)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(4100));
    expect(within(c).getByRole("status")).toBeEmptyDOMElement();
  });

  it("up to date: Running, You're on the latest version, Checked; no prompt", async () => {
    serve({ ...NEWER, current: "0.15.0", updateAvailable: false });
    mount("/settings/instance");
    const c = await card();
    expect(c).toHaveTextContent("Runningv0.15.0");
    expect(c).toHaveTextContent("Latest releaseYou're on the latest version");
    expect(c).toHaveTextContent("Checked5 minutes ago");
    expect(c).not.toHaveTextContent("Update available");
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  it("custom build: badge, latest release, the guide line; no Upgrade", async () => {
    serve({
      ...NEWER,
      current: "0.15.0-dev",
      custom: true,
      updateAvailable: false,
    });
    mount("/settings/instance");
    const c = await card();
    expect(c).toHaveTextContent("Runningv0.15.0-devCustom build");
    expect(c).toHaveTextContent("Latest releasev0.15.0");
    expect(c).toHaveTextContent(
      "This is a custom build, so it isn't upgraded from here. To move to a release, follow the upgrade guide (opens in new tab).",
    );
    expect(screen.getByRole("link", { name: /upgrade guide/ })).toHaveAttribute(
      "href",
      "https://open-artifacts.com/docs/upgrade/",
    );
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(c).not.toHaveTextContent("Update available");
    expect(c).not.toHaveTextContent("To upgrade, tell your agent");
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });

  it("breaking: the warning line, Upgrade still enabled", async () => {
    serve({ ...NEWER, breaking: true });
    mount("/settings/instance");
    const c = await card();
    expect(c).toHaveTextContent(
      "Includes breaking changes. Read the release notes (opens in new tab) before upgrading.",
    );
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeEnabled();
  });

  it("breaking unknown: the muted check-the-notes line", async () => {
    serve({ ...NEWER, breaking: null });
    mount("/settings/instance");
    expect(await card()).toHaveTextContent(
      "Check the release notes before upgrading.",
    );
  });

  const LINE = "To upgrade, tell your agent: Follow";

  it("self-host admin, no update: the always-on line, link opens a new tab, Copy copies the prompt", async () => {
    serve(null);
    const write = clipboard();
    mount("/settings/instance");
    const c = await card();
    expect(c).toHaveTextContent(LINE);
    const link = within(c).getByRole("link", { name: /upgrade\.md/ });
    expect(link).toHaveAttribute("href", `${location.origin}/upgrade.md`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    const btn = within(c).getByRole("button", { name: "Copy prompt" });
    expect(btn).toHaveAccessibleDescription(
      /To upgrade, tell your agent: Follow/,
    );
    fireEvent.click(btn);
    await waitFor(() => expect(write).toHaveBeenCalledWith(PROMPT));
    expect(await screen.findByText(COPIED)).toBeInTheDocument();
  });

  it("up to date: the line shows under the versions", async () => {
    serve({ ...NEWER, current: "0.15.0", updateAvailable: false });
    mount("/settings/instance");
    expect(await card()).toHaveTextContent(LINE);
  });

  it("with an update: no extra line", async () => {
    serve(NEWER, "admin");
    mount("/settings/instance");
    expect(await card()).not.toHaveTextContent(LINE);
  });

  it("hosted: no Version card", async () => {
    mountHosted("/settings/instance");
    await screen.findByLabelText("Instance name");
    expect(screen.queryByRole("region", { name: "Version" })).toBeNull();
  });

  it("a non-admin on the Instance page: no Version card", async () => {
    serve(null, "member");
    mount("/settings/instance");
    await wait(100);
    expect(screen.queryByRole("region", { name: "Version" })).toBeNull();
  });

  it("a member never sees it, even if the server sent one", async () => {
    serve(NEWER, "member");
    mount("/settings/profile");
    await screen.findByLabelText("Display name");
    await wait(50);
    expect(screen.queryByText("Update available")).toBeNull();
  });
});

describe("sidebar chip", () => {
  const chip = () =>
    screen.queryByRole("button", { name: /^Update available/ });

  it("admin with an update: chip with the new version; popover on click", async () => {
    serve(NEWER, "admin");
    mount("/");
    await screen.findByRole("heading", { name: "Library" });
    const c = await waitFor(() => {
      const el = chip();
      if (!el) throw new Error("no chip");
      return el;
    });
    expect(c).toHaveTextContent("Update availablev0.15.0");
    expect(c).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(c);
    const pop = await screen.findByRole("dialog", { name: "Update available" });
    expect(pop).toHaveTextContent("v0.14.2");
    expect(pop).toHaveTextContent("Details in Settings");
    expect(c).toHaveAttribute("aria-expanded", "true");
  });

  for (const [label, update, role] of [
    ["member", NEWER, "member"],
    ["null update", null, "owner"],
    ["up to date", { ...NEWER, updateAvailable: false }, "owner"],
    ["custom", { ...NEWER, custom: true, updateAvailable: false }, "owner"],
  ] as const)
    it(`${label}: no chip`, async () => {
      serve(update, role);
      mount("/");
      await screen.findByRole("heading", { name: "Library" });
      await wait(50);
      expect(chip()).toBeNull();
    });
});

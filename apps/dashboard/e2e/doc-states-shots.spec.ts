// #1100: the doc's room states with Product's copy, at 1280 and 390, light and
// dark: editing (Saved), View only (a reader by access), a full room (Try
// again) and a deleted doc (4404). Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { roomLog, startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

const status = (page: Page, text: RegExp) =>
  page.getByRole("status").filter({ hasText: text });

const LOGGED_OUT_SAVED =
  "You've been logged out. Your changes are saved. Log in again to keep editing.";
const LOGGED_OUT_UNSENT =
  "You've been logged out. Keep this page open and log in; your latest changes will be saved after.";

/**
 * Logged out (--expire-auth: 4401, then every upgrade refused 401). With
 * `unsent`, a line is typed after the 4401 and never reaches the room, so the
 * notice leaves out "Your changes are saved."
 */
const loggedOut = (unsent: boolean) => async (page: Page) => {
  await expect(status(page, /^Saved$/)).toBeVisible();
  await expect
    .poll(() =>
      (room ? (roomLog.get(room) ?? []) : []).some((l) =>
        l.startsWith("closing 4401 "),
      ),
    )
    .toBe(true);
  if (unsent) {
    await page.locator(".ProseMirror p").first().click();
    // The caret at the end of that paragraph (a click can land mid-word).
    await page.evaluate(() => {
      const p = document.querySelector(".ProseMirror p");
      if (!p) throw new Error("no paragraph");
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    });
    await page.keyboard.type(" Typed offline.");
    await expect(status(page, /^Offline$/)).toBeVisible();
  }
  // The session is gone: /me answers 401 from now on.
  await page.evaluate(() => {
    (window as unknown as { __oaMe401: boolean }).__oaMe401 = true;
  });
  await expect(page.getByRole("alert")).toHaveText(
    unsent ? LOGGED_OUT_UNSENT : LOGGED_OUT_SAVED,
  );
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(page.locator(".oa-docstate")).toHaveCount(0);
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await page.locator(".ProseMirror").blur();
};

/** Logged out with edits unsent, signed in again, and the room still refuses. */
const saveFailed = async (page: Page) => {
  await loggedOut(true)(page);
  await page.evaluate(() => {
    (window as unknown as { __oaMe401: boolean }).__oaMe401 = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByRole("alert")).toHaveText(
    "Couldn't save your latest changes. Copy them before leaving this page.",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.locator(".oa-docstate")).toHaveCount(0);
};

/** Signed in again with nothing unsent, still refused for 30 s: the quiet line. */
const cantConnect = async (page: Page) => {
  await loggedOut(false)(page);
  await page.evaluate(() => {
    (window as unknown as { __oaMe401: boolean }).__oaMe401 = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(status(page, /^Reconnecting…$/)).toBeVisible();
  await page.clock.fastForward("00:30");
  await expect(
    page.getByText(
      "Can't connect right now. You can read, and editing comes back when it reconnects.",
    ),
  ).toBeVisible();
};

const STATES: [string, string[], (page: Page) => Promise<void>][] = [
  ["logged-out-saved", ["--expire-auth"], loggedOut(false)],
  ["logged-out-unsent", ["--expire-auth"], loggedOut(true)],
  ["save-failed", ["--expire-auth"], saveFailed],
  ["cant-connect", ["--expire-auth"], cantConnect],
  [
    "editing",
    ["--hello", "edit"],
    async (page) => {
      await expect(status(page, /^Saved$/)).toBeVisible();
      await expect(page.getByRole("toolbar")).toBeVisible();
    },
  ],
  [
    "view-only",
    ["--hello", "read:access"],
    async (page) => {
      await expect(status(page, /^View only$/)).toBeVisible();
      await expect(page.getByRole("toolbar")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    },
  ],
  [
    "room-full",
    ["--hello", "read:room_full"],
    async (page) => {
      await expect(
        page.getByText(
          "This doc is full right now. You can read it, and editing opens when someone leaves.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Try again" }),
      ).toBeVisible();
      await expect(page.getByRole("toolbar")).toHaveCount(0);
      await expect(status(page, /^View only$/)).toBeVisible();
    },
  ],
  [
    "deleted",
    ["--close", "4404"],
    async (page) => {
      await expect(page.getByRole("alert")).toHaveText(
        "This doc was deleted. Its owner can restore it from Trash.",
      );
      await expect(page.locator(".oa-docstate")).toHaveCount(0);
      await expect(page.getByRole("toolbar")).toHaveCount(0);
    },
  ],
];

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 800 } });
      for (const [name, args, check] of STATES)
        test(name, async ({ page }, info) => {
          room = await startRoom(info, page, args);
          // Lets a state jump time (the 30 s before the quiet line).
          await page.clock.install();
          await page.goto(`/a/${LANDING}?mock=doc`);
          await expect(page.locator(".ProseMirror")).toBeVisible();
          await check(page);
          await page.waitForFunction(() =>
            document.getAnimations().every((x) => x.playState !== "running"),
          );
          const file = `doc-state-${name}-${scheme}-${width}.png`;
          await page.screenshot({
            path: DIR ? `${DIR}/${file}` : info.outputPath(file),
          });
        });
    });

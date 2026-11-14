// #1100: the doc's room states with Product's copy, at 1280 and 390, light and
// dark: editing (Saved), View only (a reader by access), a full room (Try
// again) and a deleted doc (4404). Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

const status = (page: Page, text: RegExp) =>
  page.getByRole("status").filter({ hasText: text });

const STATES: [string, string[], (page: Page) => Promise<void>][] = [
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
    },
  ],
  [
    "deleted",
    ["--close", "4404"],
    async (page) => {
      await expect(page.getByRole("alert")).toHaveText(
        "This doc was deleted. Its owner can restore it from Trash.",
      );
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

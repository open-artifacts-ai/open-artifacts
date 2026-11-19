// #2750: a newer saved version of a doc open in the room must not remount the
// editor (the room is live: node and caret stay), and a reader outside the
// room (room full, view only) still sees the new text, with no chip.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { roomPort, startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
test.use({ viewport: { width: 1280, height: 800 } });

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

const open = async (
  page: Page,
  info: Parameters<typeof startRoom>[0],
  args: string[],
) => {
  room = await startRoom(info, page, args);
  await page.goto(`/a/${LANDING}?mock=doc&versions=doc`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
};
/** A newer saved version, as the doc's autosave makes one. */
const newVersion = (page: Page) =>
  page.evaluate(async (id) => {
    await fetch(`/api/v1/artifacts/${id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, format: "html", content: "<p>next</p>" }),
    });
  }, LANDING);
const chip = (page: Page) =>
  page.getByRole("button", { name: /^View version/ });

test("in the room: a newer version keeps the editor node and the caret", async ({
  page,
}, info) => {
  await open(page, info, ["--hello", "edit"]);
  const prose = page.locator(".ProseMirror");
  await page.getByText("We ship the new landing page").click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
  const caret = () =>
    page.evaluate(() => {
      const s = getSelection();
      return `${s?.anchorNode?.textContent?.slice(0, 20)}@${s?.anchorOffset}`;
    });
  const before = await caret();
  await prose.evaluate((n) => n.setAttribute("data-mark", "mine"));
  await newVersion(page);
  await page.waitForTimeout(2_000);
  await expect(chip(page)).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toHaveAttribute(
    "data-mark",
    "mine",
  );
  expect(await caret()).toBe(before);
});

for (const hello of ["read:room_full", "read:access"]) {
  test(`reader (${hello}): the new text shows, no chip`, async ({
    page,
  }, info) => {
    await open(page, info, ["--hello", hello]);
    await expect(
      page.getByText("Hero image exported", { exact: true }),
    ).toBeVisible();
    // The doc's autosave makes a newer version, and the room applies the
    // restore for every connection (read ones included).
    await newVersion(page);
    await fetch(`http://localhost:${roomPort(info)}/restore/3?version=7`, {
      method: "POST",
    });
    // The mock's restore rewrites the doc without the checklist.
    await expect(
      page.getByText("Hero image exported", { exact: true }),
    ).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(chip(page)).toHaveCount(0);
  });
}

// #1100: the collaborative doc editor, against a local doc room
// (e2e/doc-room.mjs) with two people and an agent as remote collaborators.
// One flow, light at 1280 (#2711): the tooltip, link popover, size limit,
// read-only and caret-flag timing are unit tests in test/doc-editor.test.tsx.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
test.use({
  colorScheme: "light",
  viewport: { width: 1280, height: 800 },
});

let room: ChildProcess | undefined;
test.beforeEach(async ({ page }, info) => {
  room = await startRoom(info, page, ["--fakes"]);
});
test.afterEach(async () => {
  await stopRoom(room);
});

const caretOf = (page: Page, name: string) =>
  page.locator(`.oa-doc-caret[data-key="${name}"]`);
const flagShown = (page: Page, name: string) =>
  caretOf(page, name)
    .locator(".oa-doc-flag")
    .evaluate((el) => getComputedStyle(el).opacity === "1");

test("two people and an agent, while editing", async ({ page }) => {
  await page.goto(`/a/${LANDING}?mock=doc`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.getByText("Launch plan")).toBeVisible();
  // Three remote cursors: two people, one agent.
  await expect(page.locator(".oa-doc-caret")).toHaveCount(3);
  await expect(page.getByRole("toolbar")).toBeVisible();
  await expect(page.locator('.oa-doc-flag[data-kind="agent"]')).toHaveText(
    "Docs agent",
  );
  await expect(page.locator('.oa-doc-flag[data-kind="user"]')).toHaveText([
    "Maya Chen",
    "Sam Okafor",
  ]);
  // Bold and Heading 2 at the caret: bold the word "Checklist".
  await page
    .getByRole("heading", { name: "Checklist" })
    .click({ position: { x: 1, y: 8 } });
  for (let i = 0; i < "Checklist".length; i++)
    await page.keyboard.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "Bold" }).click();
  await page
    .getByRole("heading", { name: "Checklist" })
    .click({ position: { x: 40, y: 8 } });
  await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Heading 2" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  // Flags collapse to the caret and a dot after a move (a signal, not a sleep).
  for (const n of ["Maya Chen", "Sam Okafor", "Docs agent"])
    await expect
      .poll(() => flagShown(page, n), { timeout: 10_000 })
      .toBe(false);
  // Hovering a caret opens its flag; the others stay collapsed.
  const box = await caretOf(page, "Maya Chen").boundingBox();
  if (!box) throw new Error("no caret");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await expect.poll(() => flagShown(page, "Maya Chen")).toBe(true);
  expect(await flagShown(page, "Sam Okafor")).toBe(false);
  expect(await flagShown(page, "Docs agent")).toBe(false);
});

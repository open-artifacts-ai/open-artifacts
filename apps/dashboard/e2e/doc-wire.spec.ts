// #1100: the client side of the room's wire spec (artifact UkN5r8hpoXu9DYxG),
// against the mock room's flags: the hello frame's role, and the close codes
// 4401, 4403, 4404, 1007 and 1013.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

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
  await page.goto(`/a/${LANDING}?mock=doc`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
};
const prose = (page: Page) => page.locator(".ProseMirror");

test("hello read/access: a viewer reads only, no toolbar, no banner", async ({
  page,
}, info) => {
  await open(page, info, ["--hello", "read:access"]);
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await expect(page.getByText(/editing opens/)).toHaveCount(0);
});

test("hello edit: stays editable", async ({ page }, info) => {
  await open(page, info, ["--hello", "edit"]);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
  await expect(page.getByRole("toolbar")).toBeVisible();
});

test("hello read/room_full: reads only, says why, Try again reconnects", async ({
  page,
}, info) => {
  await open(page, info, ["--hello", "read:room_full"]);
  await expect(
    page.getByText("You can read; editing opens when someone leaves."),
  ).toBeVisible();
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  // Back in: the room greets again, still full.
  await expect(
    page.getByText("You can read; editing opens when someone leaves."),
  ).toBeVisible();
});

test("hello near the cap: warns and stays editable", async ({ page }, info) => {
  await open(page, info, ["--hello", "edit::1950000"]);
  await expect(
    page.getByText("This doc is almost full: 1.9 MB of 2 MB."),
  ).toBeVisible();
  await expect(page.getByRole("toolbar")).toBeVisible();
});

test("close 4403: no access, read-only, no retry", async ({ page }, info) => {
  await open(page, info, ["--close", "4403"]);
  await expect(page.getByRole("alert")).toHaveText(
    "You no longer have access.",
  );
  await expect(prose(page)).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("toolbar")).toHaveCount(0);
});

test("close 4404: the doc is gone", async ({ page }, info) => {
  await open(page, info, ["--close", "4404"]);
  await expect(page.getByRole("alert")).toHaveText("This doc was deleted.");
});

test("close 1007 once: resyncs and stays editable", async ({ page }, info) => {
  await open(page, info, ["--close-first", "1007"]);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
});

test("close 1007 every time: stops after one resync and reports", async ({
  page,
}, info) => {
  await open(page, info, ["--close", "1007"]);
  await expect(page.getByRole("alert")).toContainText(
    "This doc can't sync right now.",
  );
});

test("close 4401 once: reconnects silently", async ({ page }, info) => {
  await open(page, info, ["--close-first", "4401"]);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
});

test("close 1013 once: backs off and comes back", async ({ page }, info) => {
  await open(page, info, ["--close-first", "1013"]);
  await page.waitForTimeout(1500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
});

test("saved: the title bar says Saved as v5 for a moment and the version data refetches", async ({
  page,
}, info) => {
  let artifactGets = 0;
  page.on("request", (r) => {
    if (
      r.method() === "GET" &&
      r.url().endsWith(`/api/v1/artifacts/${LANDING}`)
    )
      artifactGets++;
  });
  await open(page, info, ["--saved", "5"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  const before = artifactGets;
  await expect(
    page.getByRole("status").filter({ hasText: "Saved as v5" }),
  ).toBeVisible();
  await expect.poll(() => artifactGets).toBeGreaterThan(before);
  // And it goes back to plain Saved.
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible({ timeout: 8000 });
});

test("restored by someone else: says so, refetches, the doc stays editable", async ({
  page,
}, info) => {
  await open(page, info, ["--restored", "3:7"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Restored v3 as v7" }),
  ).toBeVisible();
  await expect(prose(page)).toHaveAttribute("contenteditable", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a named save shows its name", async ({ page }, info) => {
  await open(page, info, ["--saved", "6:Before launch"]);
  await expect(
    page.getByRole("status").filter({ hasText: "Saved as v6 (Before launch)" }),
  ).toBeVisible();
});

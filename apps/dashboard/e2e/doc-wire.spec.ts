// #1100: the browser side of the room's wire spec, against the mock room's
// flags. Trimmed to the happy path (#2711): every close code, hello role, and
// logged-out state is a unit test in test/doc-room.test.tsx (the room) and
// test/doc-editor.test.tsx > "the wire spec" (what the editor shows).
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom, tellRoom } from "./room";

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
  query = "",
) => {
  room = await startRoom(info, page, args);
  await page.goto(`/a/${LANDING}?mock=doc${query}`);
  await expect(page.locator(".ProseMirror")).toBeVisible();
};

const prose = (page: Page) => page.locator(".ProseMirror");

test(
  "hello edit: stays editable",
  { tag: "@smoke" },
  async ({ page }, info) => {
    await open(page, info, ["--hello", "edit"]);
    await expect(prose(page)).toHaveAttribute("contenteditable", "true");
    await expect(page.getByRole("toolbar")).toBeVisible();
  },
);

test(
  "saved: the title bar says Saved as v5 for a moment and the version data refetches",
  { tag: "@smoke" },
  async ({ page }, info) => {
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
    // The page is loaded and in the room: the room says it saved v5.
    tellRoom(room, "saved");
    const before = artifactGets;
    await expect(
      page.getByRole("status").filter({ hasText: "Saved as v5" }),
    ).toBeVisible();
    await expect.poll(() => artifactGets).toBeGreaterThan(before);
    // And it goes back to plain Saved.
    await expect(
      page.getByRole("status").filter({ hasText: /^Saved$/ }),
    ).toBeVisible({ timeout: 8000 });
  },
);

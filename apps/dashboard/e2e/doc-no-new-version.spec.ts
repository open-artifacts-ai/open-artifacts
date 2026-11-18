// #2750, #2751: a doc in the live editor is always current. Its own autosaved
// versions never raise "new version available". Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

for (const width of [1280, 390]) {
  test.describe(`light ${width}`, () => {
    test.use({ colorScheme: "light", viewport: { width, height: 900 } });
    test(`no View chip after a newer version, ${width}`, async ({
      page,
    }, info) => {
      room = await startRoom(info, page, ["--fakes"]);
      await page.goto(`/a/${LANDING}?mock=doc`);
      await expect(page.locator(".ProseMirror")).toBeVisible();
      await page.evaluate(async (id) => {
        await fetch(`/api/v1/artifacts/${id}/versions/1/restore`, {
          method: "POST",
        });
      }, LANDING);
      await page.waitForTimeout(2_000);
      if (DIR)
        await page.screenshot({
          path: `${DIR}/${process.env.SHOT_PREFIX ?? "after"}-light-${width}.png`,
          clip: { x: 0, y: 0, width, height: 120 },
        });
      await expect(
        page.getByRole("button", { name: /^View version/ }),
      ).toHaveCount(0);
      await expect(page.locator(".oa-vlayer")).toHaveCount(1);
    });
  });
}

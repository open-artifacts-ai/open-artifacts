// #2750: a newer saved version of a doc open in the room must not remount the
// editor (the room is live: node and caret stay), and a reader outside the
// room (room full, view only) still sees the new text, with no chip.
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { roomPort, startRoom, stopRoom } from "./room";

/** How long a newer version is watched for a chip: the spec's original 2 s. */
const OBSERVE_MS = 2_000;

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
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (
            window as unknown as {
              __oaEvents: { connections(id: string): number };
            }
          ).__oaEvents.connections(id),
        LANDING,
      ),
    )
    .toBe(1);
  // Wait for hello (edit) AND initial sync ("saved") so initial focus placement
  // has completed before we position the caret (#3329).
  await expect(page.getByRole("toolbar")).toBeVisible();
  await expect(page.locator('.oa-docstate[data-state="saved"]')).toBeVisible();
  const prose = page.locator(".ProseMirror");
  const bold = page.getByRole("button", { name: "Bold" });
  const caret = () =>
    page.evaluate(() => {
      const s = getSelection();
      return `${s?.anchorNode?.textContent?.slice(0, 20)}@${s?.anchorOffset}`;
    });
  // Click inside **Thursday** and wait until both ProseMirror's model selection
  // (Bold toolbar state) and the DOM caret agree before freezing timers (#3329).
  await page.getByText("Thursday", { exact: true }).click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect.poll(caret).toMatch(/^Thursday@[1-7]$/);
  const before = await caret();
  await prose.evaluate((n) => n.setAttribute("data-mark", "mine"));
  await page.clock.install();
  await newVersion(page);
  // The original observation: 2 s after the event reaches the page.
  await page.clock.runFor(OBSERVE_MS);
  await expect(chip(page)).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toHaveAttribute(
    "data-mark",
    "mine",
  );
  expect(await caret()).toBe(before);
  await expect(bold).toHaveAttribute("aria-pressed", "true");
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

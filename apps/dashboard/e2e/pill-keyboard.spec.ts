// #2239: the New reply pill and the composer respect the action row and the
// iOS keyboard. The keyboard is simulated by shrinking visualViewport.height
// (Chromium has no on-screen keyboard); a real-iPhone check is still needed.
// PILL_KEYBOARD_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.PILL_KEYBOARD_SHOTS_DIR;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** Shrinks the visual viewport by `px` (0 restores it) and fires its resize. */
const keyboard = (page: Page, px: number) =>
  page.evaluate((px) => {
    const vv = window.visualViewport as VisualViewport;
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    vv.dispatchEvent(new Event("resize"));
  }, px);

const shot = async (page: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

const reply = (page: Page, body: string, last = false) =>
  page.evaluate(
    async ({ id, body, last }) => {
      const list = (await (
        await fetch(`/api/v1/artifacts/${id}/comments`)
      ).json()) as { threads: { id: string; status: string }[] };
      const open = list.threads.filter((t) => t.status === "open");
      const t = last ? open.at(-1) : open[0];
      await fetch(`/api/v1/artifacts/${id}/comments/${t?.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mock-as": "agent" },
        body: JSON.stringify({ body }),
      });
    },
    { id: ID, body, last },
  );

test("390: the down pill hides under the keyboard and comes back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const field = page.getByRole("textbox", {
    name: "Comment on the whole page",
  });
  await expect(field).toBeVisible();
  // Put the reader at the top of a long list, then a reply lands below.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      const o = getComputedStyle(el).overflowY;
      if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight)
        el.scrollTop = 0;
    }
  });
  await reply(page, "Arrived below the fold");
  const pill = page.locator("[data-new-reply]");
  await expect(pill).toBeVisible();
  await shot(page, "390-pill");
  await keyboard(page, 320);
  await expect(pill).toHaveCount(0);
  await shot(page, "390-pill-keyboard");
  await keyboard(page, 0);
  await expect(pill).toBeVisible();
});

async function openPin(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/${ID}?mock=agents`);
  await expect(page.getByRole("button", { name: /^Comments/ })).toBeVisible();
  // The mock has no pin threads: place one through its API.
  const status = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/artifacts/${id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "Pinned thread for the keyboard",
        anchor: { kind: "pin", version: 1, x: 0.5, y: 0.4 },
      }),
    });
    return res.status;
  }, ID);
  expect(status).toBe(201);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page
    .locator("li[data-thread]")
    .filter({ hasText: "Pinned thread for the keyboard" })
    .getByRole("button", { name: /^Show (in page|pin)/ })
    .click();
  await expect(page.locator('[data-sheet-height="pin"]')).toBeVisible();
}

test("390: the pill's clearance follows the action row's height", async ({
  page,
}) => {
  await openPin(page);
  const outlet = page.locator("[data-oa-action-outlet]");
  await expect(outlet).toBeVisible();
  // Read from the top, then a reply lands in the last thread, below the fold.
  await page.evaluate(() => {
    const o = document.querySelector("[data-oa-action-outlet]");
    for (let n = o?.parentElement; n; n = n.parentElement)
      if (n.scrollHeight > n.clientHeight) n.scrollTop = 0;
  });
  await reply(page, "Arrived below the fold", true);
  const pill = page.locator("[data-pill-dir=down]");
  await expect(page.locator("[data-new-reply]")).toBeVisible();
  const clearance = () =>
    pill.evaluate((el) => (el as HTMLElement).style.bottom);
  const before = Number.parseFloat(await clearance());
  const h = await outlet.evaluate((el) => (el as HTMLElement).offsetHeight);
  // The row grows by 60px (a composer opening, a hint wrapping).
  await outlet.evaluate((el, h) => {
    el.style.minHeight = `${h + 60}px`;
  }, h);
  await expect
    .poll(async () => Number.parseFloat(await clearance()))
    .toBe(before + 60);
  await shot(page, "390-pill-row-grown");
});

test("390: the pin sheet's field is capped by what the keyboard leaves", async ({
  page,
}) => {
  await openPin(page);
  // The pin card opens its reply field; the keyboard arrives after it.
  const field = page.getByRole("textbox", { name: "Reply" });
  await expect(field).toBeVisible();
  await field.focus();
  await keyboard(page, 320);
  await shot(page, "390-pin-composer-keyboard");
  // Typing many lines: the field stops growing at 40% of what is visible.
  await field.fill(
    Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
  );
  const hgt = await field.evaluate((el) => el.getBoundingClientRect().height);
  expect(hgt).toBeLessThanOrEqual((844 - 320) * 0.4 + 1);
  // Reply and Resolve stay above the keyboard, without scrolling.
  const actions = page
    .locator("li[data-thread]")
    .filter({ hasText: "Pinned thread for the keyboard" })
    .getByRole("button", { name: "Resolve" });
  await expect(actions).toBeVisible();
  const kbTop = 844 - 320;
  await expect
    .poll(async () => (await actions.boundingBox())?.y ?? 9999)
    .toBeLessThanOrEqual(kbTop);
  const box = await actions.boundingBox();
  expect((box?.y ?? 9999) + (box?.height ?? 0)).toBeLessThanOrEqual(kbTop);
  // The keyboard's top, as a red line drawn only for the shot.
  await page.evaluate((top) => {
    const d = document.createElement("div");
    d.style.cssText = `position:fixed;left:0;right:0;top:${top}px;height:0;border-top:2px solid red;z-index:99999;pointer-events:none`;
    document.body.append(d);
  }, kbTop);
  await shot(page, "390-pin-composer-long");
});

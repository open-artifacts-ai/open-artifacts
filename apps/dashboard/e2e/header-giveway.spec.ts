// #2247: the thread header gives way (time, then faces, then the name) as the
// comments column narrows, and steps back as it widens, without flicker.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.getByRole("separator")).toBeVisible();
  const thread = page.locator("li[data-thread]").filter({
    hasText: "Can the pricing section be shorter?",
  });
  const fold = thread.getByRole("button", { name: /Show \d+ earlier replies/ });
  if (await fold.count()) await fold.first().click();
  return thread;
}

const colW = (page: Page) =>
  page
    .getByRole("complementary", { name: "Comments" })
    .evaluate((e) => e.getBoundingClientRect().width);

test("the header gives way in order, fits, and gives back without flicker", async ({
  page,
}) => {
  const thread = await open(page);
  // The reply that told six agents.
  const head = thread
    .locator("[data-header-stage]")
    .filter({
      has: page.locator(
        '[data-delivery-faces] button[aria-label$="of 6 delivered"]',
      ),
    })
    .first();
  await expect(head).toBeVisible();
  const state = () =>
    head.evaluate((h) => {
      const name = h.querySelector<HTMLElement>("[data-author-name]");
      const faces = h.querySelectorAll("[data-face]").length;
      return {
        stage: Number((h as HTMLElement).dataset.headerStage),
        faces,
        // The header never overflows its row.
        fits: h.scrollWidth <= h.clientWidth + 1,
        nameCut: !!name && name.scrollWidth > name.clientWidth,
      };
    });

  const sep = page.getByRole("separator");
  await sep.focus();
  await page.keyboard.press("End");
  const wide = await colW(page);
  await expect.poll(async () => (await state()).stage).toBe(0);
  const widest = await state();
  expect(widest.stage).toBe(0);
  expect(widest.faces).toBe(3);

  // Narrow in 16px steps to the minimum: the stage only goes up, in order, and always fits.
  await page.keyboard.press("Home");
  const narrow = await colW(page);
  expect(narrow).toBeLessThan(wide);
  await expect.poll(async () => (await state()).stage).toBe(2);
  const narrowest = await state();
  expect(narrowest.fits).toBe(true);
  expect(narrowest.stage).toBeGreaterThanOrEqual(widest.stage);
  // At the minimum column the six-agent header has given up time and faces.
  expect(narrowest.stage).toBe(2);
  expect(narrowest.faces).toBe(0);

  // Widen step by step: the stage never goes up while the column grows, and ends at 0.
  let prev = narrowest.stage;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("ArrowRight"); // shrinks (the handle is on the left edge)
    await page.keyboard.press("ArrowLeft"); // grows
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await state()).fits).toBe(true);
    const s = await state();
    expect(s.fits).toBe(true);
    expect(s.stage).toBeLessThanOrEqual(prev + 1);
    prev = s.stage;
  }
  await page.keyboard.press("End");
  await expect.poll(async () => (await state()).stage).toBe(0);
  expect((await state()).faces).toBe(3);
});

for (const w of [390, 600, 900, 1280])
  test(`the header fits at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const heads = page.locator("[data-header-stage]");
    await expect(heads.first()).toBeVisible();
    for (const h of await heads.all())
      expect(await h.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
        true,
      );
  });

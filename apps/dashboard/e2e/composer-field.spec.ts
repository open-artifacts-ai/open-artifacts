// #2234: the composer's typing field. Two lines tall when empty, then it grows
// to ten lines (210px of text at the 14px body font) and scrolls inside its own
// edge, on a phone too, and never taller than 40% of what the reader can see.
// Writes PNGs to COMPOSER_SHOTS_DIR when set.
import { mkdirSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.COMPOSER_SHOTS_DIR;
const TWELVE = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");

async function open(page: Page, w: number, h: number, theme: string) {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const field = page.getByRole("textbox", {
    name: "Comment on the whole page",
  });
  await expect(field).toBeVisible();
  return field;
}

/** The field's box in px, and how many lines of text its content box holds. */
function boxOf(field: Locator) {
  return field.evaluate((el: HTMLTextAreaElement) => {
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight);
    const pad =
      Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    // clientHeight leaves out the borders; the lines sit between the paddings.
    const text = el.clientHeight - pad;
    const rect = el.getBoundingClientRect();
    return {
      height: rect.height,
      bottom: rect.bottom,
      client: el.clientHeight,
      scroll: el.scrollHeight,
      lines: text / line,
      cap: Number.parseFloat(cs.maxHeight),
      visible: window.visualViewport?.height ?? window.innerHeight,
    };
  });
}

async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  // A signal wait, not a sleep: the shot needs the fonts the box is sized in.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

for (const [w, h] of [
  [390, 844],
  [1280, 800],
] as const) {
  for (const theme of ["light", "dark"]) {
    test(`${w} ${theme}: two lines empty, ten lines then a scroll`, async ({
      page,
    }) => {
      const field = await open(page, w, h, theme);

      // (a) Empty: two lines, not one.
      const empty = await boxOf(field);
      expect(empty.lines).toBeCloseTo(2, 0);
      await shot(page, `${w}-${theme}-empty`);

      // (b) Twelve lines: the field stops at ten and scrolls inside itself.
      await field.fill(TWELVE);
      const full = await boxOf(field);
      expect(full.lines).toBeCloseTo(10, 0);
      expect(full.height).toBeCloseTo(full.cap, 0);
      expect(full.scroll).toBeGreaterThan(full.client);
      expect(full.height).toBeGreaterThan(empty.height);
      await shot(page, `${w}-${theme}-twelve`);

      // (c) Still inside what the reader can see: never 40% of it plus the cap.
      // 210px of text at 14px, 240px at the phone's 16px, plus 18px of chrome.
      expect(full.height).toBeLessThanOrEqual(
        Math.min(w < 600 ? 258 : 228, full.visible * 0.4) + 1,
      );
      expect(full.bottom).toBeLessThanOrEqual(full.visible + 1);
    });
  }
}

test("390: the cap follows the keyboard, not the screen", async ({ page }) => {
  const field = await open(page, 390, 844, "light");
  await field.fill(TWELVE);
  // #2239: the keyboard is not an event a test can see, so fake the visual
  // viewport it shrinks: 40% of 400px is 160px.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const real = Object.getOwnPropertyDescriptor(vv, "height");
    Object.defineProperty(vv, "height", { value: 400, configurable: true });
    vv.dispatchEvent(new Event("resize"));
    if (real) Object.defineProperty(vv, "height", real);
  });
  const shrunk = await boxOf(field);
  expect(shrunk.height).toBeCloseTo(160, 0);
});

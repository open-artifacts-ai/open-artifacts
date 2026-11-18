// A phone comments sheet has no gray band under its last card (user report on
// iPhone Safari): the scroller reaches the sheet's bottom with and without
// the keyboard, a composer opened and closed, or a keyboard opened and closed.
import { mkdirSync } from "node:fs";
import { devices, expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const OUT = process.env.SHEET_BAND_SHOTS_DIR;
const { defaultBrowserType: _d, ...phone } = devices["iPhone 14"];

test.use({
  ...phone,
  colorScheme: process.env.SHEET_BAND_DARK ? "dark" : "light",
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

test.beforeEach(({ page }) =>
  page.addInitScript(() => {
    (window as unknown as { __siv: number }).__siv = 0;
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...a) {
      (window as unknown as { __siv: number }).__siv++;
      return was.apply(this, a as []);
    };
  }),
);

const keyboard = (page: Page, px: number) =>
  page.evaluate((px) => {
    const vv = window.visualViewport as VisualViewport;
    Object.defineProperty(vv, "height", {
      configurable: true,
      get: () => window.innerHeight - px,
    });
    vv.dispatchEvent(new Event("resize"));
  }, px);

/** Gap in px between the sheet's bottom and the scroller's bottom. */
const gap = (page: Page) =>
  page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>("[data-sheet-height]");
    if (!sheet) return { err: "no sheet" };
    let sc: HTMLElement | null = null;
    for (const el of sheet.querySelectorAll<HTMLElement>("*")) {
      const o = getComputedStyle(el).overflowY;
      if (o === "auto" || o === "scroll") {
        sc = el;
        break;
      }
    }
    const s = sheet.getBoundingClientRect();
    const b = sc?.getBoundingClientRect();
    return {
      sheetBottom: s.bottom,
      scrollerBottom: b?.bottom,
      gap: b ? s.bottom - b.bottom : null,
      kb: document.documentElement.style.getPropertyValue("--oa-kb"),
      inner: window.innerHeight,
      vv: window.visualViewport?.height,
      sheetH: s.height,
    };
  });

const shot = async (page: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function open(page: Page) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.locator("[data-sheet-height]")).toBeVisible();
}

const field = (page: Page) =>
  page.getByRole("textbox", { name: "Comment on the whole page" });

/** The sheet ends at the screen's bottom and its scroller at the sheet's. */
async function expectFlush(page: Page, name: string) {
  await page.waitForTimeout(150);
  const g = await gap(page);
  const inner = await page.evaluate(() => window.innerHeight);
  // The sheet's border is 1px; the safe-area inset is inside the scroller.
  expect(g.scrollerBottom, `${name} ${JSON.stringify(g)}`).toBeGreaterThan(
    inner - 3,
  );
  expect(g.sheetBottom, name).toBeGreaterThan(inner - 1);
  // The sheet's own box never scrolls (it holds the header) and nothing in it
  // overflows it.
  const box = await page.locator("[data-sheet-height]").evaluate((el) => ({
    top: el.scrollTop,
    over: el.scrollHeight - el.clientHeight,
  }));
  expect(box.top, `${name} sheet scrollTop`).toBe(0);
  expect(box.over, `${name} sheet overflow`).toBeLessThanOrEqual(0);
  // The header (handle, title, close) is in view, not shifted off the top.
  const head = await page
    .locator("[data-comments-header]")
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(head, `${name} header top`).toBeGreaterThanOrEqual(0);
  await expect(
    page.getByRole("button", { name: "Close comments" }),
  ).toBeInViewport();
  await expect(page.locator("[data-sheet-handle]")).toBeInViewport();
}

test("390: after the keyboard opens and closes", async ({ page }) => {
  await open(page);
  await field(page).focus();
  await keyboard(page, 320);
  await page.waitForTimeout(150);
  const up = await gap(page);
  expect(up.kb).toBe("320px");
  await field(page).blur();
  await keyboard(page, 0);
  await expectFlush(page, "keyboard closed");
  await shot(page, "keyboard-closed");
});

test.describe("the side panel's comments tab", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
  test("has a scroller of its own for scrollWithin to move", async ({
    page,
  }) => {
    await page.goto(`/a/${ID}?mock=asks&panel=open&tab=comments`);
    const thread = page.locator("[data-thread]").first();
    await expect(thread).toBeVisible();
    // The nearest overflow auto/scroll ancestor: what scrollerOf finds.
    const found = await thread.evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if (o === "auto" || o === "scroll") return true;
      }
      return false;
    });
    expect(found).toBe(true);
  });
});

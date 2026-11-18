// Library on @oa/ui/shadcn: page h1 20/600, the grid spacing, nothing wider
// than the viewport. The other layout checks went with #2711 (listed there).
import { expect, type Page, test } from "@playwright/test";

const PAGES = { grid: "/?view=grid" } as const;

const measure = (page: Page) =>
  page.evaluate(() => {
    const h1 = document.querySelector("#oa-main h1");
    const c = h1 ? getComputedStyle(h1) : null;
    const boxes = (sel: string) =>
      [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    const cards = boxes("#oa-main .lib-card");
    const rows = boxes("#oa-main .lib-row");
    const firstRowTop = cards[0]?.top ?? 0;
    const sameRow = cards.filter((r) => Math.abs(r.top - firstRowTop) < 1);
    const nextRow = cards.find((r) => r.top > firstRowTop + 1);
    return {
      h1: c ? [c.fontSize, c.fontWeight] : [],
      sideScroll:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      colGap:
        sameRow.length > 1
          ? Math.round((sameRow[1]?.left ?? 0) - (sameRow[0]?.right ?? 0))
          : null,
      rowGap:
        nextRow && cards[0] ? Math.round(nextRow.top - cards[0].bottom) : null,
      listGap:
        rows.length > 1
          ? Math.round((rows[1]?.top ?? 0) - (rows[0]?.bottom ?? 0))
          : null,
      cardPad: (() => {
        const card = document.querySelector("#oa-main .lib-card");
        return card ? getComputedStyle(card).paddingLeft : null;
      })(),
    };
  });

test("grid geometry at 1280px light", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(PAGES.grid);
  await expect(page.locator(".lib-card").first()).toBeVisible();
  const m = await measure(page);
  expect(m.h1).toEqual(["20px", "600"]);
  expect(m.sideScroll).toBe(0);
  expect(m.cardPad).toBe("12px");
  expect(m.rowGap).toBe(16);
  expect(m.colGap).toBe(16);
});

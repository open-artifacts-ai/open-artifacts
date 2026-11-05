// Settings tabs on the shadcn primitives (Design's card rules): the 880px
// measure centered in the shell gutter, cards padded 20px (16px at <= 600px),
// 16px apart, 12px from header to body, and nothing past a card's content
// edge or the viewport. Each run attaches a screenshot for review.
import { expect, test } from "@playwright/test";

const TABS = ["profile", "members", "agents", "instance"] as const;

for (const tab of TABS)
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`settings/${tab} geometry at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/settings/${tab}`);
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        await expect(page.locator("[data-slot=card]").first()).toBeVisible();
        await expect(
          page.getByRole("navigation", { name: "Settings sections" }),
        ).toBeVisible();

        const pad = width <= 600 ? 16 : 20;
        const g = await page.evaluate(() => {
          const main = document.getElementById("oa-main") as HTMLElement;
          const left = main.getBoundingClientRect().left + main.clientLeft;
          const right = left + main.clientWidth;
          const column = document
            .querySelector(".oa-page > div")
            ?.getBoundingClientRect();
          const cards = [
            ...document.querySelectorAll<HTMLElement>(
              "#oa-main [data-slot=card]",
            ),
          ];
          const px = (v: string) => parseFloat(v);
          const per = cards.map((card) => {
            const c = getComputedStyle(card);
            const r = card.getBoundingClientRect();
            const parts = [
              ...card.querySelectorAll<HTMLElement>(
                ":scope > [data-slot^=card-], :scope > form > [data-slot^=card-]",
              ),
            ];
            const header = card.querySelector("[data-slot=card-header]");
            const body = card.querySelector("[data-slot=card-content]");
            const inner = r.right - px(c.borderRightWidth);
            const overflow = [...card.querySelectorAll("*")].filter((el) => {
              // Content of a scroller (tab strip, code block) is clipped.
              for (
                let p = el.parentElement;
                p && p !== card;
                p = p.parentElement
              )
                if (getComputedStyle(p).overflowX !== "visible") return false;
              const b = el.getBoundingClientRect();
              return b.width > 0 && b.right > inner + 0.5;
            }).length;
            return {
              padY: [px(c.paddingTop), px(c.paddingBottom)],
              padX: [
                ...new Set(
                  parts.flatMap((p) => [
                    px(getComputedStyle(p).paddingLeft),
                    px(getComputedStyle(p).paddingRight),
                  ]),
                ),
              ],
              headerToBody:
                header && body
                  ? body.getBoundingClientRect().top -
                    header.getBoundingClientRect().bottom
                  : null,
              overflow,
              top: r.top,
              bottom: r.bottom,
            };
          });
          return {
            columnWidth: column?.width ?? 0,
            gutter: [(column?.left ?? 0) - left, right - (column?.right ?? 0)],
            per,
            gaps: per
              .slice(1)
              .map((c, i) => Math.round(c.top - (per[i]?.bottom ?? 0))),
            sideScroll:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          };
        });

        expect(g.sideScroll).toBe(0);
        expect(g.columnWidth).toBeLessThanOrEqual(880);
        expect(Math.min(...g.gutter)).toBeGreaterThanOrEqual(
          width <= 600 ? 16 : 24,
        );
        expect(
          Math.abs((g.gutter[0] ?? 0) - (g.gutter[1] ?? 0)),
        ).toBeLessThanOrEqual(1);
        for (const c of g.per) {
          expect(c.padY).toEqual([pad, pad]);
          expect(c.padX).toEqual([pad]);
          if (c.headerToBody !== null) expect(c.headerToBody).toBe(12);
          expect(c.overflow).toBe(0);
        }
        for (const gap of g.gaps) expect(gap).toBe(16);

        await info.attach(`${tab}-${width}-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      });

test("hosted: the Spaces tab sits after Members", async ({ page }) => {
  await page.goto("/settings/profile?hosted=1");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link", { name: "Spaces" })).toHaveAttribute(
    "href",
    "/settings/spaces",
  );
  await expect(nav.getByRole("link")).toHaveText([
    "Profile",
    "Members",
    "Spaces",
    "Directory",
    "Agents",
    "Instance",
  ]);
});

test("hosted tab strip at 375 scrolls without clipping", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/settings/profile?hosted=1");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link")).toHaveText([
    "Profile",
    "Members",
    "Spaces",
    /^Directory/,
    "Agents",
    "Instance",
  ]);
  const g = await nav.evaluate((el) => ({
    overflowX: getComputedStyle(el).overflowX,
    sideScroll:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  }));
  expect(g.overflowX).toBe("auto");
  expect(g.sideScroll).toBe(0);
  // The last tab is reachable by scrolling the strip, not clipped off. The
  // attention dots on Members and Directory arrive with their queries and
  // widen the strip after the first scroll, so scroll again on each look: the
  // check settles on the final layout, and a tab that can't be scrolled into
  // view still fails.
  const last = nav.getByRole("link", { name: "Instance" });
  await expect
    .poll(async () => {
      await last.scrollIntoViewIfNeeded();
      const [n, l] = await Promise.all([nav.boundingBox(), last.boundingBox()]);
      return !!(l && n && l.x + l.width <= n.x + n.width + 0.5);
    })
    .toBe(true);
});

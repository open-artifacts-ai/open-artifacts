// Library and search on @oa/ui/shadcn: page h1 20/600, the grid and list
// spacing, the tab strip, nothing wider than the viewport, and the card's
// keyboard ring and reduced-motion behaviour. Each run attaches a
// screenshot for review.
import { expect, type Page, test } from "@playwright/test";

const PAGES = {
  grid: "/?view=grid",
  list: "/?view=list",
  search: "/search?q=notes",
  // Hosted (P4 Task 6): space chips on the cards keep today's measurements.
  "hosted-grid": "/?hosted=1&view=grid",
  "hosted-list": "/?hosted=1&view=list",
} as const;

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

for (const [name, path] of Object.entries(PAGES))
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`${name} geometry at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        await expect(
          page
            .locator(name.endsWith("grid") ? ".lib-card" : ".lib-row")
            .first(),
        ).toBeVisible();
        const m = await measure(page);
        expect(m.h1).toEqual(["20px", "600"]);
        expect(m.sideScroll).toBe(0);
        if (name.endsWith("grid")) {
          expect(m.cardPad).toBe("12px");
          expect(m.rowGap).toBe(16);
          expect(m.colGap).toBe(16);
        } else if (m.listGap !== null) expect(m.listGap).toBe(8);
        await info.attach(`${name}-${width}-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

test("library tabs keep a visible underline on the strip's edge", async ({
  page,
}) => {
  await page.goto("/");
  const tab = page.getByRole("tab", { name: "All" });
  await expect(tab).toHaveAttribute("data-state", "active");
  const u = await tab.evaluate((t) => {
    const a = getComputedStyle(t, "::after");
    const list = t.closest("[role=tablist]")?.getBoundingClientRect();
    return {
      opacity: a.opacity,
      height: a.height,
      bottom: a.bottom,
      inside: (list?.bottom ?? 0) >= t.getBoundingClientRect().bottom - 0.5,
    };
  });
  expect(u).toEqual({
    opacity: "1",
    height: "2px",
    bottom: "0px",
    inside: true,
  });
});

test("under reduced motion a card keeps the hover shadow but not the lift", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const card = page.locator(".lib-card").first();
  await expect(card).toBeVisible();
  const style = () =>
    card.evaluate((c) => {
      const s = getComputedStyle(c);
      return {
        transition: s.transitionProperty,
        transform: s.transform,
        shadow: s.boxShadow,
      };
    });
  const rest = await style();
  expect(rest.transition).toBe("none");
  await card.hover();
  const hover = await style();
  expect(hover.transform).toBe("none");
  expect(hover.shadow).not.toBe(rest.shadow);
});

test("keyboard focus rings the whole card: solid 2px at offset 2", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.locator(".lib-card").first();
  const title = card.locator("a.lib-title");
  await expect(title).toBeVisible();
  await title.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(title).toBeFocused();
  const ring = await card.evaluate((c) => {
    const s = getComputedStyle(c);
    return [s.outlineStyle, s.outlineWidth, s.outlineOffset];
  });
  expect(ring).toEqual(["solid", "2px", "2px"]);
});

test("every card shows its format tile, even with a blank thumbnail", async ({
  page,
}) => {
  await page.goto("/?view=grid");
  await expect(page.locator(".lib-card").first()).toBeVisible();
  const tiles = await page.locator(".lib-thumb").evaluateAll((thumbs) =>
    thumbs.map((t) => ({
      icon: !!t.querySelector("svg"),
      title: (t.textContent ?? "").trim().length > 0,
    })),
  );
  expect(tiles.length).toBeGreaterThan(0);
  for (const t of tiles) expect(t).toEqual({ icon: true, title: true });
});

test("phones: two grid columns, 4:3 thumbnails, titles clamped to 2 lines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/?view=grid");
  await expect(page.locator(".lib-card").first()).toBeVisible();
  const g = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".lib-card")].map((c) =>
      c.getBoundingClientRect(),
    );
    const top = cards[0]?.top ?? 0;
    const thumb = document.querySelector(".lib-thumb")?.getBoundingClientRect();
    const h3 = document.querySelector(".lib-card h3");
    return {
      perRow: cards.filter((c) => Math.abs(c.top - top) < 1).length,
      ratio: thumb ? Math.round((thumb.width / thumb.height) * 100) / 100 : 0,
      clamp: h3 ? getComputedStyle(h3).webkitLineClamp : "",
    };
  });
  expect(g).toEqual({ perRow: 2, ratio: 1.33, clamp: "2" });
});

for (const width of [1280, 390])
  test(`list rows show visibility before the agent at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?view=list");
    const row = page.locator(".lib-row").first();
    await expect(row).toBeVisible();
    const r = await row.evaluate((li) => {
      const badge = li.querySelector("time")?.parentElement;
      const parts = [...(badge?.children ?? [])].map((e) =>
        (e.textContent ?? "").trim(),
      );
      const title = li.querySelector("a.lib-title")?.getBoundingClientRect();
      const meta = badge?.getBoundingClientRect();
      return {
        first: parts[0],
        agent: parts[1],
        below: !!title && !!meta && meta.top >= title.bottom - 0.5,
      };
    });
    // #2509: Restricted, the instance name (Acme Artifacts) or Anyone with link.
    expect(r.first).toMatch(/^(Restricted|Acme Artifacts|Anyone with link)$/);
    expect(r.agent).toBe("Claude Code");
    expect(r.below).toBe(width <= 600);
  });

test("search counts its results, singular and plural", async ({ page }) => {
  await page.goto("/search?q=notes");
  await expect(page.getByText("1 result for “notes”")).toBeVisible();
  await page.goto("/search?q=e");
  await expect(page.getByText(/^\d+\+? results for “e”$/)).toBeVisible();
});

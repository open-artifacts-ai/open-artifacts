// #471: the version chip opens the Versions panel (Design tZY2i1Wteaa7Ltge v2,
// option B). 1280 and 390, light and dark: current, a pinned version with its
// actions, a search with matches and one with none; axe, no sideways scroll,
// 44px rows on phones; keyboard from the chip and back.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
/** Parser script: 25 versions, so paging and search have something to do. */
const ID = "Ef7hJkLmNp8qRsTv";

const axeRun = async (page: Page): Promise<string[]> => {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; impact: string; nodes: { target: string[] }[] }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 4)
            .join(" | ")}`,
      );
  });
};
const noOverflow = async (page: Page) => {
  const over = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
  );
  expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
};
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const chip = (page: Page) => page.getByRole("button", { name: /^Version: v/ });
const list = (page: Page) => page.getByRole("list", { name: "Versions" });
const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Search versions" });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`versions ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = (page: Page, name: string, path: (n: string) => string) =>
        page.screenshot({
          path: path(`versions-${name}-${scheme}-${width}.png`),
        });

      test("current, pinned, matches, none: axe and layout", async ({
        page,
      }, info) => {
        // Four axe runs and a navigation: slow when the suite runs in parallel.
        test.slow();
        const out = (n: string) => info.outputPath(n);
        await page.goto(`/a/${ID}`);
        await chip(page).click();
        await expect(search(page)).toBeFocused();
        await expect(list(page).getByRole("button").first()).toHaveAttribute(
          "aria-current",
          "true",
        );
        // Viewing Current: its row offers no actions.
        await expect(
          list(page).locator("li").first().getByRole("link"),
        ).toHaveCount(0);
        // The row name: version, Current, date, exact time, message, author
        // (Chrome spaces out the parts; screen readers ignore that).
        await expect(
          list(page).getByRole("button").first(),
        ).toHaveAccessibleName(
          /^v25 ?, Current ?, .+ at .+, Update 25 ?, Claude Code$/,
        );
        await settle(page);
        let v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
        await shot(page, "current", out);

        // Pinned: the row expands with its actions; the panel stays open.
        await list(page).locator('[data-version="21"]').click();
        await expect(page).toHaveURL(new RegExp(`/a/${ID}/v/21\\?`));
        const row = list(page).locator("li", {
          has: page.locator('[data-version="21"]'),
        });
        await expect(
          row.getByRole("link", { name: "Compare with current" }),
        ).toBeVisible();
        await expect(
          row.getByRole("button", { name: "Restore" }),
        ).toBeVisible();
        await expect(chip(page)).toHaveAccessibleName(
          /^Version: v21 · Jan 22(, 2026)?$/,
        );
        if (width < 600)
          for (const b of await row.getByRole("button").all())
            expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
              44,
            );
        await settle(page);
        v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
        await shot(page, "pinned", out);

        await search(page).fill("Update 1");
        await expect(page.getByText("10 of 25 match")).toBeVisible();
        await expect(list(page).locator("mark").first()).toHaveText("Update 1");
        v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await shot(page, "search", out);

        await search(page).fill("pricing");
        await expect(
          page.getByText('No loaded version mentions "pricing".'),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: /^Search older versions/ }),
        ).toBeVisible();
        await expect(page.getByText(/^0 of \d+ match$/)).toHaveCount(0);
        await shot(page, "none", out);
      });
    });

test("keyboard: chip, arrows, Enter keeps the panel and the row, Escape twice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/a/${ID}`);
  await chip(page).focus();
  await page.keyboard.press("Enter");
  await expect(search(page)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const first = list(page).getByRole("button").first();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const v23 = list(page).locator('[data-version="23"]');
  await expect(v23).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/a/${ID}/v/23\\?`));
  // The viewer remounts on the new route; focus comes back to the row.
  await expect(list(page).locator('[data-version="23"]')).toBeFocused();
  await page.keyboard.press("/");
  await expect(search(page)).toBeFocused();
  await page.keyboard.type("Update 2");
  await page.keyboard.press("Escape");
  await expect(search(page)).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "Side panel" }),
  ).toHaveCount(0);
  await expect(chip(page)).toBeFocused();
});

test("older versions load as the list scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/a/${ID}?panel=open&tab=versions`);
  await expect(list(page).getByRole("button")).toHaveCount(20);
  await list(page).getByRole("button").last().scrollIntoViewIfNeeded();
  await expect(list(page).getByRole("button")).toHaveCount(25);
});

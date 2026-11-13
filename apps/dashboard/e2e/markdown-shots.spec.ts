// #2338: comment bodies render a safe markdown subset (mock=markdown), at 1280 and 390, light and dark.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.MARKDOWN_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`markdown comments at ${width}px ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`/a/${ID}?mock=markdown`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const rich = page
        .locator("li[data-thread]")
        .filter({ hasText: "Review notes" });
      await expect(
        rich.locator("strong", { hasText: "checked" }),
      ).toBeVisible();
      await expect(
        rich.locator("code", { hasText: "pnpm test" }),
      ).toBeVisible();
      await expect(
        rich.locator("ul").filter({ hasText: "first point" }).locator("> li"),
      ).toHaveCount(2);
      await expect(rich.locator("ol > li")).toHaveCount(2);
      await expect(rich.locator("blockquote")).toBeVisible();
      await expect(rich.locator("pre code")).toContainText("**not bold**");
      await expect(rich.locator("a")).toHaveCount(2);
      const hostile = page
        .locator("li[data-thread]")
        .filter({ hasText: "alert(1)" });
      await expect(hostile.first()).toBeVisible();
      await expect(
        page.locator(
          "li[data-thread] img, li[data-thread] script, li[data-thread] iframe",
        ),
      ).toHaveCount(0);
      for (const h of await page
        .locator("li[data-thread] a")
        .evaluateAll((as) => as.map((a) => a.getAttribute("href"))))
        expect(h).toMatch(/^https?:\/\//);
      await rich.scrollIntoViewIfNeeded();
      // A long line scrolls inside the block, never clips.
      const pre = rich.locator("pre");
      expect(await pre.evaluate((e) => getComputedStyle(e).overflowX)).toBe(
        "auto",
      );
      expect(
        await pre.evaluate(
          (e) =>
            e.parentElement &&
            e.getBoundingClientRect().right <=
              e.parentElement.getBoundingClientRect().right + 1,
        ),
      ).toBe(true);
      const card = page.locator("[data-ask]", { hasText: "Which" });
      await expect(card.locator("[data-ask-body] ul li")).toHaveCount(2);
      await expect(card.locator("[data-ask-body] a")).toHaveCount(1);
      await expect(card.locator("button a")).toHaveCount(0);
      const body = await page.screenshot();
      await info.attach(`markdown-${width}-${theme}`, {
        body,
        contentType: "image/png",
      });
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({
          path: `${OUT}/markdown-${width}-${theme}.png`,
        });
        await card.scrollIntoViewIfNeeded();
        await card.screenshot({ path: `${OUT}/ask-${width}-${theme}.png` });
        await rich
          .locator("pre")
          .screenshot({ path: `${OUT}/code-${width}-${theme}.png` });
      }
    });

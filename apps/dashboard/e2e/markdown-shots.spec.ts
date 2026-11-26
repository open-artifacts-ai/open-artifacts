// #2338: comment bodies render a safe markdown subset (mock=markdown), at 1280, light.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.MARKDOWN_SHOTS_DIR;

for (const width of [1280])
  for (const theme of ["light"] as const)
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
      // What people and agents wrote never renders an image, script or frame.
      await expect(
        page.locator(
          [
            "[data-comment-body] img",
            "[data-comment-body] script",
            "[data-comment-body] iframe",
            "[data-ask-body] img",
            "[data-ask-body] script",
            "[data-ask-body] iframe",
          ].join(", "),
        ),
      ).toHaveCount(0);
      // Outside the bodies, the only images are app marks (#3105), drawn from
      // our own data: URLs; a thread never holds a script or frame at all.
      await expect(
        page.locator("li[data-thread] script, li[data-thread] iframe"),
      ).toHaveCount(0);
      const imgs = page.locator("li[data-thread] img");
      const marks = page.locator("li[data-thread] img[data-app-mark]");
      expect(await marks.count()).toBeGreaterThan(0);
      await expect(imgs).toHaveCount(await marks.count());
      for (const src of await marks.evaluateAll((es) =>
        es.map((e) => e.getAttribute("src") ?? ""),
      ))
        expect(src).toMatch(/^data:image\//);
      for (const alt of await marks.evaluateAll((es) =>
        es.map((e) => e.getAttribute("alt") ?? ""),
      ))
        expect(alt).not.toBe("");
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

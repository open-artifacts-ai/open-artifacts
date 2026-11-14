// #2472: hosted Solo hides spaces behind what they come with. The sidebar
// (owner) says Spaces come with Team and links See plans; /settings/spaces has
// no New space and links Invite people (trial still there) and See plans.
// 1280 and 390, light and dark; axe and no sideways scroll.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
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
          `${x.impact} ${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      );
  });
};
const noOverflow = async (page: Page) => {
  const over = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
  );
  expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
};

const TITLE = "Spaces come with Team";
const LINE =
  "Shared spaces are part of the Team plan. What you publish stays in Personal.";

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`solo ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("sidebar: Spaces come with Team, See plans", async ({ page }) => {
        await page.goto("/?hosted=solo,no-spaces");
        if (width < 768)
          await page
            .getByRole("button", { name: /^(Open menu|Toggle navigation)/ })
            .click();
        const sw = page.getByRole("navigation", { name: "Spaces" });
        await expect(sw).toContainText(TITLE);
        await expect(sw).toContainText(LINE);
        await expect(
          sw.getByRole("link", { name: "See plans" }),
        ).toHaveAttribute("href", "/settings/plan");
        await expect(
          sw.getByRole("link", { name: "Set up spaces" }),
        ).toHaveCount(0);
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
      });

      test("settings: no New space; Invite people and See plans", async ({
        page,
      }) => {
        await page.goto("/settings/spaces?hosted=solo,no-spaces");
        const card = page.locator("section", {
          has: page.locator("#oa-spaces-list"),
        });
        await expect(card).toContainText(TITLE);
        await expect(card.getByRole("link")).toHaveText([
          "Invite people to start a free 30-day trial",
          "See plans",
        ]);
        await expect(
          page.getByRole("button", { name: "New space" }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Every space" }),
        ).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Access" })).toHaveCount(
          0,
        );
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
      });
    });

test("settings after a used trial: See plans only, and it opens Plan", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=solo-used-trial,no-spaces");
  const card = page.locator("section", {
    has: page.locator("#oa-spaces-list"),
  });
  await expect(card).toContainText(TITLE);
  await expect(card.getByRole("link")).toHaveText(["See plans"]);
  await card.getByRole("link", { name: "See plans" }).click();
  await expect(page).toHaveURL(/\/settings\/plan/);
});

test("Team keeps New space", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=plan-team");
  await expect(page.getByRole("button", { name: "New space" })).toBeVisible();
  await expect(page.getByText(TITLE)).toHaveCount(0);
});

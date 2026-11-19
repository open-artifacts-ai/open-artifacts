// Hosted P4 Task 6 (Spaces A): the sidebar's Spaces section at 1280 light, the
// cross-space Library with space chips, and the scoped search; axe, no
// sideways scroll and the keyboard path. The rest: test/spaces-sidebar.test.tsx
// and test/spaces-publish.test.tsx (#2711).
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

const ENG = "SpEngNpQrSt2uVwX";

test("library across spaces: chips; the Spaces section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { level: 1, name: "Library" }).waitFor();
  const nav = page.getByRole("navigation", { name: "Spaces" });
  await expect(nav.getByRole("link")).toHaveText([
    "Personal",
    "Engineering",
    "Exec",
  ]);
  const v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await noOverflow(page);
});

test("keyboard: reach a space from the sidebar, then search everywhere", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?hosted=1");
  await page.waitForLoadState("networkidle");
  const eng = page
    .getByRole("navigation", { name: "Spaces" })
    .getByRole("link", { name: "Engineering" });
  await eng.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`space=${ENG}`));
  await expect(eng).toHaveAttribute("aria-current", "page");
  // One space open: heading, role, scoped search.
  await expect(
    page.getByRole("heading", { level: 1, name: "Engineering" }),
  ).toBeVisible();
  await expect(page.getByText("You're a manager")).toBeVisible();
  const v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await noOverflow(page);
  // Its accessible name follows the scope, so find it by type.
  const box = page
    .locator("#oa-main input[type=search], header input[type=search]")
    .first();
  await expect(box).toHaveAccessibleName("Search in Engineering");
  await box.focus();
  await page.keyboard.press("Backspace");
  await expect(box).toHaveAttribute("placeholder", "Search titles and content");
  await expect(box).toHaveAccessibleName("Search artifacts");
});

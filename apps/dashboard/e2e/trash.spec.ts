// Review item 9: Trash (Design's option A) at 1280 and 390, light and dark,
// with axe. Fixed rows come from the dashboard's ?mock=trash scenario.
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
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const sideways = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("rows", async ({ page }, info) => {
        await page.goto("/trash?hosted=1&mock=trash");
        const list = page.getByRole("list", { name: "Deleted artifacts" });
        await expect(list.getByRole("listitem")).toHaveCount(4);
        await expect(list).toContainText("Deletes in 27 days");
        await expect(list).toContainText("Deletes tomorrow");
        const restore = page.getByRole("button", {
          name: "Restore Q3 planning board",
        });
        // Phones: the button is the icon alone, named by its aria-label.
        const label = restore.getByText("Restore", { exact: true });
        if (width < 600) await expect(label).toBeHidden();
        else await expect(label).toBeVisible();
        await expect(page.getByText("Deleted Oct", { exact: false }).first())[
          width < 600 ? "toBeHidden" : "toBeVisible"
        ]();
        await settle(page);
        expect(await sideways(page)).toBeLessThanOrEqual(0);
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await page.screenshot({
          path: info.outputPath(`trash-${scheme}-${width}.png`),
          fullPage: true,
        });
      });

      test("empty", async ({ page }, info) => {
        await page.goto("/trash?hosted=1&mock=trash-empty");
        await expect(page.getByText("Trash is empty")).toBeVisible();
        await settle(page);
        expect(await sideways(page)).toBeLessThanOrEqual(0);
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await page.screenshot({
          path: info.outputPath(`trash-empty-${scheme}-${width}.png`),
        });
      });
    });

// Self-hosted (no ?hosted): the same Trash, with no filter and no chips.
test.describe("self-hosted light 1280", () => {
  test.use({ colorScheme: "light", viewport: { width: 1280, height: 900 } });

  test("rows", async ({ page }, info) => {
    await page.goto("/trash?mock=trash");
    const list = page.getByRole("list", { name: "Deleted artifacts" });
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await expect(
      page.getByText(
        "Your deleted artifacts. Each is deleted for good 30 days after it was deleted.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Space" })).toHaveCount(0);
    await expect(list.getByText("Engineering")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Trash" }).getByRole("link"),
    ).toHaveAttribute("aria-current", "page");
    await settle(page);
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    const v = await axeRun(page);
    expect(v, v.join("\n")).toEqual([]);
    await page.screenshot({ path: info.outputPath("trash-self-hosted.png") });
  });
});

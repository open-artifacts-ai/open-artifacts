// Hosted P4 Task 8: the Move dialog from the Details panel and the
// public-off confirm, at 1280 light, with axe (the rest: test/spaces-move.test.tsx).
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
/** Opens the side panel on Details without a reload (a reload resets the mock). */
const openDetails = async (page: Page, width: number) => {
  if (width > 600)
    await page.getByRole("button", { name: /^Version[: ]/ }).click();
  else {
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Versions" }).click();
  }
  await page.getByRole("tab", { name: "Details" }).click();
};
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

const width = 1280;
test.describe("1280 light", () => {
  test.use({ colorScheme: "light", viewport: { width, height: 900 } });

  test("move out of Personal: the list and the one-way note", async ({
    page,
  }) => {
    await page.goto("/?hosted=1");
    await page.getByRole("link", { name: "Landing page" }).first().click();
    await page.waitForURL(/\/a\//);
    await openDetails(page, width);
    await page.getByRole("button", { name: "Move" }).click();
    const d = page.getByRole("dialog", { name: 'Move "Landing page" to' });
    await d.getByRole("radio", { name: /^Engineering/ }).check();
    await expect(d).toContainText("You can't move it back to Personal.");
    await settle(page);
    const v = await axeRun(page);
    expect(v, v.join("\n")).toEqual([]);
  });

  test("public into a public-off space: the confirm", async ({ page }) => {
    await page.goto("/?hosted=1");
    await page.getByRole("link", { name: "Q4 report" }).first().waitFor();
    // Sharing by link off in Engineering, before the artifact loads (a reload resets the mock).
    const status = await page.evaluate(async () => {
      const r = await fetch("/api/v1/spaces/SpEngNpQrSt2uVwX", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "X-OA-Request": "1",
        },
        body: JSON.stringify({ publicLinks: false }),
      });
      return r.status;
    });
    expect(status).toBe(200);
    await page.getByRole("link", { name: "Q4 report" }).first().click();
    await page.waitForURL(/\/a\//);
    await openDetails(page, width);
    await page.getByRole("button", { name: "Move" }).click();
    const d = page.getByRole("dialog", { name: 'Move "Q4 report" to' });
    await d.getByRole("radio", { name: /^Engineering/ }).check();
    await d.getByRole("button", { name: "Move" }).click();
    const c = page.getByRole("alertdialog");
    await expect(c).toContainText(
      "Sharing by link is off in Engineering, so this link stops working",
    );
    await settle(page);
    const v = await axeRun(page);
    expect(v, v.join("\n")).toEqual([]);
    await c.getByRole("button", { name: "Move and turn off link" }).click();
    await expect(page.getByText("Moved to Engineering.")).toBeVisible();
  });
});

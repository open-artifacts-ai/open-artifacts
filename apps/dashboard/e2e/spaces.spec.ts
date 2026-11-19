// Hosted P4 Tasks 10 to 12: /settings/spaces at 1280 light: the list, one space
// (Engineering), the admin's no-role view (Clients) and the People card with
// the Add people dialog; axe, no sideways scroll, keyboard. Variants and the
// logic live in test/spaces-admin.test.tsx, space-access.test.tsx and
// space-people.test.tsx (#2711).
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
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

test("list: axe, no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: "Spaces" }).first().waitFor();
  const v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await noOverflow(page);
});

test("dialogs pass axe: New space, Add me, public links off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "New space" }).click();
  await expect(page.getByRole("dialog", { name: "New space" })).toBeVisible();
  await settle(page);
  let v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.goto("/settings/spaces?hosted=1&space=SpCliNpQrSt4uVwX");
  // The admin's no-role view of Clients.
  await page.getByRole("heading", { name: "Clients" }).first().waitFor();
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await noOverflow(page);
  await page.getByRole("button", { name: "Add me to this space" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Add yourself to Clients?",
  );
  await settle(page);
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "Public links" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Public links already here keep working.",
  );
  await settle(page);
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
});

test("keyboard: open a space from the list, add a group, change its role", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1");
  await page.waitForLoadState("networkidle");
  // The sidebar's Spaces section also has an Engineering link: use the page's list.
  await page
    .getByRole("list", { name: "Spaces" })
    .getByRole("link", { name: /Engineering/ })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { level: 2, name: "Engineering" }).waitFor();
  const detail = await axeRun(page);
  expect(detail, detail.join("\n")).toEqual([]);
  await noOverflow(page);
  const box = page.getByRole("combobox", { name: "Add a group" });
  await box.focus();
  await page.keyboard.type("sa");
  await page.getByRole("option", { name: /sales@example.com/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const sales = page.getByRole("row", { name: /sales@example.com/ });
  await expect(sales).toBeVisible();
  const role = sales.getByRole("combobox", {
    name: "Role for sales@example.com",
  });
  await role.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Editor" }).focus();
  await page.keyboard.press("Enter");
  await expect(role).toHaveText("Editor");
});

test("add people dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/spaces?hosted=1&space=SpEngNpQrSt2uVwX");
  await page.waitForLoadState("networkidle");
  const card = page.getByRole("region", { name: "People" });
  await expect(card.getByText("Bob Builder")).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  let v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await noOverflow(page);
  await card.getByRole("button", { name: "Add people" }).click();
  const d = page.getByRole("dialog", { name: "Add people to Engineering" });
  await d.getByRole("combobox", { name: "People" }).fill("da");
  await page.getByRole("option", { name: /Dan Contractor/ }).click();
  await settle(page);
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
});

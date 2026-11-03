// Hosted P4 Tasks 17 and 18: /settings/directory (D12 B, status first) at
// 1280 and 390, light and dark: healthy with a held sweep, unhealthy
// (Retrying), frozen and not connected; axe, no sideways scroll, keyboard.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const open = async (page: Page, hosted: string) => {
  await page.goto(`/settings/directory?hosted=${hosted}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("status", { name: "Sync status" }).waitFor();
};

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

const STATES: [string, string, string][] = [
  ["1", "healthy", "Healthy"],
  ["unhealthy", "retrying", "Retrying"],
  ["frozen", "frozen", "Frozen"],
  ["sync-off", "off", "Not connected"],
];

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      for (const [hosted, name, label] of STATES)
        test(`${name}: header, axe, no sideways scroll`, async ({
          page,
        }, info) => {
          await open(page, hosted);
          const s = page.getByRole("status", { name: "Sync status" });
          await expect(s.getByRole("heading", { level: 2 })).toHaveText(label);
          const v = await axeRun(page);
          expect(v, v.join("\n")).toEqual([]);
          await noOverflow(page);
          await page.screenshot({
            path: info.outputPath(`directory-${name}-${scheme}-${width}.png`),
            fullPage: true,
          });
        });
    });

test("the held-sweep confirm and the group picker pass axe", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "1");
  await page
    .getByRole("region", { name: "Waiting for your confirmation" })
    .getByRole("button", { name: "Apply" })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Remove 4 people from Sales?",
  );
  // The dialog fades and zooms in: let the animation finish before axe measures contrast.
  await page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
  let v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Add a restricted group" })
    .fill("sa");
  await expect(
    page.getByRole("option", { name: /sales@example.com/ }),
  ).toBeVisible();
  v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
});

test("keyboard: Sync now, then add a restricted group without a mouse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "1");
  const syncNow = page.getByRole("button", { name: "Sync now" });
  await syncNow.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status", { name: "Sync status" }).getByRole("heading"),
  ).toHaveText("Syncing…");
  const box = page.getByRole("combobox", { name: "Add a restricted group" });
  await box.focus();
  await page.keyboard.type("sa");
  await page.getByRole("option", { name: /sales@example.com/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("row", { name: /sales@example.com/ }),
  ).toBeVisible();
});

test("keyboard: Disconnect's confirm opens, cancels and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, "1");
  const disconnect = page.getByRole("button", { name: "Disconnect" });
  await disconnect.focus();
  await page.keyboard.press("Enter");
  const d = page.getByRole("alertdialog");
  await expect(d).toContainText("You can connect again later.");
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(disconnect).toBeFocused();
});

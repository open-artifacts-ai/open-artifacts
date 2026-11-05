// Hosted P4 Task 6 (Spaces A): the sidebar's Spaces section at 1280 and 390
// (the phone drawer), light and dark, the cross-space Library with space
// chips, one space open, and the scoped search; axe, no sideways scroll and
// the keyboard path.
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

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("library across spaces: chips; the Spaces section", async ({
        page,
      }, info) => {
        await page.goto("/?hosted=1");
        await page.waitForLoadState("networkidle");
        await page
          .getByRole("heading", { level: 1, name: "Library" })
          .waitFor();
        const phone = width <= 600;
        if (phone) {
          await page.getByRole("button", { name: "Toggle navigation" }).click();
          // The drawer slides in: let it land before measuring and the shot.
          await page.waitForFunction(() =>
            document.getAnimations().every((x) => x.playState !== "running"),
          );
        }
        const nav = page.getByRole("navigation", { name: "Spaces" });
        await expect(nav.getByRole("link")).toHaveText([
          "Personal",
          "Engineering",
          "Exec",
        ]);
        if (phone) {
          // Fully on screen and full height.
          const box = await page
            .locator("[data-mobile=true][data-sidebar=sidebar]")
            .boundingBox();
          expect(box?.x).toBe(0);
          expect(Math.round(box?.height ?? 0)).toBe(900);
          for (const name of ["Personal", "Engineering", "Exec"])
            await expect(nav.getByRole("link", { name })).toBeInViewport();
        }
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`sidebar-library-${scheme}-${width}.png`),
          // The drawer is fixed to the viewport: shoot what's on screen.
          fullPage: !phone,
        });
      });

      test("one space open: heading, role, scoped search", async ({
        page,
      }, info) => {
        await page.goto(`/?hosted=1&space=${ENG}`);
        await page.waitForLoadState("networkidle");
        await expect(
          page.getByRole("heading", { level: 1, name: "Engineering" }),
        ).toBeVisible();
        await expect(page.getByText("You're a manager")).toBeVisible();
        await expect(
          page.getByRole("searchbox", { name: "Search in Engineering" }),
        ).toHaveAttribute(
          "placeholder",
          width < 640 ? "Search" : "Search Engineering",
        );
        await expect(page.locator("[data-scope-chip]")).toHaveText(
          width < 640 ? "Engineering" : "in Engineering",
        );
        const v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await noOverflow(page);
        await page.screenshot({
          path: info.outputPath(`sidebar-space-${scheme}-${width}.png`),
          fullPage: true,
        });
      });
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

for (const [width, shown] of [
  [1280, true],
  [640, true],
  [639, false],
  [390, false],
] as const)
  test(`header email at ${width}px: ${shown ? "shown" : "avatar only"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?hosted=1&space=${ENG}`);
    await page.waitForLoadState("networkidle");
    const email = page.locator("[data-header-email]");
    if (shown) await expect(email).toBeVisible();
    else await expect(email).toBeHidden();
    // The avatar still opens the account menu.
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Sign out" }),
    ).toBeVisible();
  });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`upload dialog with the Space select at ${width}px ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?hosted=1&space=${ENG}`);
      await page.waitForLoadState("networkidle");
      await page.getByTestId("upload-files").setInputFiles({
        name: "notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# x"),
      });
      const d = page.getByRole("dialog", { name: "Create artifact" });
      await expect(d.getByRole("combobox", { name: "Space" })).toHaveText(
        /Engineering/,
      );
      await expect(
        d.getByText("People in this space get access by their role."),
      ).toBeVisible();
      await page.waitForFunction(() =>
        document.getAnimations().every((x) => x.playState !== "running"),
      );
      const v = await axeRun(page);
      expect(v, v.join("\n")).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`upload-space-${scheme}-${width}.png`),
      });
    });

test("account menu shows the signed-in email as a label", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Account menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("ada@example.com")).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Sign out"]);
});

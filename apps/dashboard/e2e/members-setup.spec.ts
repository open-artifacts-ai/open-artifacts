// #2632 slice 2: Settings, Members, the Setup column (PROVISIONAL
// api/memberSetup.ts) in every state, and "Copy the setup line". At 1280 and
// 390, light and dark, with axe and no sideways scroll at 390. PNGs to
// SHOTS_DIR when set.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const URL_ = "/settings/members?mock=members-setup";

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const shot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await settle(page);
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
    fullPage: true,
  });
};
async function axe(page: Page) {
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map((x: { id: string }) => x.id);
  });
  expect(v).toEqual([]);
}
const row = (page: Page, who: string) =>
  page.locator("li").filter({ hasText: who });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width, height: width === 390 ? 844 : 900 },
      });

      test("every Setup state", async ({ page }, info) => {
        await page.goto(URL_);
        await expect(row(page, "Jon Lee").getByText("Set up")).toBeVisible();
        await expect(
          row(page, "Ada Lovelace").locator('[data-setup="set"]'),
        ).toHaveText(/Set up/);
        const sam = row(page, "Sam Ortiz");
        await expect(sam.getByText("3 of 5")).toBeVisible();
        await expect(sam.getByText("no agent reply yet")).toBeVisible();
        const priya = row(page, "Priya Shah");
        await expect(priya.getByText("0 of 5")).toBeVisible();
        await expect(priya.getByText("no agent connected yet")).toBeVisible();
        await expect(priya.getByText("Reminded 15 Nov")).toBeVisible();
        await expect(
          row(page, "dana@example.com").getByText("Invited"),
        ).toBeVisible();
        const ana = row(page, "ana@venue.example").locator(
          '[data-setup="guest"]',
        );
        if (width === 390) await expect(ana).toBeHidden();
        else await expect(ana).toHaveText(/–/);
        if (width === 390)
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
        await shot(page, info, `members-setup-${scheme}-${width}.png`);
        await axe(page);
      });

      test("Copy the setup line, for someone not set up", async ({
        page,
        context,
        browserName,
      }, info) => {
        if (browserName === "chromium")
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto(URL_);
        await row(page, "Sam Ortiz")
          .getByRole("button", { name: "More for Sam Ortiz" })
          .click();
        await expect(
          page.getByRole("menuitem", { name: "Copy the setup line" }),
        ).toBeVisible();
        await shot(page, info, `members-setup-menu-${scheme}-${width}.png`);
        await page
          .getByRole("menuitem", { name: "Copy the setup line" })
          .click();
        await expect(page.getByText("Copied. Send it to Sam.")).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          `Set up Open Artifacts for me: follow ${new URL(page.url()).origin}/llms.txt`,
        );
        await shot(page, info, `members-setup-copied-${scheme}-${width}.png`);
        // Set up already: no line to pass on.
        await page.keyboard.press("Escape");
        await row(page, "Jon Lee")
          .getByRole("button", { name: "More for Jon Lee" })
          .click();
        await expect(
          page.getByRole("menuitem", { name: "Copy the setup line" }),
        ).toHaveCount(0);
      });
    });

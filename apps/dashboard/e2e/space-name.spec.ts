// Space names (the server's SpaceNameSchema): the inline error under the
// field, in the New space dialog and the rename card, at 1280 and 390,
// light and dark.
import { expect, type Page, test } from "@playwright/test";

const ENG = "SpEngNpQrSt2uVwX";
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("New space: only controls reads as empty", async ({
        page,
      }, info) => {
        await page.goto("/settings/spaces?hosted=1");
        await page.getByRole("button", { name: "New space" }).click();
        const d = page.getByRole("dialog", { name: "New space" });
        await d.getByRole("textbox", { name: "Name" }).fill("‮\u0007");
        // The error waits for the field to be left.
        await expect(d.getByText("Enter a space name.")).toHaveCount(0);
        await page.keyboard.press("Tab");
        await expect(d.getByText("Enter a space name.")).toBeVisible();
        await settle(page);
        await page.screenshot({
          path: info.outputPath(`name-new-${scheme}-${width}.png`),
        });
      });

      test("Rename: 81 characters", async ({ page }, info) => {
        await page.goto(`/settings/spaces?hosted=1&space=${ENG}`);
        await page.getByRole("textbox", { name: "Name" }).fill("x".repeat(81));
        await page.getByRole("textbox", { name: "Name" }).blur();
        await expect(
          page.getByText("Use 80 characters or fewer."),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Save name" }),
        ).toBeDisabled();
        await page
          .getByRole("textbox", { name: "Name" })
          .scrollIntoViewIfNeeded();
        await settle(page);
        await page.screenshot({
          path: info.outputPath(`name-rename-${scheme}-${width}.png`),
        });
      });
    });

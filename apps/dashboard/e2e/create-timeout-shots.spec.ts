// #2152: the Create dialog after a create that fails with a 503 (button reads Try again), light and dark.
import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });
    test(`create error with Try again (${scheme})`, async ({ page }, info) => {
      await page.goto("/?mock=create-503");
      await page.waitForLoadState("networkidle");
      await page.getByTestId("upload-files").setInputFiles({
        name: "notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# x"),
      });
      const d = page.getByRole("dialog", { name: "Create artifact" });
      await d.getByRole("button", { name: "Create" }).click();
      await expect(d.getByRole("alert")).toHaveText(
        "Couldn't create the artifact: the server didn't answer. Your file is still here.",
      );
      await expect(d.getByRole("button", { name: "Try again" })).toBeFocused();
      await page.screenshot({
        path: info.outputPath(`create-error-${scheme}.png`),
      });
    });
  });
}

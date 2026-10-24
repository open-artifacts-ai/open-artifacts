// A group's access changed under the editor (403 space_forbidden for a
// mapping): the message sits on that group's row as a status, at 1280 and
// 390, light and dark.
import { expect, type Page, test } from "@playwright/test";

const ENG = "SpEngNpQrSt2uVwX";
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`group race on its row, ${scheme} ${width}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings/spaces?hosted=1&mock=group-race&space=${ENG}`);
      await page
        .getByRole("combobox", { name: "Role for eng@example.com" })
        .click();
      await page.getByRole("option", { name: "Viewer" }).click();
      const msg = page.getByRole("status").filter({
        hasText: "This group's access just changed. Check it and try again.",
      });
      await expect(msg).toBeVisible();
      // On the group's row: directly under it in the Groups table.
      const table = page.getByRole("table", { name: "Groups" });
      await expect(
        table.getByText("This group's access just changed."),
      ).toBeVisible();
      await msg.scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`group-race-${scheme}-${width}.png`),
      });
    });

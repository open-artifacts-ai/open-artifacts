// The 409 conflict on Details, the Move dialog and Share visibility, at 1280
// and 390, light and dark: a status in warning colour, no alert.
import { expect, type Page, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const COPY = "This artifact just changed. Check it and try again.";
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const url = (tab: string) =>
        `/a/${LANDING}?hosted=1&mock=conflict&panel=open&tab=${tab}`;
      const shot = async (
        page: Page,
        info: { outputPath(n: string): string },
        n: string,
      ) => {
        await settle(page);
        await page.screenshot({
          path: info.outputPath(`${n}-${scheme}-${width}.png`),
        });
      };

      test("details", async ({ page }, info) => {
        await page.goto(url("details"));
        const title = page.getByRole("textbox", { name: "Title" });
        await title.fill("Renamed");
        await page.getByRole("button", { name: "Save" }).click();
        const note = page.getByRole("status").filter({ hasText: COPY });
        await expect(note).toBeVisible();
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(title).toHaveValue("Renamed");
        await note.scrollIntoViewIfNeeded();
        await shot(page, info, "conflict-details");
      });

      test("move dialog", async ({ page }, info) => {
        await page.goto(url("details"));
        await page.getByRole("button", { name: "Move", exact: true }).click();
        const d = page.getByRole("dialog", { name: /^Move/ });
        await d.getByRole("radio").first().check();
        await d.getByRole("button", { name: "Move", exact: true }).click();
        await expect(
          d.getByRole("status").filter({ hasText: COPY }),
        ).toBeVisible();
        await expect(d.getByRole("alert")).toHaveCount(0);
        await shot(page, info, "conflict-move");
      });

      test("share visibility", async ({ page }, info) => {
        await page.goto(url("share"));
        const group = page.getByRole("radiogroup", { name: "Visibility" });
        await group.getByRole("radio", { name: "Team" }).click();
        await page.getByRole("button", { name: "Save visibility" }).click();
        const note = page.getByRole("status").filter({ hasText: COPY });
        await expect(note).toBeVisible();
        await expect(
          group.getByRole("radio", { name: "Private" }),
        ).toBeChecked();
        await note.scrollIntoViewIfNeeded();
        await shot(page, info, "conflict-share");
      });
    });

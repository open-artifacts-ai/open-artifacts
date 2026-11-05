// #184: the settings, spaces and layout surfaces on shadcn Button, Dialog,
// Input, Select and Avatar, at 1280 and 390, light and dark. Dialogs keep
// their names and trap focus; each run attaches a screenshot.
import { expect, type Page, test } from "@playwright/test";

const ENG = "SpEngNpQrSt2uVwX";
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
/** Tab through the dialog: focus never leaves it. */
const trapped = async (
  page: Page,
  name: string,
  role: "dialog" | "alertdialog" = "dialog",
) => {
  const dlg = page.getByRole(role, { name });
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(
      true,
    );
  }
};

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = (
        page: Page,
        info: { outputPath(n: string): string },
        n: string,
      ) =>
        settle(page).then(() =>
          page.screenshot({
            path: info.outputPath(`${n}-${scheme}-${width}.png`),
          }),
        );

      test("library: header and card avatars", async ({ page }, info) => {
        await page.goto("/?hosted=1");
        await expect(
          page.getByRole("img", { name: /./ }).first(),
        ).toBeVisible();
        await shot(page, info, "library");
      });

      test("members: avatars", async ({ page }, info) => {
        await page.goto("/settings/members?hosted=1");
        await page.waitForLoadState("networkidle");
        await expect(
          page.getByRole("img", { name: /./ }).first(),
        ).toBeVisible();
        await shot(page, info, "members");
      });

      test("space people: avatars", async ({ page }, info) => {
        await page.goto(`/settings/spaces?hosted=1&space=${ENG}`);
        const card = page.getByRole("region", { name: "People" });
        await expect(card.getByText("Bob Builder")).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        await shot(page, info, "space-people");
      });

      test("create token dialog: name, focus trap", async ({ page }, info) => {
        await page.goto("/settings/connections");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Create token" }).click();
        const dlg = page.getByRole("dialog", { name: "Create token" });
        await expect(dlg.getByRole("textbox", { name: "Label" })).toBeFocused();
        await trapped(page, "Create token");
        await dlg.getByRole("textbox", { name: "Label" }).fill("ci");
        await shot(page, info, "create-token");
        await page.keyboard.press("Escape");
        await expect(dlg).toBeHidden();
        await expect(
          page.getByRole("button", { name: "Create token" }),
        ).toBeFocused();
      });

      test("revoke confirm dialog: name, focus trap", async ({
        page,
      }, info) => {
        await page.goto("/settings/connections");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Create token" }).click();
        await page.getByRole("textbox", { name: "Label" }).fill("old");
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await page.getByRole("button", { name: "Done" }).click();
        await page.getByRole("button", { name: "Revoke old" }).click();
        const dlg = page.getByRole("alertdialog", { name: 'Revoke "old"?' });
        await expect(dlg).toContainText(
          "Anything using it stops working immediately.",
        );
        await trapped(page, 'Revoke "old"?', "alertdialog");
        await expect(dlg.getByRole("button", { name: "Close" })).toHaveCount(0);
        await shot(page, info, "revoke-confirm");
      });

      test("move dialog: name, focus trap", async ({ page }, info) => {
        await page.goto("/?hosted=1");
        await page.getByRole("link", { name: "Landing page" }).first().click();
        await page.waitForURL(/\/a\//);
        if (width > 600)
          await page.getByRole("button", { name: /^Version: / }).click();
        else {
          await page.getByRole("button", { name: "More actions" }).click();
          await page.getByRole("menuitem", { name: "Versions" }).click();
        }
        await page.getByRole("tab", { name: "Details" }).click();
        await page.getByRole("button", { name: "Move" }).click();
        const dlg = page.getByRole("dialog", {
          name: 'Move "Landing page" to',
        });
        await dlg.getByRole("radio", { name: /^Engineering/ }).check();
        await trapped(page, 'Move "Landing page" to');
        await shot(page, info, "move");
      });

      test("upload dialog: Space select", async ({ page }, info) => {
        await page.goto(`/?hosted=1&space=${ENG}`);
        await page.waitForLoadState("networkidle");
        await page.getByTestId("upload-files").setInputFiles({
          name: "notes.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# x"),
        });
        const d = page.getByRole("dialog", { name: "Create artifact" });
        const space = d.getByRole("combobox", { name: "Space" });
        await expect(space).toHaveText(/Engineering/);
        await shot(page, info, "upload-space");
        await space.click();
        await expect(
          page.getByRole("option", { name: "Personal" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
      });

      test("update toast: one Toaster, Couldn't copy", async ({
        page,
      }, info) => {
        // No clipboard: Upgrade falls back to the toast.
        await page.addInitScript(() =>
          Object.defineProperty(navigator, "clipboard", { value: undefined }),
        );
        await page.goto("/settings/instance?mock=update");
        await page.getByRole("button", { name: "Upgrade" }).first().click();
        const toast = page
          .getByRole("alert")
          .filter({ hasText: "Couldn't copy" });
        await expect(toast).toBeVisible();
        await expect(
          page.getByText("Select the prompt and copy it yourself."),
        ).toBeVisible();
        // One Toaster in the whole app, so toasts never stack from two.
        await expect(page.locator("[data-sonner-toaster]")).toHaveCount(1);
        await shot(page, info, "update-toast");
      });

      test("dialog footers: stacked full width below 640px, inline above", async ({
        page,
      }) => {
        await page.goto("/settings/connections");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Create token" }).click();
        const dlg = page.getByRole("dialog", { name: "Create token" });
        // Measure at rest: the dialog zooms in.
        await settle(page);
        const create = await dlg
          .getByRole("button", { name: "Create", exact: true })
          .boundingBox();
        const cancel = await dlg
          .getByRole("button", { name: "Cancel" })
          .boundingBox();
        if (!create || !cancel) throw new Error("no footer buttons");
        if (width < 640) {
          expect(create.y).toBeLessThan(cancel.y);
          expect(Math.abs(create.width - cancel.width)).toBeLessThan(1);
          expect(create.width).toBeGreaterThan(300);
        } else {
          expect(Math.abs(create.y - cancel.y)).toBeLessThan(2);
          expect(create.x).toBeGreaterThan(cancel.x);
        }
      });

      test("not found: signed-in-as avatar", async ({ page }, info) => {
        await page.goto("/nope?hosted=1");
        await expect(page.getByText("Signed in as")).toBeVisible();
        await shot(page, info, "not-found");
      });
    });

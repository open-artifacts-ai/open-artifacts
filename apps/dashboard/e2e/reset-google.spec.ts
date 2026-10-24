// Hosted P4 Task 16: "Reset Google link…" in the Members row menu (Design
// D11). The owner resets Bob; an admin sees another admin's row (Erin) read-only;
// a stale owner_only 403 shows the owner copy. 1280 and 390, light and dark.
import { expect, type Page, test } from "@playwright/test";

const open = async (page: Page, hosted = "1") => {
  await page.goto(`/settings/members?hosted=${hosted}`);
  await page.waitForLoadState("networkidle");
};

const menuFor = async (page: Page, name: string) => {
  await page.getByRole("button", { name: `More for ${name}` }).click();
  return page.getByRole("menu");
};

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`reset ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = (page: Page, path: string) =>
        page.screenshot({ path, fullPage: true });

      test("the owner resets Bob's Google link", async ({ page }, info) => {
        await open(page);
        // Google-linked, so he has signed in (the shared fixture, #496).
        const bob = page.locator("li", { hasText: "Bob Builder" });
        await expect(bob).toContainText(/Active .+ ago/);
        await expect(bob).not.toContainText("Never signed in");
        const menu = await menuFor(page, "Bob Builder");
        await settle(page);
        await shot(page, info.outputPath(`reset-menu-${scheme}-${width}.png`));
        await menu
          .getByRole("menuitem", { name: "Reset Google link…" })
          .click();
        const d = page.getByRole("alertdialog");
        await expect(d).toContainText("Reset Google link for Bob Builder?");
        await settle(page);
        await shot(
          page,
          info.outputPath(`reset-confirm-${scheme}-${width}.png`),
        );
        await d.getByRole("button", { name: "Reset link" }).click();
        await expect(
          page.getByText(
            "Google link reset for Bob Builder. They're signed out and link again at their next Google sign-in.",
          ),
        ).toBeVisible();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        await settle(page);
        await shot(page, info.outputPath(`reset-done-${scheme}-${width}.png`));
      });

      test("an admin sees another admin's row read-only (Erin)", async ({
        page,
      }, info) => {
        await open(page, "1,admin");
        // #475: role as text, no menu (so no Reset or Remove).
        const erin = page.locator("li", { hasText: "Erin Admin" });
        await expect(erin.getByText("Admin", { exact: true })).toBeVisible();
        await expect(erin.getByRole("combobox")).toHaveCount(0);
        await expect(
          erin.getByRole("button", { name: "More for Erin Admin" }),
        ).toHaveCount(0);
        // And the muted line under Members says why.
        await expect(
          page.getByText("Only the owner can change another admin's access.", {
            exact: true,
          }),
        ).toBeVisible();
        await settle(page);
        await shot(
          page,
          info.outputPath(`members-admin-row-${scheme}-${width}.png`),
        );
      });

      test("a stale owner_only 403 shows the owner copy", async ({
        page,
      }, info) => {
        // The page still thinks you're the owner; the server says otherwise.
        // The mocks run in a service worker, so answer before fetch reaches it.
        await page.addInitScript(() => {
          const real = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const r = new Request(input, init);
            if (r.method !== "DELETE" || !r.url.endsWith("/identities/google"))
              return real(input, init);
            return Promise.resolve(
              Response.json(
                {
                  error: {
                    code: "owner_only",
                    message: "Only the owner can reset an admin's link",
                  },
                },
                { status: 403 },
              ),
            );
          };
        });
        await open(page);
        const menu = await menuFor(page, "Erin Admin");
        await menu
          .getByRole("menuitem", { name: "Reset Google link…" })
          .click();
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Reset link" })
          .click();
        await expect(
          page.getByText(
            "Only the owner can reset another admin's Google link.",
          ),
        ).toBeVisible();
        await expect(page.getByRole("alertdialog")).toHaveCount(0);
        await settle(page);
        await shot(
          page,
          info.outputPath(`reset-owner-only-${scheme}-${width}.png`),
        );
      });
    });

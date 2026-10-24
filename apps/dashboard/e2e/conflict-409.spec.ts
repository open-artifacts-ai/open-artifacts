// 409 conflict (Design): "This artifact just changed. Check it and try again."
// inline in Details, the Move dialog and Share's visibility. 390, light and dark.
// The mocks never conflict, so the 409 is answered before fetch reaches them.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page (Personal, owner)
const COPY = "This artifact just changed. Check it and try again.";

const conflictOn = (page: Page, method: string, suffix: string) =>
  page.addInitScript(
    ({ method, suffix }) => {
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const r = new Request(input, init);
        if (r.method !== method || !new URL(r.url).pathname.endsWith(suffix))
          return real(input, init);
        return Promise.resolve(
          Response.json(
            { error: { code: "conflict", message: "Conflict" } },
            { status: 409 },
          ),
        );
      };
    },
    { method, suffix },
  );
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  test.describe(`409 ${scheme} 390`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 390, height: 844 } });

    test("Details keeps your edits and says why above Save", async ({
      page,
    }, info) => {
      await conflictOn(page, "PATCH", `/artifacts/${ID}`);
      await page.goto(`/a/${ID}?panel=open&tab=details`);
      const title = page.getByRole("textbox", { name: "Title" });
      await title.fill("Landing page, mine");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(COPY)).toBeVisible();
      await expect(title).toHaveValue("Landing page, mine");
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`conflict-details-${scheme}-390.png`),
      });
    });

    test("Share puts visibility back and says why", async ({ page }, info) => {
      await conflictOn(page, "PATCH", `/artifacts/${ID}`);
      await page.goto(`/a/${ID}?panel=open&tab=share`);
      const group = page.getByRole("radiogroup", { name: "Visibility" });
      await group.getByRole("radio", { name: /Team/ }).click();
      await page.getByRole("button", { name: "Save visibility" }).click();
      await expect(page.getByText(COPY)).toBeVisible();
      await expect(
        group.getByRole("radio", { name: /Private/ }),
      ).toHaveAttribute("aria-checked", "true");
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`conflict-share-${scheme}-390.png`),
      });
    });

    test("Move keeps the dialog open and says why", async ({ page }, info) => {
      await conflictOn(page, "POST", `/artifacts/${ID}/move`);
      await page.goto(`/a/${ID}?panel=open&tab=details&hosted=1`);
      await page.getByRole("button", { name: "Move" }).click();
      const d = page.getByRole("dialog");
      await d.getByRole("radio", { name: /^Engineering/ }).check();
      await d.getByRole("button", { name: "Move" }).click();
      await expect(d.getByText(COPY)).toBeVisible();
      await settle(page);
      await page.screenshot({
        path: info.outputPath(`conflict-move-${scheme}-390.png`),
      });
    });
  });

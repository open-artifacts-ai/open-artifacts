// #184: the dashboard's notices on shadcn Alert (and Kbd), at 1280 and 390,
// light and dark. Roles and text hold; each run attaches a screenshot.
import { expect, type Page, test } from "@playwright/test";

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

const CASES = [
  {
    n: "quota",
    path: "/?mock=quota",
    role: "status",
    text: /daily|limit|quota/i,
  },
  {
    n: "cpu-free",
    path: "/?mock=cpu",
    role: "status",
    text: "Some requests hit Cloudflare's free CPU limit",
  },
  {
    n: "cpu-paid",
    path: "/?mock=paid-cpu",
    role: "status",
    text: "Some requests hit Cloudflare's CPU limit",
  },
  {
    n: "sync-danger",
    path: "/settings/profile?hosted=auth-failed",
    role: "alert",
    text: "Agent tokens aren't being re-checked",
  },
  {
    n: "sync-warning",
    path: "/?hosted=unhealthy",
    role: "status",
    text: "Agent tokens aren't being re-checked",
  },
  {
    n: "signin-error",
    path: "/sign-in?hosted=1&error=tenant",
    role: "alert",
    text: /./,
  },
  {
    n: "directory-error",
    path: "/settings/directory?hosted=1&error=access_denied",
    role: "alert",
    text: "Couldn't connect Google Workspace.",
  },
  {
    n: "directory-reason",
    path: "/settings/directory?hosted=1&error=denied",
    role: "alert",
    text: "Google access was declined.",
  },
] as const;

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      for (const c of CASES)
        test(`${c.n}: a ${c.role} with its text`, async ({ page }, info) => {
          await page.goto(c.path);
          const alert = page
            .getByRole(c.role)
            .filter({ hasText: c.text })
            .first();
          await expect(alert).toBeVisible();
          await settle(page);
          await page.screenshot({
            path: info.outputPath(`${c.n}-${scheme}-${width}.png`),
          });
        });

      test("create token dialog: Kbd in the save-token note", async ({
        page,
      }, info) => {
        await page.goto("/settings/agents");
        await page.waitForLoadState("networkidle");
        await page.getByRole("button", { name: "Create token" }).click();
        await page.getByRole("textbox", { name: "Label" }).fill("ci");
        await page.getByRole("button", { name: "Create", exact: true }).click();
        const made = page.getByRole("dialog", { name: "Token created" });
        await expect(made.locator("kbd")).toHaveText("!");
        await made.locator("kbd").scrollIntoViewIfNeeded();
        await settle(page);
        await page.screenshot({
          path: info.outputPath(`kbd-${scheme}-${width}.png`),
        });
      });
    });

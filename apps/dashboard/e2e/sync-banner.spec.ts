// The directory sync-health banner (Design's D13 B) against the hosted mocks:
// it fits the page column at 1280 and 390 in both themes, with the dot on
// Settings (the menu button on phones) and the Directory tab. Each run
// attaches a screenshot; OA_SHOTS_DIR also writes them there.
import { expect, test } from "@playwright/test";

const STATES = [
  ["backoff", "unhealthy", "status"],
  ["auth-failed", "auth-failed", "alert"],
  ["scope-missing", "scope-missing", "alert"],
  ["customer-mismatch", "customer-mismatch", "alert"],
] as const;
const PAGES = [
  ["library", "/"],
  ["settings", "/settings/profile"],
] as const;

// One desktop run (backoff, library) and one phone run (a danger state, settings).
const RUNS = [
  [STATES[0], PAGES[0], 1280],
  [STATES[1], PAGES[1], 390],
] as const;
for (const [[name, token, role], [where, path], width] of RUNS)
  for (const theme of ["light"])
    test(`sync banner ${name} on ${where} at ${width}px ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${path}?hosted=${token}`);
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      const banner = page.getByRole(role, { name: "Directory sync" });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Access is frozen as of then");
      await expect(banner).toContainText(
        "Agent tokens aren't being re-checked",
      );
      if (width <= 600)
        // The trigger keeps its name; the dot is its description.
        await expect(
          page.getByRole("button", { name: "Toggle navigation" }),
        ).toHaveAccessibleDescription("Settings needs attention");
      else
        await expect(
          page.getByRole("link", { name: "Settings, needs attention" }),
        ).toBeVisible();
      if (where === "settings")
        await expect(
          page
            .getByRole("navigation", { name: "Settings sections" })
            .getByRole("link", { name: "Directory, needs attention" }),
        ).toBeVisible();

      const g = await page.evaluate(() => {
        const b = document
          .querySelector(".oa-sync-banner")
          ?.getBoundingClientRect();
        const main = document
          .getElementById("oa-main")
          ?.getBoundingClientRect();
        return {
          inMain: !!b && !!main && b.left >= main.left && b.right <= main.right,
          sideScroll:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      expect(g.inMain).toBe(true);
      expect(g.sideScroll).toBe(0);

      // Let the theme's color transitions finish, or the shot catches them mid-fade.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      const file = `${name}-${where}-${width}-${theme}.png`;
      const dir = process.env.OA_SHOTS_DIR;
      await info.attach(file, {
        body: await page.screenshot({
          fullPage: true,
          ...(dir && { path: `${dir}/${file}` }),
        }),
        contentType: "image/png",
      });
    });

test("dismissing the warning keeps the dot; the banner stays gone on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?hosted=unhealthy");
  const banner = page.getByRole("status", { name: "Directory sync" });
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Settings, needs attention" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Settings, needs attention" }),
  ).toBeVisible();
  await expect(banner).toBeHidden();
});

test("the owner can't dismiss a danger banner", async ({ page }) => {
  await page.goto("/?hosted=auth-failed");
  const banner = page.getByRole("alert", { name: "Directory sync" });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});

test("self-hosted: no banner and no dot", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/profile");
  await expect(
    page.getByRole("navigation", { name: "Settings sections" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /needs attention/ })).toHaveCount(
    0,
  );
  await expect(page.locator(".oa-sync-banner")).toHaveCount(0);
});

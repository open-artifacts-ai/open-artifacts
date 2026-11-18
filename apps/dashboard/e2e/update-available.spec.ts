// "Update available" (Design's A + B): the sidebar chip and its popover, the
// Settings → Instance Version card, and who sees them.
import { expect, type Page, test } from "@playwright/test";

const COPIED = "Copied, paste this into your agent";
const chip = (page: Page) =>
  page.getByRole("button", { name: /^Update available/ });
const box = async (page: Page, sel: Parameters<Page["locator"]>[0]) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return b;
};

test("admin: the chip opens the popover; Upgrade copies the prompt", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?mock=update");
  const c = chip(page);
  await expect(c).toHaveAttribute("aria-haspopup", "dialog");
  await expect(c).toHaveAttribute("aria-expanded", "false");
  await expect(c).toContainText("v0.15.0");
  await c.click();
  await expect(c).toHaveAttribute("aria-expanded", "true");
  const pop = page.getByRole("dialog", { name: "Update available" });
  await expect(pop).toContainText("v0.14.2");
  await expect(pop).toContainText("v0.15.0");
  await expect(pop.getByRole("status")).toBeEmpty();
  await pop.getByRole("button", { name: "Upgrade", exact: true }).click();
  await expect(pop.getByRole("status")).toHaveText(COPIED);
  const origin = new URL(baseURL ?? page.url()).origin;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Upgrade my Open Artifacts instance at ${origin}. Follow ${origin}/upgrade.md`,
  );
  await expect(
    pop.getByRole("link", { name: /Release notes/ }),
  ).toHaveAttribute("target", "_blank");
  // Esc closes it and puts focus back on the chip.
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(c).toBeFocused();
  // Details in Settings goes to the Version card and closes the popover.
  await c.click();
  await pop.getByRole("link", { name: "Details in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/instance/);
  await expect(pop).toBeHidden();
  await expect(page.getByRole("region", { name: "Version" })).toBeVisible();
});

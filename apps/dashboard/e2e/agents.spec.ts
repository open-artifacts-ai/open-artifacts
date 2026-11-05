// The Agents page must not scroll sideways at 390px.
import { expect, type Page, test } from "@playwright/test";

const sideScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

test("Agents page has no horizontal page scroll at 390px (token variant)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/connections");
  await page.getByRole("radio", { name: "Token" }).click();
  await expect(page.getByText(/claude mcp add/)).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

// Command blocks in the Token tab and the token-created dialog wrap: no line
// is cut off or scrolls, and nothing overflows at 390px.
const clipped = (page: Page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll("pre")].filter(
        (p) => p.scrollWidth > p.clientWidth + 1,
      ).length,
  );

test("Token tab and token-created dialog wrap their commands at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/connections");
  await page.getByRole("radio", { name: "Token" }).click();
  for (const name of ["Claude Code", "Codex CLI", "OpenCode"]) {
    await page.getByRole("tab", { name }).click();
    expect(await clipped(page)).toBe(0);
  }
  expect(await sideScroll(page)).toBe(0);

  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByRole("textbox", { name: "Label" }).fill("ci");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Token created" });
  await expect(dialog.getByText(/umask 077/)).toBeVisible();
  for (const tab of await dialog.getByRole("tab").all()) {
    await tab.click();
    expect(await clipped(page)).toBe(0);
    const out = await dialog.evaluate((d) => {
      const r = d.getBoundingClientRect();
      // The tab strip scrolls sideways by design; its tabs may sit past it.
      return [...d.querySelectorAll("*:not([role=tablist] *)")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5);
      }).length;
    });
    expect(out).toBe(0);
  }
  // Copy stays top-right of the save command.
  const pre = await dialog.locator("pre").first().boundingBox();
  const copy = await dialog
    .getByRole("button", { name: "Copy save command" })
    .boundingBox();
  expect(pre && copy).toBeTruthy();
  if (pre && copy) {
    expect(copy.x).toBeGreaterThanOrEqual(pre.x + pre.width);
    expect(copy.y - pre.y).toBeLessThan(8);
  }
});

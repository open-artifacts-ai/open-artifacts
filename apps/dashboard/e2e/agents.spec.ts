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

test("OAuth command and client tabs wrap at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/connections");
  await expect(page.getByText(/claude mcp add/)).toBeVisible();
  // The command wraps instead of scrolling (the admin card's fix, #1128).
  expect(await clipped(page)).toBe(0);
  // The strip scrolls sideways inside its own box (#2103), and the picked tab
  // is scrolled into view: first one, then the last. The page never scrolls.
  const list = page.getByRole("tablist").first();
  const selectedInView = () =>
    list.evaluate((l) => {
      const box = l.getBoundingClientRect();
      const t = l.querySelector("[role=tab][aria-selected=true]");
      const b = t?.getBoundingClientRect();
      return !!b && b.right <= box.right + 0.5 && b.left >= box.left - 0.5;
    });
  await expect.poll(selectedInView).toBe(true);
  // By keyboard, so the strip's own scroll-into-view is what is tested (a
  // click scrolls the tab into view itself): focus the first tab, press End.
  await page.getByRole("tab", { name: "Claude Code" }).first().focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "Generic" }).first(),
  ).toHaveAttribute("aria-selected", "true");
  await expect.poll(selectedInView).toBe(true);
  expect(await sideScroll(page)).toBe(0);
});

const VIEWPORT_H = 600;

test("Token tab and token-created dialog wrap their commands at 390px", async ({
  page,
}) => {
  // A short phone screen, so the dialog is certain to be taller than it.
  await page.setViewportSize({ width: 390, height: VIEWPORT_H });
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
      const strip = d.querySelector("[role=tablist]");
      return {
        // What the tab strip holds is clipped by it, not overflowing.
        outside: [...d.querySelectorAll("*")].filter((el) => {
          if (el.parentElement?.closest("[role=tablist]")) return false;
          const b = el.getBoundingClientRect();
          return b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5);
        }).length,
        // The strip may scroll sideways inside its own box, never past it.
        stripFits: strip
          ? strip.getBoundingClientRect().right <= r.right + 0.5 &&
            strip.getBoundingClientRect().left >= r.left - 0.5
          : true,
      };
    });
    expect(out).toEqual({ outside: 0, stripFits: true });
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
  // The body is taller than this short screen: the dialog caps itself and
  // scrolls, so Done stays reachable instead of hanging past the viewport.
  const box = await dialog.evaluate((d) => ({
    height: d.getBoundingClientRect().height,
    scrollable: d.scrollHeight - d.clientHeight,
    overflow: getComputedStyle(d).overflowY,
  }));
  expect(box.height).toBeLessThanOrEqual(VIEWPORT_H);
  expect(box.overflow).toBe("auto");
  expect(box.scrollable).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

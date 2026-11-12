// A posted comment shows at once (with a slow server), stays one comment, and
// rolls back with its text on an error.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const SHOTS = process.env.OA_SHOTS_DIR;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** Wrap fetch before the mock sees it: POSTs to comments wait `delay` ms, or fail with `fail`. */
const slowOrBroken = (page: Page, o: { delay?: number; fail?: number }) =>
  page.addInitScript((o) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (
        init?.method ??
        (input as Request).method ??
        "GET"
      ).toUpperCase();
      if (method === "POST" && /\/comments(\/[^/]+\/replies)?$/.test(url)) {
        await new Promise((r) => setTimeout(r, o.delay ?? 0));
        if (o.fail)
          return new Response(
            JSON.stringify({ error: { code: "rate_limited", message: "x" } }),
            { status: o.fail, headers: { "content-type": "application/json" } },
          );
      }
      return real(input, init);
    };
  }, o);

const open = async (page: Page, w: number, h: number) => {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  return page.getByRole("textbox", { name: "Comment on the whole page" });
};

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`${w}px ${scheme}: slow server, the comment shows at once and stays one`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await slowOrBroken(page, { delay: 1500 });
      const box = await open(page, w, h);
      await box.fill("Posted with a slow server");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const row = page
        .locator("[data-comment]")
        .filter({ hasText: "Posted with a slow server" });
      await expect(row).toBeVisible({ timeout: 500 });
      await expect(row).toHaveAttribute("data-sending", "");
      await expect(box).toHaveValue("");
      await row.scrollIntoViewIfNeeded();
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/sending-${w}-${scheme}.png`,
        });
      await expect(row).not.toHaveAttribute("data-sending", "", {
        timeout: 5000,
      });
      await page.waitForTimeout(800);
      await expect(
        page
          .locator("[data-comment]")
          .filter({ hasText: "Posted with a slow server" }),
      ).toHaveCount(1);
    });

test("an error rolls the comment back and the text returns", async ({
  page,
}) => {
  await slowOrBroken(page, { delay: 300, fail: 429 });
  const box = await open(page, 1280, 800);
  await box.fill("This will fail");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const row = page
    .locator("[data-comment]")
    .filter({ hasText: "This will fail" });
  await expect(row).toBeVisible({ timeout: 250 });
  await expect(
    page.getByText("Too many comments. Try again in a minute."),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(box).toHaveValue("This will fail");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rollback-1280.png` });
});

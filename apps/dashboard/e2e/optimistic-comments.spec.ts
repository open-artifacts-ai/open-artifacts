// A posted comment shows at once (with a slow server), stays one comment, and
// rolls back with its text on an error.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const SHOTS = process.env.OA_SHOTS_DIR;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** Wrap fetch before the mock sees it: gate comment POSTs on a signal, and count post-release GET refetches. */
const gateComments = (page: Page, o: { fail?: number } = {}) =>
  page.addInitScript((o) => {
    const w = window as unknown as {
      __releasePost: () => void;
      __refetchCount: number;
    };
    let release: (() => void) | undefined;
    let released = false;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    w.__refetchCount = 0;
    w.__releasePost = () => {
      released = true;
      release?.();
    };
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (
        init?.method ??
        (input as Request).method ??
        "GET"
      ).toUpperCase();
      if (method === "POST" && /\/comments(\/[^/]+\/replies)?$/.test(url)) {
        await gate;
        if (o.fail)
          return new Response(
            JSON.stringify({ error: { code: "rate_limited", message: "x" } }),
            { status: o.fail, headers: { "content-type": "application/json" } },
          );
      }
      const res = await real(input, init);
      if (released && method === "GET" && /\/comments(\?|$)/.test(url))
        w.__refetchCount++;
      return res;
    };
  }, o);

const open = async (page: Page, w: number, h: number) => {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  return page.getByRole("textbox", { name: "Comment on the whole page" });
};

for (const [w, h] of [[1280, 800]] as const)
  for (const scheme of ["light"] as const)
    test(`${w}px ${scheme}: slow server, the comment shows at once and stays one`, {
      tag: w === 1280 && scheme === "light" ? "@smoke" : [],
    }, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gateComments(page);
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
          animations: "disabled",
        });
      await page.evaluate(() =>
        (window as unknown as { __releasePost: () => void }).__releasePost(),
      );
      await expect(row).not.toHaveAttribute("data-sending", "", {
        timeout: 5000,
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { __refetchCount: number }).__refetchCount,
          ),
        )
        .toBeGreaterThanOrEqual(1);
      await expect(
        page
          .locator("[data-comment]")
          .filter({ hasText: "Posted with a slow server" }),
      ).toHaveCount(1);
    });

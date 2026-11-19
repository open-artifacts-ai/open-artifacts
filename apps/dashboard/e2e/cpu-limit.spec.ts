import { expect, type Page, test } from "@playwright/test";

const TITLE = "Some requests hit Cloudflare's free CPU limit";
const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: TITLE });

/**
 * Opens `path` and waits for /me, whose `instance.plan` picks the CPU copy,
 * asserting the plan the test runs under. Copy assertions come after, so none
 * races /me.
 */
const open = async (page: Page, path: string, plan: "free" | "paid") => {
  const me = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/me" && r.ok(),
  );
  await page.goto(path);
  const body = (await (await me).json()) as { instance: { plan: string } };
  expect(body.instance.plan).toBe(plan);
};

test("owner: the CPU banner shows today's hits and stays dismissed for the day", async ({
  page,
}) => {
  // Midday UTC, so the dismissed day can't roll over before the reload. Timers stay real.
  const noon = new Date();
  noon.setUTCHours(12, 0, 0, 0);
  await page.clock.setFixedTime(noon);
  await open(page, "/?mock=cpu", "free");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(
    "Your instance hit the limit 4 times today",
  );
  await expect(page.getByRole("link", { name: /See plans/ })).toHaveAttribute(
    "href",
    "https://dash.cloudflare.com/?to=/:account/workers/plans",
  );
  await banner(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(page)).toHaveCount(0);
  await page.reload();
  // The mock answers the first two library requests of every load with a 1102,
  // so the list arrives after the library's retry backoff.
  await expect(page.getByRole("article").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(banner(page)).toHaveCount(0);
});

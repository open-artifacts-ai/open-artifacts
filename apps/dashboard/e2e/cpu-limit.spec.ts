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

/**
 * The viewer's slow notice fires SLOW_MS after the frame loads. A fake clock
 * replaces the wait, and a counter of frame loads says when the timer is armed:
 * the load listener (React's onLoad) runs in the same dispatch as ours, so once
 * the count is seen the timer exists and one fast-forward fires it. No retries,
 * no sleeps, and nothing depends on how long the machine takes. Call before
 * `open`; returns `slow()`, which waits for the next load and fires the timer.
 */
const silentFrame = async (page: Page) => {
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as unknown as { __frameLoads: number };
    w.__frameLoads = 0;
    document.addEventListener(
      "load",
      (e) => {
        // Only content loads: a new frame first loads about:blank (no src
        // yet), which the viewer ignores and which arms no timer.
        const t = e.target as Element;
        if (t.tagName === "IFRAME" && t.getAttribute("src")) w.__frameLoads++;
      },
      true,
    );
  });
  // A frame that loads but never says hello.
  await page.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>No runtime here</p>" }),
  );
  let loads = 0;
  return async () => {
    loads++;
    await page.waitForFunction(
      (n) => (window as unknown as { __frameLoads: number }).__frameLoads >= n,
      loads,
    );
    await page.clock.fastForward(8_000);
    await expect(page.locator(".oa-vnotice")).toBeVisible();
  };
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
  // At 1280 the banner lines up with the page's content column.
  await page.setViewportSize({ width: 1280, height: 900 });
  const [b, h1] = await Promise.all([
    banner(page).boundingBox(),
    page.getByRole("heading", { name: "Library", level: 1 }).boundingBox(),
  ]);
  expect(Math.abs((b?.x ?? 0) - (h1?.x ?? -1))).toBeLessThanOrEqual(0.5);
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

test("member: a real 1102 response raises the member banner", async ({
  page,
}) => {
  await open(page, "/?mock=cpu&role=member", "free");
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText(
    "A request just hit Cloudflare's free CPU limit.",
  );
  await expect(banner(page)).toContainText(
    "Ask your instance owner about upgrading.",
  );
  await expect(page.getByRole("link", { name: /See plans/ })).toHaveCount(0);
  await expect(page.getByRole("article").first()).toBeVisible();
});

test("no CPU banner without CPU trouble", async ({ page }) => {
  await open(page, "/", "free");
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.getByText(TITLE)).toHaveCount(0);
});

test("viewer: a silent frame gets the CPU notice above it, upsell after 2 reloads", async ({
  page,
}) => {
  const slow = await silentFrame(page);
  await open(page, "/a/Ef7hJkLmNp8qRsTv?mock=cpu", "free");
  const notice = page.locator(".oa-vnotice");
  const frame = page.locator("iframe.oa-vframe");
  await expect(frame).toBeVisible();
  await expect(notice).toHaveCount(0);
  await slow();
  // Usage (the CPU signal) can land after the notice; wait on it, not on time.
  await expect(notice).toContainText(
    "This artifact may have hit your instance's CPU limit. Reloading usually works.",
  );
  await expect(frame).toBeVisible();
  await expect(notice).not.toContainText("Workers Paid");
  for (let i = 0; i < 2; i++) {
    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(notice).toHaveCount(0);
    await slow();
  }
  await expect(notice).toContainText("Workers Paid raises the limit.");
  await expect(notice.getByRole("link", { name: /See plans/ })).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
  await expect(frame).toBeVisible();
});

test("Paid: the banner reports the 30-second limit with no upgrade pitch (#279)", async ({
  page,
}) => {
  await open(page, "/?mock=paid-cpu", "paid");
  const paid = page
    .getByRole("status")
    .filter({ hasText: "Some requests hit Cloudflare's CPU limit" });
  await expect(paid).toBeVisible();
  await expect(paid).toContainText(
    "Your instance hit the 30-second per-request limit 4 times today.",
  );
  await expect(paid.getByRole("link", { name: "View usage" })).toBeVisible();
  await expect(
    paid.getByRole("link", { name: /Report an issue/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/open-artifacts-ai/open-artifacts/issues/new",
  );
  await expect(paid).not.toContainText("Workers Paid");
  await paid.getByRole("link", { name: "View usage" }).click();
  await expect(page).toHaveURL(/\/settings\/usage/);
});

test("Paid: a silent frame gets the 30-second notice (#279)", async ({
  page,
}) => {
  const slow = await silentFrame(page);
  await open(page, "/a/Ef7hJkLmNp8qRsTv?mock=paid-cpu", "paid");
  const notice = page.locator(".oa-vnotice");
  await slow();
  // Usage (the CPU signal) can land after the notice; wait on it, not on time.
  await expect(notice).toContainText(
    "This request hit Cloudflare's 30-second CPU limit. Try again.",
  );
  await expect(notice.getByRole("link")).toHaveCount(0);
  await expect(page.locator("iframe.oa-vframe")).toBeVisible();
});

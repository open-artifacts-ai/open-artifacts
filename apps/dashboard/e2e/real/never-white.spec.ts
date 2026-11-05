import type { Page } from "@playwright/test";
import { LOAD_TIMEOUT_MS } from "../../src/viewer/FrameLoader";
import {
  APP,
  artifactFrame,
  CONTENT_HOST,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// #693: in dark mode, opening an artifact never flashes white, even when the
// artifact is slow to load. Screenshots are taken every 100 ms while the
// content host is held back, and none may have a white patch.
const DARK_PAGE = `<!doctype html>
<style>html,body{margin:0;background:#202124;color:#e8eaed}</style>
<p id="ready">dark artifact</p>`;

/** Share of near-white pixels (all channels ≥ 235) in a PNG, decoded in `decoder`. */
async function whiteShare(decoder: Page, png: Buffer): Promise<number> {
  return decoder.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    if (!g) return 1;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let white = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] >= 235 && d[i + 1] >= 235 && d[i + 2] >= 235) white++;
    return white / (d.length / 4);
  }, png.toString("base64"));
}

for (const mode of ["viewer", "full screen"] as const)
  test(`dark mode, ${mode}: opening a slow artifact never shows a white frame`, async ({
    browser,
    member,
  }) => {
    const { id } = await publishViaApi(member.pat, {
      title: `Never white ${uniq()}`,
      format: "html",
      content: DARK_PAGE,
      visibility: "public",
    });
    const ctx = await browser.newContext({ baseURL: APP, colorScheme: "dark" });
    const page = await ctx.newPage();
    const decoder = await ctx.newPage();
    // Hold the artifact back (3 s) so the load window is long enough to sample.
    await page.route(`http://${CONTENT_HOST}/**`, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    const path = mode === "viewer" ? `/a/${id}` : `/a/${id}/full`;
    const nav = page.goto(path, { waitUntil: "commit" });
    const ready = artifactFrame(page).locator("#ready");
    const shares: number[] = [];
    await nav;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // A capture can fail mid-navigation; skip it and sample again.
      const png = await page.screenshot().catch(() => null);
      if (png) shares.push(await whiteShare(decoder, png));
      if (await ready.isVisible().catch(() => false)) break;
      await page.waitForTimeout(100);
    }
    await expect(ready).toBeVisible();
    // One more after it painted: the artifact's own dark page, still no white.
    shares.push(await whiteShare(decoder, await page.screenshot()));
    expect(shares.length).toBeGreaterThan(3);
    expect(Math.max(...shares)).toBeLessThan(0.01);
    await ctx.close();
  });

test("the loader shows after a delay, hides when the artifact is ready, and a stuck load offers Retry", async ({
  browser,
  member,
}) => {
  test.setTimeout(90_000);
  const { id } = await publishViaApi(member.pat, {
    title: `Loader ${uniq()}`,
    format: "html",
    content: DARK_PAGE,
    visibility: "public",
  });
  const ctx = await browser.newContext({ baseURL: APP });
  const page = await ctx.newPage();
  const loader = page.locator(".oa-vloader");
  const ready = artifactFrame(page).locator("#ready");
  // Slow (1.5 s): the hairline fades in, then goes once the artifact is ready.
  let hold = 1500;
  let stuck = false;
  await page.route(`http://${CONTENT_HOST}/**`, async (route) => {
    if (stuck) return; // never answered: a stuck load
    await new Promise((r) => setTimeout(r, hold));
    await route.continue();
  });
  await page.goto(`/a/${id}`);
  await expect(loader).toHaveAttribute("data-on", "");
  await expect(page.locator(".oa-vmain")).toHaveAttribute("aria-busy", "true");
  await expect(ready).toBeVisible();
  await expect(loader).not.toHaveAttribute("data-on", "");
  await expect(page.locator(".oa-vmain")).not.toHaveAttribute("aria-busy");
  // Stuck: after 10 s the timeout message replaces the loader; Retry loads it.
  stuck = true;
  await page.reload();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Taking longer than usual" });
  // LOAD_TIMEOUT_MS starts once the shell has booted: a deadline on top of it.
  await expect(alert).toBeVisible({ timeout: LOAD_TIMEOUT_MS + 15_000 });
  await expect(alert).toContainText("This artifact hasn't finished loading.");
  stuck = false;
  hold = 0;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(ready).toBeVisible();
  await expect(alert).toBeHidden();
  await ctx.close();
});

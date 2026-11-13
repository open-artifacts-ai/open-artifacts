// #2172: the viewer never scrolls the document. The app fills the window; only
// the frame and the comments panel scroll inside themselves.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const TALL = `<!doctype html><body style="margin:0"><div style="height:3000px;background:linear-gradient(#fff,#ccc)">tall</div>`;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: TALL }),
  );
});

const doc = (page: Page) =>
  page.evaluate(() => {
    const s = document.scrollingElement as HTMLElement;
    window.scrollTo(0, 99999);
    return {
      scrollHeight: s.scrollHeight,
      innerHeight: innerHeight,
      scrollY: Math.round(scrollY),
    };
  });

async function scrollInner(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("*"))
      if (el.scrollHeight > el.clientHeight + 1) {
        const o = getComputedStyle(el).overflowY;
        if (o === "auto" || o === "scroll") el.scrollTop = el.scrollHeight;
      }
  });
}

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  for (const full of [false, true])
    test(`${w}px${full ? " full screen" : ""}: the document never scrolls`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/a/${ID}${full ? "/full" : ""}?mock=agents`);
      const open = page.getByRole("button", { name: /^Comments/ });
      await open.click();
      await expect(
        page.getByRole("textbox", { name: "Comment on the whole page" }),
      ).toBeVisible();
      const before = await doc(page);
      console.log(`PROBE ${w} full=${full} before`, JSON.stringify(before));
      await scrollInner(page);
      const after = await doc(page);
      console.log(`PROBE ${w} full=${full} after`, JSON.stringify(after));
      for (const m of [before, after]) {
        expect(m.scrollHeight).toBe(m.innerHeight);
        expect(m.scrollY).toBe(0);
      }
    });

// The user's repro: expanding "N replies" scrolls the open card into view. A
// stray overflowing element (a popover, a tall child) must never make the
// document scroll, and scrolling the card must stay inside the panel.
for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  for (const stray of [false, true])
    test(`${w}px: expanding replies${stray ? " with an overflowing child" : ""} leaves the document alone`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/a/${ID}?mock=agents`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      await expect(
        page.getByRole("textbox", { name: "Comment on the whole page" }),
      ).toBeVisible();
      if (stray)
        await page.evaluate(() => {
          const d = document.createElement("div");
          d.style.cssText =
            "position:absolute;left:0;top:100%;height:300px;width:10px";
          document.querySelector(".oa-vbody")?.append(d);
        });
      await page
        .getByRole("button", { name: /Show \d+ earlier repl/ })
        .first()
        .click();
      await page.waitForTimeout(700);
      const m = await doc(page);
      expect(m.scrollHeight).toBe(m.innerHeight);
      expect(m.scrollY).toBe(0);
    });

// #2172 root cause: the sr-only "linked, " spans of linked-agent comments are
// position:absolute; with the comments column static they escaped its scroll
// clip and stretched the document.
for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`${w}px: expanding a long linked-agent thread leaves the document alone`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    await page
      .getByRole("button", { name: /^Show 1\d earlier replies$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    const m = await doc(page);
    expect(m.scrollHeight).toBe(m.innerHeight);
    await page.evaluate(() => window.scrollBy(0, 500));
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });

// The full-page panels under .oa-bare have no viewer: when they are taller
// than the window they scroll inside the column, so their last button is
// reachable (the clip applies only while a viewer is mounted).
test("a tall full-page panel (not found) scrolls to its last action at 390x200", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 200 });
  await page.goto("/a/Zz9yXwVuTsRqPoNm");
  const panel = page.locator(".oa-bare > .oa-edge");
  await expect(panel).toBeVisible();
  const last = panel.locator("a, button").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  const m = await doc(page);
  expect(m.scrollY).toBe(0);
  // And the top: the heading is reachable, not cut off above the scroll origin.
  await panel.evaluate((el) => {
    el.scrollTop = 0;
  });
  const h1 = panel.locator("h1");
  expect((await h1.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await expect(h1).toBeInViewport();
});

test("a short full-page panel stays vertically centered", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/a/Zz9yXwVuTsRqPoNm");
  const box = await page
    .locator(".oa-bare > .oa-edge > .oa-panel")
    .boundingBox();
  const edge = await page.locator(".oa-bare > .oa-edge").boundingBox();
  expect(box && edge).toBeTruthy();
  if (!box || !edge) return;
  const above = box.y - edge.y;
  const below = edge.y + edge.height - (box.y + box.height);
  expect(Math.abs(above - below)).toBeLessThanOrEqual(2);
});

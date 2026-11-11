// #290 (mock): /a/<id>/full is the frame alone, filling the window; the
// title bar's "Full screen" opens it in a new tab and the ••• menu copies its
// link. No "Open raw" anywhere.
import { expect, test } from "@playwright/test";

// The artifact says hello (with the bridge's nonce), so the slow notice never
// shows up and shifts the frame on a loaded machine.
test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
        parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
      </script>`,
    }),
  );
});

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
type Box = { x: number; y: number; width: number; height: number };

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`full screen at ${width}px ${theme}: the frame fills the window below the strip`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/a/${ID}/full`);
      const frame = page.locator("iframe.oa-vframe");
      await expect(frame).toBeVisible();
      const strip = await page.locator(".oa-fsbar").boundingBox();
      expect(strip).toEqual({ x: 0, y: 0, width, height: 36 });
      // The strip never overlaps the artifact: the frame starts below it.
      expect(await frame.boundingBox()).toEqual({
        x: 0,
        y: 36,
        width,
        height: 764,
      });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "More actions" }),
      ).toHaveCount(0);
      await info.attach(`full-${width}-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    });

test("Full screen opens /a/<id>/full in a new tab", async ({
  page,
  context,
}) => {
  await page.goto(`/a/${ID}`);
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Full screen" }).click(),
  ]);
  await expect(tab).toHaveURL(new RegExp(`/a/${ID}/full$`));
  await expect(tab.locator("iframe.oa-vframe")).toBeVisible();
  await expect(page.getByText("Open raw")).toHaveCount(0);
});

test("the ••• menu copies the full-screen link, with a toast", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/a/${ID}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Open raw" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Copy full-screen link" }).click();
  await expect(page.getByText("Full-screen link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    new RegExp(`/a/${ID}/full$`),
  );
});

test("phones: Full screen is in the ••• menu", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/${ID}`);
  await expect(page.getByRole("link", { name: "Full screen" })).toBeHidden();
  await page.getByRole("button", { name: "More actions" }).click();
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("menuitem", { name: "Full screen" }).click(),
  ]);
  await expect(tab).toHaveURL(new RegExp(`/a/${ID}/full$`));
});

// Option B (#2112): the strip above the frame.
const FULL = `/a/${ID}/full`;
const TOP = "Exit full screen";
// Real embeds are public-only (a framed shell runs anonymously).
const PUBLIC_FULL = "/a/Gh9kLmNpQrAsTuVx/full"; // Team poll
const EMBED = "Open Team poll in Open Artifacts (opens in new tab)";

test.describe("full-screen strip", () => {
  for (const width of [1280, 390])
    test(`the strip ends at or above the frame at ${width}px, and holds the title and controls in order`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(FULL);
      const exit = page.getByRole("link", { name: TOP });
      await expect(exit).toBeVisible();
      const strip = (await page.locator(".oa-fsbar").boundingBox()) as Box;
      const frame = (await page
        .locator("iframe.oa-vframe")
        .boundingBox()) as Box;
      expect(strip.y + strip.height).toBeLessThanOrEqual(frame.y);
      expect(strip.height).toBeGreaterThanOrEqual(32);
      expect(strip.height).toBeLessThanOrEqual(36);
      const title = (await page.locator(".oa-fstitle").boundingBox()) as Box;
      const comments = (await page
        .getByRole("button", { name: /^Comments/ })
        .boundingBox()) as Box;
      const out = (await exit.boundingBox()) as Box;
      await expect(page.locator(".oa-fstitle")).toHaveText("Landing page");
      expect(title.x + title.width).toBeLessThanOrEqual(comments.x);
      expect(comments.x + comments.width).toBeLessThanOrEqual(out.x);
      // Nothing of the strip sits over the frame.
      for (const b of [title, comments, out])
        expect(b.y + b.height).toBeLessThanOrEqual(frame.y);
      // The label shows from 600px and up; the name stays either way.
      await expect(page.locator(".oa-fsx-label")).toBeVisible({
        visible: width > 600,
      });
      await expect(exit).toHaveAccessibleName(TOP);
      expect(out.height).toBeGreaterThanOrEqual(28);
    });

  test("a long title truncates with an ellipsis", async ({ page }) => {
    await page.goto(FULL);
    await page.setViewportSize({ width: 390, height: 800 });
    const t = page.locator(".oa-fstitle");
    await t.evaluate((e) => {
      e.textContent = "A very long artifact title ".repeat(10);
    });
    expect(
      await t.evaluate((e) => [
        getComputedStyle(e).textOverflow,
        e.scrollWidth > e.clientWidth,
      ]),
    ).toEqual(["ellipsis", true]);
  });

  test("Esc goes back to the viewer, in the same tab", async ({ page }) => {
    await page.goto(FULL);
    await expect(page.getByRole("link", { name: TOP })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/a/${ID}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("the exit link is the last Tab stop and shows a focus ring", async ({
    page,
  }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(chip).toBeFocused();
    expect(await chip.evaluate((e) => getComputedStyle(e).outlineStyle)).toBe(
      "solid",
    );
  });

  test("the comments surface opens below the strip", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(FULL);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const strip = (await page.locator(".oa-fsbar").boundingBox()) as Box;
    const surface = page.getByRole("dialog");
    await expect(surface).toBeVisible();
    const box = (await surface.boundingBox()) as Box;
    expect(box.y).toBeGreaterThanOrEqual(strip.y + strip.height);
  });

  test("hidden when printed", async ({ page }) => {
    await page.goto(FULL);
    const bar = page.locator(".oa-fsbar");
    await expect(bar).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(bar).toBeHidden();
  });

  test("embedded: the title and one link that opens a new tab; no Esc", async ({
    page,
  }) => {
    await page.route("**/__embed", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<iframe src="${PUBLIC_FULL}" style="width:800px;height:500px;border:0"></iframe>`,
      }),
    );
    await page.goto("/__embed");
    const frame = page.frameLocator("iframe");
    const chip = frame.getByRole("link", { name: EMBED });
    await expect(chip).toHaveAttribute("target", "_blank");
    await expect(chip).toHaveAttribute("rel", "noopener");
    await expect(chip).toContainText("Open in Open Artifacts");
    await expect(frame.locator(".oa-fstitle")).toHaveText("Team poll");
    await chip.focus();
    await page.keyboard.press("Escape");
    await expect(chip).toBeVisible();
    expect(page.frames()[1]?.url()).toMatch(new RegExp(`${PUBLIC_FULL}$`));
    const strip = (await frame.locator(".oa-fsbar").boundingBox()) as Box;
    const inner = (await frame
      .locator("iframe.oa-vframe")
      .boundingBox()) as Box;
    expect(strip.y + strip.height).toBeLessThanOrEqual(inner.y);
  });

  test("Full screen has the Maximize2 icon on the button and the menu item", async ({
    page,
  }) => {
    await page.goto(`/a/${ID}`);
    const icon = page
      .getByRole("link", { name: "Full screen" })
      .locator("svg.lucide-maximize-2");
    await expect(icon).toBeVisible();
    expect(await icon.boundingBox()).toMatchObject({ width: 14, height: 14 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(
      page
        .getByRole("menuitem", { name: "Full screen" })
        .locator("svg.lucide-maximize-2"),
    ).toBeVisible();
  });
});

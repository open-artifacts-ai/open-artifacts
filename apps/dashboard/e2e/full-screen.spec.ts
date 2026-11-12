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

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`full screen at ${width}px ${theme}: the frame fills the window`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/a/${ID}/full`);
      const frame = page.locator("iframe.oa-vframe");
      await expect(frame).toBeVisible();
      expect(await frame.boundingBox()).toEqual({
        x: 0,
        y: 0,
        width,
        height: 800,
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

// #2189: the floating controls group (Comments and Exit, 32px, 55% at rest).
const FULL = `/a/${ID}/full`;
const TOP = "Exit full screen, back to Landing page";
// Real embeds are public-only (a framed shell runs anonymously).
const PUBLIC_FULL = "/a/Gh9kLmNpQrAsTuVx/full"; // Team poll
const EMBED = "Open Team poll in Open Artifacts (opens in new tab)";
const box = async (l: import("@playwright/test").Locator) =>
  (await l.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
const color = (l: import("@playwright/test").Locator) =>
  l.evaluate((e) => getComputedStyle(e).color);
const surface = (l: import("@playwright/test").Locator) =>
  l.evaluate((e) => {
    const s = getComputedStyle(e);
    return [s.opacity, s.backgroundColor];
  });

test.describe("full-screen controls", () => {
  test("a 32px solid group 8px from the top right, icons only, names stable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    const comments = page.getByRole("button", { name: /^Comments/ });
    const bar = page.locator(".oa-fsbar");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("href", `/a/${ID}`);
    await expect(chip).toHaveText("");
    const [op, bg] = await surface(bar);
    expect(op).toBe("1");
    expect(bg).not.toMatch(/rgba\(.*, 0\)$|transparent/);
    expect(await bar.evaluate((e) => getComputedStyle(e).position)).toBe(
      "fixed",
    );
    const g = await box(bar);
    expect(g.height).toBe(32);
    expect(g.y).toBe(8);
    expect(g.x + g.width).toBe(1272);
    const c = await box(comments);
    const x = await box(chip);
    expect(c.height).toBeGreaterThanOrEqual(30);
    expect(c.x + c.width).toBeLessThanOrEqual(x.x);
    // The frame is not moved by it.
    expect(await box(page.locator("iframe.oa-vframe"))).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
    });
  });

  test("the surface stays solid; the icons are muted at rest and full contrast on hover and focus", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    const bar = page.locator(".oa-fsbar");
    await expect(chip).toBeVisible();
    await page.mouse.move(10, 400);
    const rest = await color(chip);
    await chip.hover();
    await expect.poll(() => color(chip)).not.toBe(rest);
    expect((await surface(bar))[0]).toBe("1");
    await page.mouse.move(10, 400);
    await expect.poll(() => color(chip)).toBe(rest);
    await page.keyboard.press("Tab");
    await expect.poll(() => color(chip)).not.toBe(rest);
  });

  test("Tab reaches Comments and Exit before the artifact; the tooltip and an inset ring show on focus", async ({
    page,
  }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    const comments = page.getByRole("button", { name: /^Comments/ });
    await expect(chip).toBeVisible();
    // The bar is before the frame in the DOM, so it holds the first Tab stops.
    // The frame mounts after the bar: wait for both before comparing.
    await expect(page.locator("iframe.oa-vframe")).toBeAttached();
    expect(
      await page.evaluate(() => {
        const bar = document.querySelector(".oa-fsbar");
        const frame = document.querySelector("iframe.oa-vframe");
        if (!bar || !frame) return false;
        return Boolean(
          bar.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);
    await page.keyboard.press("Tab");
    await expect(comments).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveText("Comments");
    await page.keyboard.press("Tab");
    await expect(chip).toBeFocused();
    await expect(
      page.getByRole("tooltip").filter({ hasText: "Exit full screen" }),
    ).toBeVisible();
    const css = await chip.evaluate((e) => {
      const s = getComputedStyle(e);
      return [s.outlineStyle, s.outlineOffset];
    });
    expect(css).toEqual(["solid", "-2px"]);
    await page.keyboard.press("Tab");
    await expect(chip).not.toBeFocused();
    // Focus passes through <body> on its way into the frame: wait for it to land.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .toBe("IFRAME");
  });

  test("Esc goes back to the viewer, in the same tab", async ({ page }) => {
    await page.goto(FULL);
    await expect(page.getByRole("link", { name: TOP })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/a/${ID}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("reduced motion: no colour transition", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toBeVisible();
    expect(
      await chip.evaluate((e) => getComputedStyle(e).transitionDuration),
    ).toBe("0s");
  });

  test("motion: colour 150ms cubic-bezier(.2,0,0,1)", async ({ page }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toBeVisible();
    expect(
      await chip.evaluate((e) => {
        const s = getComputedStyle(e);
        return [
          s.transitionProperty,
          s.transitionDuration,
          s.transitionTimingFunction,
        ];
      }),
    ).toEqual(["color", "0.15s", "cubic-bezier(0.2, 0, 0, 1)"]);
  });

  test("hidden when printed", async ({ page }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(chip).toBeHidden();
  });

  test("embedded: new tab, an icon, no Esc", async ({ page }) => {
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
    await expect(chip).toHaveText("");
    await chip.focus();
    await page.keyboard.press("Escape");
    await expect(chip).toBeVisible();
    expect(page.frames()[1]?.url()).toMatch(new RegExp(`${PUBLIC_FULL}$`));
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

test.describe("full-screen controls, coarse pointer", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("44px tap targets, icons only; one tap follows", async ({ page }) => {
    await page.goto(FULL);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const chip = page.getByRole("link", { name: TOP });
    const comments = page.getByRole("button", { name: /^Comments/ });
    await expect(chip).toBeVisible();
    expect((await box(page.locator(".oa-fsbar"))).height).toBe(44);
    for (const b of [await box(chip), await box(comments)]) {
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    await chip.tap();
    await expect(page).toHaveURL(new RegExp(`/a/${ID}$`));
  });
});

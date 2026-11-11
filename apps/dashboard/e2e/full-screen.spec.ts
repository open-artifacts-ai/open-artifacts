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

// Option A: the peek chip (spec-fullscreen-chip.md).
const FULL = `/a/${ID}/full`;
const TOP = "Exit full screen, back to Landing page";
// Real embeds are public-only (a framed shell runs anonymously).
const PUBLIC_FULL = "/a/Gh9kLmNpQrAsTuVx/full"; // Team poll
const EMBED = "Open Team poll in Open Artifacts (opens in new tab)";
const width = (l: import("@playwright/test").Locator) =>
  l.evaluate((e) => e.getBoundingClientRect().width);
type Page = import("@playwright/test").Page;
/** Loads `url` on a fake clock, so the 3 s reveal is stepped, not waited for. */
const gotoFaked = async (page: Page, url: string) => {
  await page.clock.install();
  // Not waiting for "load": the frame's content can hold it past the reveal.
  await page.goto(url, { waitUntil: "commit" });
  // Paused as soon as the chip mounts: the reveal fires only when stepped.
  await page.locator(".oa-fsx").waitFor({ state: "attached" });
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
};
/** Steps past the 3 s reveal and expects the chip collapsed. */
const revealEnds = async (
  page: Page,
  chip: import("@playwright/test").Locator,
) => {
  await expect(chip).toBeVisible();
  await page.clock.runFor(3_100);
  await expect(chip).toHaveAttribute("data-open", "false");
  await page.clock.resume();
};

test.describe("full-screen chip", () => {
  test("widened for 3 s on load, then a 32px circle; the name never changes", async ({
    page,
  }) => {
    await gotoFaked(page, FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toHaveAttribute("data-open", "true");
    await expect.poll(() => width(chip)).toBeGreaterThan(100);
    await expect(chip).toHaveAttribute("href", `/a/${ID}`);
    await revealEnds(page, chip);
    await expect.poll(() => width(chip)).toBe(32);
    await expect(chip).toHaveAccessibleName(TOP);
    expect(await chip.evaluate((e) => getComputedStyle(e).opacity)).toBe(
      "0.72",
    );
  });

  test("widens on hover, collapses 400 ms after the pointer leaves", async ({
    page,
  }) => {
    await gotoFaked(page, FULL);
    const chip = page.getByRole("link", { name: TOP });
    await revealEnds(page, chip);
    await chip.hover();
    await expect(chip).toHaveAttribute("data-open", "true");
    await expect.poll(() => width(chip)).toBeGreaterThan(100);
    await page.mouse.move(10, 10);
    await expect(chip).toHaveAttribute("data-open", "false");
  });

  test("Tab reaches Comments and Exit before the artifact; keyboard focus widens Exit and shows the ring", async ({
    page,
  }) => {
    await gotoFaked(page, FULL);
    const chip = page.getByRole("link", { name: TOP });
    const comments = page.getByRole("button", { name: /^Comments/ });
    await revealEnds(page, chip);
    // The bar is before the frame in the DOM, so it holds the first Tab stops.
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
    await page.keyboard.press("Tab");
    await expect(chip).toBeFocused();
    await expect(chip).toHaveAttribute("data-open", "true");
    const css = await chip.evaluate((e) => {
      const s = getComputedStyle(e);
      return [s.outlineStyle, s.outlineColor, s.boxShadow];
    });
    expect(css).toEqual([
      "solid",
      "rgb(255, 255, 255)",
      "rgb(35, 80, 208) 0px 0px 0px 5px",
    ]);
  });

  test("Esc goes back to the viewer, in the same tab", async ({ page }) => {
    await page.goto(FULL);
    await expect(page.getByRole("link", { name: TOP })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/a/${ID}$`));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("reduced motion: no transition, and the 3 s reveal still happens", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoFaked(page, FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toHaveAttribute("data-open", "true");
    expect(
      await chip.evaluate((e) => getComputedStyle(e).transitionDuration),
    ).toBe("0s");
    await revealEnds(page, chip);
    expect(await width(chip)).toBe(32);
  });

  test("motion: 200ms cubic-bezier(.2,0,0,1)", async ({ page }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    const t = await chip.evaluate((e) => {
      const s = getComputedStyle(e);
      return [
        s.transitionProperty,
        s.transitionDuration,
        s.transitionTimingFunction,
      ];
    });
    expect(t).toEqual([
      "max-width, padding, opacity",
      "0.2s, 0.2s, 0.2s",
      "cubic-bezier(0.2, 0, 0, 1), cubic-bezier(0.2, 0, 0, 1), cubic-bezier(0.2, 0, 0, 1)",
    ]);
  });

  test("hidden when printed", async ({ page }) => {
    await page.goto(FULL);
    const chip = page.getByRole("link", { name: TOP });
    await expect(chip).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(chip).toBeHidden();
  });

  test("embedded: new tab, collapsed from the start, no Esc", async ({
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
    await expect(chip).toHaveAttribute("data-open", "false");
    await expect(chip).toHaveAttribute("target", "_blank");
    await expect(chip).toHaveAttribute("rel", "noopener");
    expect(await width(chip)).toBe(32);
    await chip.focus();
    await page.keyboard.press("Escape");
    await expect(chip).toBeVisible();
    expect(page.frames()[1]?.url()).toMatch(new RegExp(`${PUBLIC_FULL}$`));
    await chip.hover();
    await expect(chip).toHaveAttribute("data-open", "true");
    await expect(chip).toContainText("Open in Open Artifacts");
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

test.describe("full-screen chip, coarse pointer", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("the first tap widens without navigating; the second follows", async ({
    page,
  }) => {
    await gotoFaked(page, FULL);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const chip = page.getByRole("link", { name: TOP });
    await revealEnds(page, chip);
    await chip.tap();
    await expect(chip).toHaveAttribute("data-open", "true");
    await expect(page).toHaveURL(new RegExp(`${FULL}$`));
    await chip.tap();
    await expect(page).toHaveURL(new RegExp(`/a/${ID}$`));
  });
});

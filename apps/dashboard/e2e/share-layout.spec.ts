// Area 5 on @oa/ui/shadcn: the Share panel's geometry, and Sonner toasts
// (Design: bottom-right 16px in; full width less the 16px gutters on
// phones; a "Dismiss" close button with a 24px hit area and the 2px ring;
// errors announced assertively). Each run attaches a screenshot.
import { expect, type Page, test } from "@playwright/test";

const openShare = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  await page.goto(`${page.url().split("?")[0]}?panel=open&tab=share`);
  await expect(
    page.getByRole("radiogroup", { name: "General access" }),
  ).toBeVisible();
};

const toastBox = (page: Page) =>
  page
    .locator("[data-sonner-toast]")
    .first()
    .evaluate((t) => {
      const r = t.getBoundingClientRect();
      const close = t.querySelector("[data-close-button]");
      const c = close?.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        right: Math.round(window.innerWidth - r.right),
        bottom: Math.round(window.innerHeight - r.bottom),
        close: close?.getAttribute("aria-label"),
        hit: c ? Math.round(Math.min(c.width, c.height)) : 0,
      };
    });

for (const [width, theme] of [[390, "light"]] as const) {
  test(`share panel and toasts at ${width}px ${theme}`, async ({
    page,
    context,
  }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    await openShare(page);

    // Nothing in the panel is wider than the viewport; people rows keep
    // the role select at 96px and truncate the address.
    const g = await page.evaluate(() => ({
      sideScroll:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      roles: [
        ...document.querySelectorAll<HTMLElement>(
          ".oa-share li [role=combobox]",
        ),
      ].map((s) => s.getBoundingClientRect().width),
    }));
    expect(g.sideScroll).toBe(0);
    for (const w of g.roles) expect(w).toBe(96);
    await info.attach(`share-${width}-${theme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // A success toast: placed per Design, with an accessible close button.
    await page.getByRole("button", { name: "Copy link" }).last().click();
    await expect(page.getByText("Link copied")).toBeVisible();
    // Sonner's enter animation slides it up: measure once it has landed.
    await expect
      .poll(async () => (await toastBox(page)).bottom)
      .toBeGreaterThanOrEqual(16);
    const t = await toastBox(page);
    expect(t.close).toBe("Dismiss");
    expect(t.hit).toBeGreaterThanOrEqual(24);
    expect(t.bottom).toBeGreaterThanOrEqual(16);
    if (width <= 600) {
      expect(t.left).toBe(16);
      expect(t.right).toBe(16);
    } else expect(t.right).toBe(16);
    await info.attach(`toast-success-${width}-${theme}`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}

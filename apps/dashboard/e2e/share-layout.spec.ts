// Area 5 on @oa/ui/shadcn: the Share panel's geometry, and Sonner toasts
// (Design: bottom-right 16px in; full width less the 16px gutters on
// phones; a "Dismiss" close button with a 24px hit area and the 2px ring;
// errors announced assertively). Each run attaches a screenshot.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const openShare = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  await page.goto(`${page.url().split("?")[0]}?panel=open&tab=share`);
  await expect(
    page.getByRole("radiogroup", { name: "Visibility" }),
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

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
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

test("an error toast is an alert; Dismiss has the 2px focus ring", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await openShare(page);
  await page.getByRole("button", { name: "Copy link" }).last().click();
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast.getByRole("alert")).toHaveText("Couldn't copy");
  // One click selects the whole link to copy by hand.
  expect(
    await toast
      .locator("[data-description] span")
      .evaluate((e) => getComputedStyle(e).userSelect),
  ).toBe("all");
  const dismiss = toast.getByRole("button", { name: "Dismiss" });
  await page.keyboard.press("Shift");
  await dismiss.focus();
  const ring = await dismiss.evaluate((b) => {
    const s = getComputedStyle(b);
    return [b.matches(":focus-visible"), s.outlineStyle, s.outlineWidth];
  });
  expect(ring).toEqual([true, "solid", "2px"]);
  await dismiss.click();
  await expect(toast).toHaveCount(0);
});

test("the Undo toast offers its action", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  await page.goto(`${page.url().split("?")[0]}?panel=open&tab=details`);
  await page.getByRole("button", { name: "Delete artifact" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const undo = page
    .locator("[data-sonner-toast]")
    .getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await info.attach("toast-undo", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("opening Share focuses the active tab, not the panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const tab = page.getByRole("tab", { name: "Share", selected: true });
  await expect(tab).toBeFocused();
});

test("Live data hints line up with their label text", async ({ page }) => {
  await openShare(page);
  const x = await page
    .locator(".oa-cap")
    .first()
    .evaluate((cap) => {
      const label = cap.querySelector("label")?.getBoundingClientRect();
      const hint = cap.querySelector("small");
      const r = document.createRange();
      if (hint) r.selectNodeContents(hint);
      return { label: label?.left, hint: r.getBoundingClientRect().left };
    });
  expect(x.hint).toBe(x.label);
});

test("dialogs are a surface, not the page gray", async ({ page }) => {
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Add member" }).click();
  const bg = await page.getByRole("dialog").evaluate((d) => {
    const probe = document.createElement("div");
    probe.style.background = "var(--popover)";
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(d).backgroundColor, want];
  });
  expect(bg[0]).toBe(bg[1]);
});

// Hosted P4 Task 9 (D9 / Q7): in a space with public links off, "Public"
// stays visible but disabled, with the reason; the panel keeps its layout.
for (const width of [1280, 375, 390])
  for (const scheme of ["light", "dark"] as const)
    test(`hosted public-off share panel at ${width}px ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/?hosted=1");
      await page.getByRole("link", { name: "Meeting notes" }).first().waitFor();
      // Turn public links off in Engineering (the caller manages it) through
      // the mock API, before the artifact is fetched (a reload resets the mock).
      const status = await page.evaluate(async () => {
        const r = await fetch("/api/v1/spaces/SpEngNpQrSt2uVwX", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "X-OA-Request": "1",
          },
          body: JSON.stringify({ publicLinks: false }),
        });
        return r.status;
      });
      expect(status).toBe(200);
      await page.getByRole("link", { name: "Meeting notes" }).first().click();
      await page.waitForURL(/\/a\//);
      await page.getByRole("button", { name: "Share" }).click();
      const group = page.getByRole("radiogroup", { name: "Visibility" });
      await expect(group.getByRole("radio", { name: "Public" })).toBeDisabled();
      await expect(
        page.getByText(
          "Public links are off for Engineering. A space manager can turn them on.",
        ),
      ).toBeVisible();
      const over = await page.evaluate(
        () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
      );
      expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
      await page.addScriptTag({ path: AXE });
      const v: string[] = await page.evaluate(async () => {
        // @ts-expect-error injected
        const r = await axe.run(document, { resultTypes: ["violations"] });
        return r.violations
          .filter(
            (x: { impact: string }) =>
              x.impact === "serious" || x.impact === "critical",
          )
          .map((x: { id: string }) => x.id);
      });
      expect(v).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`share-public-off-${scheme}-${width}.png`),
        fullPage: true,
      });
    });

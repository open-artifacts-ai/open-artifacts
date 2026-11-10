// Artifact detail chrome on the shadcn primitives: the title bar, the side
// panel frame, the version history and the diff page. Checks the h1 (20/600),
// the 20px (16px at <= 600px) gutters, no side scroll and that nothing leaves
// the viewport, at 1280 and 390, light and dark. Each run attaches a shot.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const VIEWS = [
  ["viewer", `/a/${ID}`],
  ["panel", `/a/${ID}?panel=open&tab=versions`],
  ["diff", `/a/${ID}/diff/1/2`],
] as const;

const noSideScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

for (const [name, url] of VIEWS)
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      test(`detail/${name} geometry at ${width}px ${theme}`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(url);
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toBeVisible();
        const pad = width <= 600 ? 16 : 20;

        const font = await h1.evaluate((el) => {
          const s = getComputedStyle(el);
          return [s.fontSize, s.fontWeight];
        });
        expect(font).toEqual(["20px", "600"]);
        expect(await noSideScroll(page)).toBe(true);

        const box = await h1.boundingBox();
        if (name === "diff")
          expect(Math.round(box?.x ?? 0)).toBe(20 + (width <= 600 ? -4 : 0));
        else {
          // The title bar pads 20px (16px at <= 600px) on both sides.
          const bar = await page.locator(".oa-vt").evaluate((el) => {
            const s = getComputedStyle(el);
            return [s.paddingLeft, s.paddingRight];
          });
          expect(bar).toEqual([`${pad}px`, `${pad}px`]);
          // Every action stays inside the viewport.
          for (const b of await page.locator(".oa-vt button").all()) {
            const r = await b.boundingBox();
            expect(r?.x ?? 0).toBeGreaterThanOrEqual(0);
            expect((r?.x ?? 0) + (r?.width ?? 0)).toBeLessThanOrEqual(width);
          }
        }

        if (name === "panel") {
          const panel = page.getByRole("complementary", { name: "Side panel" });
          const pb = await panel.boundingBox();
          // 320px of content (352px with padding and border; #1986 default) beside the frame; the full width over it below 960px.
          expect(Math.round(pb?.width ?? 0)).toBe(width < 960 ? width : 352);
          await expect(
            page.getByRole("tab", { name: "Versions" }),
          ).toHaveAttribute("aria-selected", "true");
          for (const b of await panel.getByRole("button").all()) {
            const r = await b.boundingBox();
            expect((r?.x ?? 0) + (r?.width ?? 0)).toBeLessThanOrEqual(
              (pb?.x ?? 0) + (pb?.width ?? 0) + 0.5,
            );
          }
        }

        await info.attach(`detail-${name}-${width}-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

test("detail: no upload-version control and the old chrome classes are gone", async ({
  page,
}) => {
  await page.goto(`/a/${ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const c of [".oa-vt-title", ".oa-vpanel", ".oa-top", ".oa-btn"])
    await expect(page.locator(c)).toHaveCount(0);
});

const MOBILE = { width: 390, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test("detail: xs buttons (24px) at 1280, 32px and a More menu at 390", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/a/${ID}`);
  const share = page.getByRole("button", { name: "Share", exact: true });
  await expect(share).toBeVisible();
  expect((await share.boundingBox())?.height).toBe(24);
  await expect(page.getByRole("link", { name: "Full screen" })).toBeVisible();
  // The version chip is the only versions control (#471).
  await expect(page.getByRole("button", { name: /^Version: / })).toBeVisible();
  await expect(page.getByRole("button", { name: "Versions" })).toHaveCount(0);

  await page.setViewportSize(MOBILE);
  expect((await share.boundingBox())?.height).toBe(32);
  await expect(page.getByRole("link", { name: "Full screen" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Version: / })).toBeVisible();
  // One row: the version picker, Share and More share a line.
  const ys = await Promise.all(
    [/^Version:/, /^Share$/, /^More actions$/].map(async (name) =>
      Math.round(
        (await page.getByRole("button", { name }).boundingBox())?.y ?? -1,
      ),
    ),
  );
  expect(new Set(ys).size).toBe(1);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Full screen" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Versions" }).click();
  await expect(
    page.getByRole("complementary", { name: "Side panel" }),
  ).toBeVisible();
});

test("diff preview: side by side at 1280, Before over After at 390", async ({
  page,
}) => {
  for (const [vp, stacked] of [
    [DESKTOP, false],
    [MOBILE, true],
  ] as const) {
    await page.setViewportSize(vp);
    await page.goto(`/a/${ID}/diff/1/2`);
    await page.getByRole("tab", { name: "Preview" }).click();
    const before = page.locator("figure", { hasText: "Before (v1)" });
    const after = page.locator("figure", { hasText: "After (v2)" });
    await expect(before).toBeVisible();
    const [b, a] = await Promise.all([
      before.boundingBox(),
      after.boundingBox(),
    ]);
    if (stacked) {
      expect(a?.y ?? 0).toBeGreaterThanOrEqual((b?.y ?? 0) + (b?.height ?? 0));
      expect(Math.round(a?.x ?? -1)).toBe(Math.round(b?.x ?? -2));
    } else {
      expect(Math.round(a?.y ?? -1)).toBe(Math.round(b?.y ?? -2));
      expect(a?.x ?? 0).toBeGreaterThan((b?.x ?? 0) + (b?.width ?? 0) - 1);
    }
  }
});

test("panel: no ring on the container, the active tab holds the focus, 1px border", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/a/${ID}`);
  await page.getByRole("button", { name: "Share" }).click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const tab = page.getByRole("tab", { name: "Share" });
  await expect(tab).toBeFocused();
  const ring = (el: import("@playwright/test").Locator) =>
    el.evaluate((n) => {
      const s = getComputedStyle(n);
      return [s.outlineStyle, s.outlineWidth];
    });
  expect((await ring(panel))[0]).toBe("none");
  expect(await ring(tab)).toEqual(["solid", "2px"]);
  const edge = await panel.evaluate((n) => {
    const s = getComputedStyle(n);
    const probe = document.createElement("i");
    probe.style.color = "var(--oa-border)";
    document.body.append(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return [s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor === want];
  });
  expect(edge).toEqual(["1px", "solid", true]);
});

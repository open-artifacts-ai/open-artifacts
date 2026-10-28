// Sidebar B ("Inset", Design spec): sidebar sizes and rows, the inset panel
// with the header inside it, collapse, the active/focus treatment, and the
// full-bleed phone layout with its sheet.
import { expect, test } from "@playwright/test";

test("sidebar B metrics at 1280px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  // Settings needs /me, so every row is in once it shows.
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  const m = await page.evaluate(() => {
    const box = (el?: Element | null) => el?.getBoundingClientRect();
    const css = (el: Element) => getComputedStyle(el);
    const resolve = (prop: string, value: string) => {
      const probe = document.createElement("div");
      probe.style.setProperty(prop, value);
      document.body.append(probe);
      const out = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return out;
    };
    const side = document.querySelector("[data-slot=sidebar-container]");
    const head = document.querySelector("[data-slot=sidebar-header]");
    const brand = head?.querySelector("a");
    const mark = brand?.querySelector("svg");
    const word = brand?.querySelector("span");
    const header = document.querySelector("header");
    const links = [
      ...document.querySelectorAll<HTMLElement>(
        "nav[aria-label=Primary] a[data-slot=sidebar-menu-button]",
      ),
    ];
    const rows = links.map((a) => box(a) as DOMRect);
    const active = links.find((a) => a.dataset.active === "true");
    return {
      html: css(document.documentElement).fontSize,
      body: css(document.body).fontSize,
      width: box(side)?.width,
      brandHeight: box(head)?.height,
      header: box(header)?.height,
      headerDivider: header ? css(header).borderBottomColor : "",
      divider: resolve("color", "var(--oa-divider)"),
      mark: box(mark)?.width,
      word: word ? [css(word).fontSize, css(word).fontWeight] : [],
      heights: [...new Set(rows.map((r) => r.height))],
      gaps: [
        ...new Set(rows.slice(1).map((r, i) => r.top - (rows[i]?.bottom ?? 0))),
      ],
      iconX: [...new Set(links.map((a) => box(a.querySelector("svg"))?.left))],
      icon: [...new Set(links.map((a) => box(a.querySelector("svg"))?.width))],
      iconGap: [
        ...new Set(
          links.map(
            (a) =>
              (box(a.querySelector("span"))?.left ?? 0) -
              (box(a.querySelector("svg"))?.right ?? 0),
          ),
        ),
      ],
      padding: [...new Set(links.map((a) => css(a).paddingLeft))],
      radius: [...new Set(links.map((a) => css(a).borderTopLeftRadius))],
      activeBg: active ? css(active).backgroundColor : "",
      card: resolve("background-color", "var(--oa-surface)"),
      activeRing: active ? css(active).boxShadow : "",
      ringColor: resolve("color", "var(--oa-border-strong)"),
      activeWeight: active ? css(active).fontWeight : "",
    };
  });
  expect(m.html).toBe("16px");
  expect(m.body).toBe("13px");
  expect(m.width).toBe(256);
  expect(m.brandHeight).toBe(48);
  expect(m.header).toBe(48);
  expect(m.headerDivider).toBe(m.divider);
  expect(m.mark).toBe(24);
  expect(m.word).toEqual(["16px", "600"]);
  expect(m.heights).toEqual([32]);
  expect(m.gaps).toEqual([4]);
  expect(m.iconX).toHaveLength(1);
  expect(m.icon).toEqual([16]);
  expect(m.iconGap).toEqual([8]);
  expect(m.padding).toEqual(["8px"]);
  expect(m.radius).toEqual(["6px"]);
  expect(m.activeBg).toBe(m.card);
  expect(m.activeRing).toContain(`${m.ringColor} 0px 0px 0px 1px inset`);
  expect(m.activeWeight).toBe("500");

  // Focus: a 2px solid inset outline.
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // brand
  await page.keyboard.press("Tab"); // Library
  const ring = await nav
    .getByRole("link", { name: "Library" })
    .evaluate((a) => {
      const c = getComputedStyle(a);
      return [
        a.matches(":focus-visible"),
        c.outlineStyle,
        c.outlineWidth,
        c.outlineOffset,
      ];
    });
  expect(ring).toEqual([true, "solid", "2px", "-2px"]);
});

test("phone: a 288px sheet that navigates, closes and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  await trigger.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: "Team" })).toBeVisible();
  // The sheet slides in with a transform: measure once it has landed at the
  // left edge, not mid-slide (sub-pixel widths, Platform's #755 shard 3).
  await expect.poll(async () => (await sheet.boundingBox())?.x).toBe(0);
  expect((await sheet.boundingBox())?.width).toBeCloseTo(288, 2);
  // The desktop's insets: brand 8px in and 48px tall, rows 16px in.
  const inset = await sheet.evaluate((d) => {
    const left = d.getBoundingClientRect().left;
    const head = d.querySelector("[data-slot=sidebar-header]");
    const brand = head?.querySelector("a")?.getBoundingClientRect();
    const row = d
      .querySelector("nav a[data-slot=sidebar-menu-button]")
      ?.getBoundingClientRect();
    return {
      brandX: (brand?.left ?? 0) - left,
      brandY: (brand?.top ?? 0) - d.getBoundingClientRect().top,
      brandRow: head?.getBoundingClientRect().height,
      rowX: (row?.left ?? 0) - left,
      markers: [...d.querySelectorAll("li")].some(
        (li) => getComputedStyle(li).listStyleType !== "none",
      ),
    };
  });
  expect(inset).toEqual({
    brandX: 8,
    brandY: 8,
    brandRow: 48,
    rowX: 16,
    markers: false,
  });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("dialog").getByRole("link", { name: "Team" }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// One shell gutter: 24px, 16px at <= 600px. Library has no side padding of
// its own; Settings centers its 880px column inside the gutter.
for (const [width, gutter] of [
  [1280, 24],
  [800, 24],
  [600, 16],
  [390, 16],
] as const)
  test(`page gutter is ${gutter}px at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Against main's scrollport (clientWidth), not its border box: with a
    // classic scrollbar, `scrollbar-gutter: stable` reserves its width.
    const gap = (sel: string) =>
      page.evaluate((sel) => {
        const main = document.getElementById("oa-main") as HTMLElement;
        const left = main.getBoundingClientRect().left + main.clientLeft;
        const right = left + main.clientWidth;
        const el = document.querySelector(sel)?.getBoundingClientRect();
        return {
          left: (el?.left ?? 0) - left,
          right: right - (el?.right ?? 0),
        };
      }, sel);
    // Force a classic (space-taking) scrollbar, as on Linux CI, so the
    // reserved gutter is in play on every platform.
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "#oa-main::-webkit-scrollbar { width: 15px; }";
        document.head.append(style);
      });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await gap(".oa-page > section")).toEqual({
      left: gutter,
      right: gutter,
    });
    await page.goto("/settings/agents");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const s = await gap(".oa-page > div");
    expect(s.left).toBeGreaterThanOrEqual(gutter);
    expect(Math.abs(s.left - s.right)).toBeLessThanOrEqual(1);
    if (width < 880 + 2 * gutter + 256) expect(s.left).toBe(gutter);
  });

/** The panel's box and treatment, against the viewport and the sidebar. */
const panel = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const header = document.querySelector("header");
    const p = header?.parentElement;
    const side = document.querySelector("[data-slot=sidebar-container]");
    const r = p?.getBoundingClientRect();
    const c = p ? getComputedStyle(p) : null;
    const resolve = (prop: string, value: string) => {
      const probe = document.createElement("div");
      probe.style.setProperty(prop, value);
      document.body.append(probe);
      const out = getComputedStyle(probe).getPropertyValue(prop);
      probe.remove();
      return out;
    };
    return {
      top: r?.top,
      right: window.innerWidth - (r?.right ?? 0),
      bottom: window.innerHeight - (r?.bottom ?? 0),
      left:
        (r?.left ?? 0) - Math.max(0, side?.getBoundingClientRect().right ?? 0),
      leftEdge: r?.left,
      radius: c?.borderTopLeftRadius,
      border: c ? [c.borderTopWidth, c.borderTopColor] : [],
      borderToken: resolve("color", "var(--oa-border)"),
      shadow: c?.boxShadow,
      bg: c?.backgroundColor,
      bgToken: resolve("background-color", "var(--oa-bg)"),
      wrapper: getComputedStyle(
        document.querySelector("[data-slot=sidebar-wrapper]") as Element,
      ).backgroundColor,
      chrome: resolve("background-color", "var(--oa-chrome)"),
      headerInside: !!header && !!p && header.parentElement === p,
    };
  });

test("the inset panel at 1280px, then collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const p = await panel(page);
  expect(p).toMatchObject({
    top: 8,
    right: 8,
    bottom: 8,
    left: 0,
    radius: "8px",
    shadow: "none",
    headerInside: true,
  });
  expect(p.border).toEqual(["1px", p.borderToken]);
  expect(p.bg).toBe(p.bgToken);
  expect(p.wrapper).toBe(p.chrome);

  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect.poll(async () => (await panel(page)).leftEdge).toBe(8);
});

test("the active row's ring is at least 3:1 against the chrome", async ({
  page,
}) => {
  await page.goto("/");
  for (const theme of ["light", "dark"]) {
    const ratio = await page.evaluate((theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      const rgb = (value: string) => {
        const probe = document.createElement("div");
        probe.style.color = value;
        document.body.append(probe);
        const m = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
        probe.remove();
        return m.slice(0, 3).map(Number);
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0);
      };
      const a = lum(rgb("var(--oa-border-strong)"));
      const b = lum(rgb("var(--oa-chrome)"));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, theme);
    expect(ratio, theme).toBeGreaterThanOrEqual(3);
  }
});

test("below 768px the panel is full-bleed", async ({ page }) => {
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const p = await panel(page);
  expect(p).toMatchObject({ top: 0, right: 0, leftEdge: 0, radius: "0px" });
  expect(p.border[0]).toBe("0px");
});

test("from 768px the content, not the window, scrolls by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const main = page.locator("#oa-main");
  const top = () => main.evaluate((m) => m.scrollTop);
  const windowY = () => page.evaluate(() => window.scrollY);

  // The content, not the window, scrolls; the gutter is kept for it.
  expect(await main.evaluate((m) => getComputedStyle(m).scrollbarGutter)).toBe(
    "stable",
  );
  await main.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(top).toBeGreaterThan(0);
  expect(await windowY()).toBe(0);
  // The reset to the top on route change is pinned in vitest
  // (layout.test.tsx): here the page re-renders short and clamps anyway.
});

// Shared by the browser tests: open a Ladle story in Chromium under
// <html data-theme>, with axe and the WCAG ratio helpers injected.
import axe from "axe-core";
import { type Browser, chromium, type Page } from "playwright";
import { inject } from "vitest";
import { withDeadline } from "./with-deadline.js";

export type Focus = { id: string; ok: boolean; detail: string } | null;

// Chromium is launched as a server so teardown has its process: closing can
// stall on a loaded runner, so it gets 5s before the process is killed.
// Pass `close` to afterAll with a timeout above that.
export async function launch() {
  const server = await chromium.launchServer();
  const browser = await chromium.connect(server.wsEndpoint());
  const close = async () => {
    // A close still pending after 5 s is killed: the bound, not a wait.
    await withDeadline(server.close(), 5_000, "browser server close").catch(
      () => server.kill(),
    );
  };
  return { browser, close };
}

// Radix overlays take keys only once settled. Focus moves in on mount, but
// Escape is wired one render later: the DismissableLayer re-renders as the
// top layer (setting pointer-events:auto on itself while the body is none)
// and only then attaches its keydown listener, in an effect. Waiting out the
// open animation as well puts that effect behind us.
export const settled = (page: Page, sel: string) =>
  page.waitForFunction((s) => {
    const el = document.querySelector(s);
    return (
      el?.getAttribute("data-state") === "open" &&
      el.contains(document.activeElement) &&
      getComputedStyle(el).pointerEvents === "auto" &&
      el
        .getAnimations({ subtree: true })
        .every((a) => a.playState === "finished")
    );
  }, sel);

export async function openStory(
  browser: Browser,
  story: string,
  theme: string,
  ready: string,
  viewport = { width: 1280, height: 800 },
): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.goto(`${inject("ladleUrl")}/?story=${story}&mode=preview`);
  await page.waitForSelector(ready);
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  // Measure settled styles: transition-all would animate outlines in.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; }",
  });
  await page.addScriptTag({ content: axe.source });
  await page.addScriptTag({ content: `(${pageHelpers})()` });
  return page;
}

// Runs in the page: WCAG ratio helpers on window.__oa.
function pageHelpers() {
  const parse = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const fill = (el: Element | null) => {
    for (let h = el; h; h = h.parentElement) {
      const c = getComputedStyle(h).backgroundColor;
      if ((parse(c)[3] ?? 1) > 0) return c;
    }
    return "rgb(255, 255, 255)";
  };
  const name = (el: Element) =>
    `${el.tagName}.${el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 24) || ""}`;
  // Inset outlines (negative offset) sit on the element's own fill.
  const focus = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const s = getComputedStyle(el);
    const inset = Number.parseFloat(s.outlineOffset) < 0;
    const r = ratio(s.outlineColor, fill(inset ? el : el.parentElement));
    const ok =
      s.outlineStyle === "solid" &&
      Number.parseFloat(s.outlineWidth) >= 2 &&
      r >= 3;
    return {
      id: name(el),
      ok,
      detail: `${s.outlineStyle} ${s.outlineWidth} ${r.toFixed(2)}`,
    };
  };
  // `overlay`: an open modal. Radix hides the page with aria-hidden while
  // trapping focus in the overlay, which axe's aria-hidden-focus flags.
  const axeRun = async (overlay = false) => {
    // biome-ignore lint/suspicious/noExplicitAny: axe is injected globally
    const res = await (window as any).axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      rules: {
        region: { enabled: false },
        "aria-hidden-focus": { enabled: !overlay },
      },
    });
    return res.violations.map(
      (v: { id: string; nodes: { target: string[] }[] }) =>
        `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
  };
  const borders = () =>
    [
      ...document.querySelectorAll(
        '[data-variant="outline"], [data-slot="input"], [data-slot="select-trigger"], [data-slot="textarea"], [data-slot="checkbox"]',
      ),
    ]
      // Group wrappers carry data-variant too but draw no border.
      .filter(
        (el) => Number.parseFloat(getComputedStyle(el).borderTopWidth) > 0,
      )
      .map((el) => ({
        id: name(el),
        r: ratio(getComputedStyle(el).borderTopColor, fill(el.parentElement)),
      }))
      .filter((m) => m.r < 3)
      .map((m) => `${m.id} ${m.r.toFixed(2)}`);
  // State indicators drawn as inset box-shadows (toggle ring, tab underline,
  // row bar): the shadow's color against the element's own fill.
  const indicators = () => {
    const sel: Record<string, string> = {
      "toggle on": '[data-slot="toggle-group-item"][data-state="on"]',
      "active tab": '[data-slot="tabs-trigger"][data-state="active"]',
      "selected row":
        '[data-slot="table-row"][data-state="selected"] > *:first-child',
    };
    return Object.entries(sel).map(([label, s]) => {
      const els = [...document.querySelectorAll(s)];
      const worst = Math.min(
        ...els.map((el) => {
          // Tailwind composes several shadows; take the visible inset one.
          const inset = getComputedStyle(el)
            .boxShadow.split(/,(?![^(]*\))/)
            .filter((s) => s.includes("inset"))
            .map((s) => s.match(/rgba?\([^)]*\)/)?.[0] ?? "")
            .find((c) => c && (parse(c)[3] ?? 1) > 0);
          return inset ? ratio(inset, fill(el)) : 0;
        }),
      );
      return { label, count: els.length, worst: Number(worst.toFixed(2)) };
    });
  };
  // biome-ignore lint/suspicious/noExplicitAny: test-only global
  (window as any).__oa = { focus, axeRun, borders, indicators };
}

export const oa = (
  page: Page,
  fn: "focus" | "axeRun" | "borders" | "indicators",
  arg?: boolean,
) =>
  // biome-ignore lint/suspicious/noExplicitAny: test-only global
  page.evaluate(([f, a]) => (window as any).__oa[f as string](a), [fn, arg]);

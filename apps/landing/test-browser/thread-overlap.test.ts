// #2480: the timeline block grows for the comment thread drawn inside it, so
// the thread never runs over the block after it ("Launch checklist"). Checked
// wherever the thread shows inline: the stacked scene cards (phones, reduced
// motion, no script) and the phone's locked story, at 390 and 1280.
import type { Server } from "node:http";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDist } from "./serve";

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  ({ server, base } = await serveDist());
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.close();
});

/** Each shown timeline holding an inline thread, with what spills out of it. */
const spills = (page: Page) =>
  page.evaluate(() => {
    const shown = (e: Element) => {
      for (let a: Element | null = e; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === "none" || s.visibility === "hidden") return false;
        if (Number(s.opacity) <= 0.1) return false;
      }
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const out: { blk: number; thread: number; next: number | null }[] = [];
    for (const th of document.querySelectorAll(".sa-inline .sa-th")) {
      if (!shown(th)) continue;
      const blk = th.closest(".sa-blk") as HTMLElement;
      let next = blk.nextElementSibling;
      while (next && !shown(next)) next = next.nextElementSibling;
      out.push({
        blk: Math.round(blk.getBoundingClientRect().bottom),
        thread: Math.round(th.getBoundingClientRect().bottom),
        next: next ? Math.round(next.getBoundingClientRect().top) : null,
      });
    }
    return out;
  });

const check = (rows: Awaited<ReturnType<typeof spills>>, label: string) => {
  for (const r of rows) {
    expect(r.thread, `${label}: thread inside its block`).toBeLessThanOrEqual(
      r.blk,
    );
    if (r.next !== null)
      expect(
        r.next,
        `${label}: next block starts below`,
      ).toBeGreaterThanOrEqual(r.blk);
  }
};

describe("the inline thread stays inside the timeline (#2480)", () => {
  for (const width of [390, 1280])
    for (const [mode, opts] of [
      ["reduced motion", { reducedMotion: "reduce" as const }],
      ["no script", { javaScriptEnabled: false }],
    ] as const)
      it(`stacked cards at ${width}, ${mode}`, async () => {
        const ctx = await browser.newContext({
          viewport: { width, height: 844 },
          ...opts,
        });
        const page = await ctx.newPage();
        await page.goto(`${base}/`, { waitUntil: "load" });
        const rows = await spills(page);
        expect(rows.length, "some inline thread is shown").toBeGreaterThan(0);
        check(rows, `${width} ${mode}`);
        await ctx.close();
      });

  it("the phone's locked story, beat by beat", async () => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/`, { waitUntil: "load" });
    const units = await page.evaluate(() => {
      const steps = document.getElementById("plsteps");
      return steps ? steps.children.length : 0;
    });
    expect(units, "the phone story is locked").toBeGreaterThan(0);
    let seen = 0;
    for (let b = 0; b < units; b++) {
      await page.evaluate((b) => {
        const pl = document.getElementById("pl") as HTMLElement;
        const unit = (
          document.getElementById("plsteps") as HTMLElement
        ).firstElementChild?.getBoundingClientRect().height as number;
        scrollTo({
          top: pl.getBoundingClientRect().top + scrollY + (b + 0.5) * unit,
          behavior: "instant",
        });
      }, b);
      // Two frames for the beat's styles to apply, then wait until the
      // story's transitions (max-height, opacity) have all finished.
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      await page.waitForFunction(
        () =>
          !document
            .getAnimations()
            .some(
              (a) =>
                a instanceof CSSTransition &&
                a.playState === "running" &&
                (a.effect as KeyframeEffect | null)?.target?.closest?.(
                  ".pl-view",
                ),
            ),
      );
      const rows = await spills(page);
      if (rows.length) seen++;
      check(rows, `phone beat ${b}`);
    }
    expect(seen, "some beat shows the inline thread").toBeGreaterThan(0);
    await ctx.close();
  });
});

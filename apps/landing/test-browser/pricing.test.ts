// The four plan buttons sit on one line, wide and narrow, monthly and yearly.
// On a phone the next plan's edge peeks in, so the swipe is obvious, and the
// page itself never scrolls sideways.
import type { Server } from "node:http";
import { type Browser, chromium } from "playwright";
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

describe("pricing buttons share a baseline", () => {
  for (const width of [1280, 390]) {
    it(`at ${width}px, in both billing periods`, async () => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
      });
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.locator("#pricing").scrollIntoViewIfNeeded();
      const tops = () =>
        page
          .locator("#pricing thead .btn")
          .evaluateAll((els) =>
            els.map((e) => Math.round(e.getBoundingClientRect().top)),
          );
      for (const period of ["m", "y"]) {
        await page
          .locator(`#pricing .toggle button[data-p="${period}"]`)
          .click();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const t = await tops();
        expect(t).toHaveLength(4);
        expect(new Set(t).size).toBe(1);
      }
      await page.close();
    });
  }
});

describe("pricing table on a phone", () => {
  it("lets about 24px of the Team column peek in, with no sideways page scroll", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 900 },
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    const m = await page.evaluate(() => {
      const team = document.querySelector(
        "table.cmp thead th.col-pop",
      ) as HTMLElement;
      const tw = document.querySelector("#twf .tw") as HTMLElement;
      return {
        left: team.getBoundingClientRect().left,
        edge: tw.getBoundingClientRect().right,
        vw: innerWidth,
        sw: document.documentElement.scrollWidth,
      };
    });
    expect(m.left).toBeLessThan(m.vw);
    expect(m.edge - m.left).toBeGreaterThanOrEqual(18);
    expect(m.edge - m.left).toBeLessThanOrEqual(30);
    expect(m.sw).toBe(m.vw);
    await page.close();
  });
});

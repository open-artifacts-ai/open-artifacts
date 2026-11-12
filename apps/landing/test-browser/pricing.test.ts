// The four plan buttons sit on one line, wide and narrow, monthly and yearly.
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

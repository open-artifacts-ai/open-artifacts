// The wide story still follows the chapters: the rail's second button lands on
// "Decide" and the ask card is on the stage. (The phone lock keeps its own
// slots with the same class, which must not be mistaken for chapters.)
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

describe("wide story", () => {
  it("the rail's Decide button lands on the Decide chapter with the ask open", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.evaluate(() =>
      (document.querySelectorAll("#rail button")[1] as HTMLElement).click(),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".chs .ch.cur h2")?.textContent ===
        "Decide with one click.",
      undefined,
      { timeout: 8000 },
    );
    expect(
      await page.locator("#ask").evaluate((e) => e.classList.contains("hide")),
    ).toBe(false);
    await page.locator('#ask .opt[data-k="a"]').click();
    expect(
      await page.locator('#ask .opt[data-k="a"]').getAttribute("aria-pressed"),
    ).toBe("true");
    await page.close();
  });
});

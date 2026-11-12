// The phone story is one locked screen: it stays put while you scroll through
// ten beats, the header and the piece change with the beat, and the chapters'
// pieces still take taps. Run on an iPhone-sized touch device. Wide pages
// do not lock.
import type { Server } from "node:http";
import { type Browser, chromium, devices, type Page } from "playwright";
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

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

async function phone() {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: "load" });
  return { ctx, page };
}

// Scroll so the locked run is `beat + 0.5` steps in.
async function toBeat(page: Page, beat: number) {
  await page.evaluate((b) => {
    const pl = document.getElementById("pl") as HTMLElement;
    const unit = (
      document.getElementById("plsteps") as HTMLElement
    ).firstElementChild?.getBoundingClientRect().height as number;
    const y = pl.getBoundingClientRect().top + scrollY + (b + 0.5) * unit;
    scrollTo({ top: y, behavior: "instant" });
  }, beat);
  await frames(page);
}

const pinTop = (page: Page) =>
  page.locator(".pl-pin").evaluate((e) => ({
    top: Math.round(e.getBoundingClientRect().top),
    h: Math.round(e.getBoundingClientRect().height),
    vh: innerHeight,
  }));

describe("phone locked story", () => {
  it("locks on a phone, and the story section is not shown", async () => {
    const { ctx, page } = await phone();
    expect(await page.locator("#lp").getAttribute("data-pl")).toBe("1");
    expect(await page.locator("#story").isVisible()).toBe(false);
    expect(await page.locator("#sc").isVisible()).toBe(false);
    await ctx.close();
  });

  it("stays pinned to the top of the screen through all ten beats", async () => {
    const { ctx, page } = await phone();
    const titles: string[] = [];
    for (let b = 0; b < 10; b++) {
      await toBeat(page, b);
      const p = await pinTop(page);
      expect(p.top).toBe(0);
      expect(p.h).toBe(p.vh);
      expect(await page.locator("#pl").getAttribute("data-beat")).toBe(
        String(b),
      );
      titles.push((await page.locator("#plhead b").textContent()) ?? "");
    }
    expect(new Set(titles).size).toBe(10);
    expect(titles[4]).toContain("last time you scroll");
    expect(titles[9]).toBe("Share it with anyone.");
    // past the end, the screen lets go and the page goes on
    await page.evaluate(() =>
      scrollBy({ top: innerHeight * 3, behavior: "instant" }),
    );
    await frames(page);
    expect((await pinTop(page)).top).toBeLessThan(0);
    await ctx.close();
  });

  it("follows a real touch swipe", async () => {
    const { ctx, page } = await phone();
    await toBeat(page, 0);
    const cdp = await ctx.newCDPSession(page);
    const before = await page.evaluate(() => scrollY);
    // a finger drag: touchStart, many small touchMoves, touchEnd (the browser
    // turns it into a scroll the way it does on a phone)
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      y?: number,
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: y === undefined ? [] : [{ x: 195, y }],
      });
    for (let i = 0; i < 6; i++) {
      await touch("touchStart", 560);
      for (let y = 560; y >= 300; y -= 20) {
        await touch("touchMove", y);
        await page.waitForTimeout(8);
      }
      await touch("touchEnd");
      await page.waitForTimeout(150);
    }
    await frames(page);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(before + 400);
    expect((await pinTop(page)).top).toBe(0);
    expect(
      Number(await page.locator("#pl").getAttribute("data-beat")),
    ).toBeGreaterThan(0);
    await ctx.close();
  });

  it("the chapter pieces take taps while the screen is locked", async () => {
    const { ctx, page } = await phone();
    await toBeat(page, 6);
    // the piece fades in (animations are not paused while the screen is locked)
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".pl-slot.on") as Element)
          .opacity === "1",
      undefined,
      { timeout: 3000 },
    );
    const card = page.locator('.pl-slot.on .mp[data-mp="ask"]');
    expect(await card.isVisible()).toBe(true);
    await card.locator('.mopt[data-k="b"]').tap();
    expect(
      await card.locator('.mopt[data-k="b"]').getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await card.locator("[data-afy]").textContent()).toBe(
      "1 ask for you",
    );
    // and it stayed pinned
    expect((await pinTop(page)).top).toBe(0);
    await ctx.close();
  });

  it("does not lock on a wide page", async () => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    expect(await page.locator("#lp").getAttribute("data-pl")).toBe("0");
    expect(await page.locator("#pl").isVisible()).toBe(false);
    expect(await page.locator("#story").isVisible()).toBe(true);
    await page.close();
  });
});

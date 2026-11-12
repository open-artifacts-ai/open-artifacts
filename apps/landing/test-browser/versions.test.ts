// The phone versions card: the newest version is the one marked Current in the
// list, tapping an older one shows the banner, and Restore adds a new top.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = resolve(import.meta.dirname, "../dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    let path = join(dist, new URL(req.url ?? "/", "http://x").pathname);
    if (existsSync(path) && statSync(path).isDirectory())
      path = join(path, "index.html");
    if (!existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    });
    res.end(readFileSync(path));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe("phone versions card at 390px", () => {
  it("shows the banner only for an older version, and Restore makes a new top", async () => {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    // on a phone the story is locked: bring the versions beat (8) up
    await page.evaluate(() => {
      const pl = document.getElementById("pl") as HTMLElement;
      const unit = (
        document.getElementById("plsteps") as HTMLElement
      ).firstElementChild?.getBoundingClientRect().height as number;
      scrollTo({
        top: pl.getBoundingClientRect().top + scrollY + 8.5 * unit,
        behavior: "instant",
      });
    });
    const card = page.locator('.mp[data-mp="ver"]');
    await card.waitFor({ state: "visible" });
    const banner = card.locator("[data-ban]");
    const shown = async () =>
      banner.evaluate((e) => e.classList.contains("on"));
    // the newest version is v5 (marked Current), so it shows no banner
    await card.locator('button[data-v="5"]').click();
    expect(await shown()).toBe(false);
    await card.locator('button[data-v="3"]').click();
    expect(await shown()).toBe(true);
    expect(await card.locator("[data-vb]").textContent()).toBe("v3");
    // restore from v2: a new top, v6, current, and no second v4
    await card.locator('button[data-v="2"]').click();
    try {
      // the banner has finished opening (its box holds the whole button) and
      // the screen is still on the versions beat, so the click needs no scroll
      await page.waitForFunction(
        () => {
          const ban = document.querySelector(
            '.mp[data-mp="ver"] [data-ban]',
          ) as HTMLElement;
          const btn = ban.querySelector("[data-restore]") as HTMLElement;
          const bb = ban.getBoundingClientRect();
          const rb = btn.getBoundingClientRect();
          return (
            document.getElementById("pl")?.dataset.beat === "8" &&
            rb.height > 0 &&
            rb.top >= bb.top &&
            rb.bottom <= bb.bottom
          );
        },
        undefined,
        { timeout: 5000 },
      );
    } catch (e) {
      const state = await page.evaluate(() => {
        const r = (s: string) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return [
            Math.round(b.top),
            Math.round(b.height),
            getComputedStyle(el).display,
          ];
        };
        return JSON.stringify({
          scrollY,
          beat: document.getElementById("pl")?.dataset.beat,
          pl: r("#pl"),
          slot: r(".pl-slot.on"),
          mp: r('.mp[data-mp="ver"]'),
          ban: r('.mp[data-mp="ver"] [data-ban]'),
          restore: r('.mp[data-mp="ver"] [data-restore]'),
          banCls: document.querySelector('.mp[data-mp="ver"] [data-ban]')
            ?.className,
        });
      });
      throw new Error(`restore not visible: ${state}`, { cause: e });
    }
    await card.locator("[data-restore]").click();
    const first = card.locator(".vlist li").first();
    expect(await first.locator("b").textContent()).toBe("v6");
    expect(await first.locator("em").textContent()).toBe("Current");
    expect(await card.locator("[data-ver]").textContent()).toBe("v6");
    expect(await shown()).toBe(false);
    expect(await card.locator('button[data-v="4"]').count()).toBe(1);
    expect(await card.locator("button[data-v]").count()).toBe(6);
    await page.close();
  });
});

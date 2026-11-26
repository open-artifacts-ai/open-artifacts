// The landing never scrolls sideways: at phone, laptop and wide desktop
// widths, in light and dark, in Chromium and WebKit, the page is no wider
// than the viewport and the header nav is fully on screen.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { type Browser, type BrowserType, chromium, webkit } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = resolve(import.meta.dirname, "../dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
};
const WIDTHS = [390, 1280, 1440, 1920];

// Mirrors packages/ui/test-browser/harness.ts: the browser runs as a server so
// teardown has its process. Closing can stall on a loaded runner, so it gets
// 5s before the process is killed; afterAll allows 15s.
async function launch(engine: BrowserType) {
  const server = await engine.launchServer();
  const browser = await engine.connect(server.wsEndpoint());
  const close = async () => {
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      server.close().then(() => true),
      new Promise<false>((r) => {
        timer = setTimeout(() => r(false), 5_000);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) await server.kill();
  };
  return { browser, close };
}

let server: Server;
let base: string;

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
});
afterAll(() => server?.close());

describe.each([
  ["chromium", chromium],
  ["webkit", webkit],
])("%s: no horizontal overflow on the index", (_, engine) => {
  let browser: Browser;
  let close = async () => {};
  beforeAll(async () => {
    ({ browser, close } = await launch(engine));
  });
  afterAll(() => close(), 15_000);

  for (const scheme of ["light", "dark"] as const)
    it.each(WIDTHS)(`${scheme} at %ipx`, async (width) => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      await page.goto(`${base}/`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      // Let the scripts lay out (the feature story moves its mocks on wide
      // screens): they render on animation frames, so wait for two of them.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      const r = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const nav = document
          .querySelector(".site-head nav")
          ?.getBoundingClientRect();
        return {
          w,
          scroll: document.documentElement.scrollWidth,
          navRight: nav?.right ?? 0,
        };
      });
      await page.close();
      expect(r.scroll, "page wider than the viewport").toBeLessThanOrEqual(r.w);
      expect(r.navRight, "header nav runs off screen").toBeLessThanOrEqual(r.w);
    });
});

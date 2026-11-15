// Regenerate the existing OG composition from the current SVG brand masters.
// Run: pnpm --filter @oa/ui exec node scripts/generate-brand-og.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const logo = readFileSync(
  new URL("../src/brand/logo.svg", import.meta.url),
  "utf8",
);
const mark = readFileSync(
  new URL("../src/brand/mark-light.svg", import.meta.url),
  "utf8",
);
const font = (weight) =>
  readFileSync(
    new URL(
      import.meta.resolve(
        `@fontsource/geist/files/geist-latin-${weight}-normal.woff2`,
      ),
    ),
  ).toString("base64");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><html><meta charset="utf-8"><style>
    @font-face{font-family:Geist;font-weight:400;src:url(data:font/woff2;base64,${font(400)})}
    @font-face{font-family:Geist;font-weight:600;src:url(data:font/woff2;base64,${font(600)})}
    *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#EEF0F3;color:#15181C;font-family:Geist,sans-serif}
    .panel{position:absolute;left:784px;top:0;width:416px;height:630px;background:#F5F6F8;border-left:2px solid #E0E3E8}
    .logo{position:absolute;left:80px;top:80px;width:358px;height:64px}.logo svg{width:100%;height:100%}
    .mark{position:absolute;left:808px;top:139px;width:352px;height:352px}.mark svg{width:100%;height:100%}
    h1{position:absolute;left:80px;top:324px;margin:0;font-size:56px;font-weight:600;line-height:1.25;letter-spacing:-1.12px}
    p{position:absolute;left:80px;top:526px;margin:0;color:#5F6670;font-size:24px;font-weight:400}
  </style><div class="panel"></div><div class="logo">${logo}</div><div class="mark">${mark}</div><h1>Your agents’ artifacts,<br>on your own Cloudflare.</h1><p>open-artifacts.com</p></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: new URL("../../../apps/landing/public/og.png", import.meta.url)
      .pathname,
  });
} finally {
  await browser.close();
}

// #2426 A: an unanswered ask shows an amber Ask marker where it is anchored (a quote, a pin);
// a click opens its card beside it, drawn by the shell. The frame is a stand-in page with the real
// built runtime (packages/runtime/dist): run `pnpm --filter @oa/runtime build` first.
// Shots only when ASK_SHOTS_DIR is set.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const DIST = join(process.cwd(), "../../packages/runtime/dist");
const OUT = process.env.ASK_SHOTS_DIR;

test.use({
  screenshot: "only-on-failure",
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

const CHART = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><rect width="900" height="560" fill="#fff"/><text x="40" y="60" font-family="system-ui" font-size="30" font-weight="700" fill="#15181c">Q4 revenue</text>${[
    200, 270, 235, 330, 305, 400,
  ]
    .map(
      (h, i) =>
        `<rect x="${70 + i * 130}" y="${500 - h}" width="90" height="${h}" rx="6" fill="#2350d0" opacity=".85"/>`,
    )
    .join("")}</svg>`,
)}`;

function frameHtml(kind: "html" | "image", schemas: string) {
  const body =
    kind === "image"
      ? `<div class="oa-image" style="padding:16px"><img alt="chart" src="${CHART}" style="display:block;max-width:100%;margin:auto"></div>`
      : `<main style="max-width:640px;margin:0 auto;padding:32px 20px;font:17px/1.6 system-ui"><h1>Launch plan</h1><p>The launch is planned for Thursday, Dec 4 and the beta follows a week later. Support is staffed all week.</p><p>Pricing stays as announced.</p></main>`;
  const hello = `import("/_oa/${schemas}").then(()=>setTimeout(()=>parent.postMessage({oa:1,type:"hello",protocol:7,kind:"${kind}",nonce:window.__nonce},"*"),0))`;
  return `<!doctype html><meta name="oa-format" content="${kind}"><body style="margin:0;background:#eceef1">${body}<div style="height:900px"></div><script>window.__nonce=new URLSearchParams(location.hash.slice(1)).get("oa")</script><script src="/_oa/runtime.js"></script><script>${hello}</script>`;
}

async function open(
  page: Page,
  kind: "html" | "image",
  w: number,
  theme: "light" | "dark",
) {
  const manifest = JSON.parse(
    readFileSync(join(DIST, "runtime.manifest.json"), "utf8"),
  );
  await page.context().route("https://content.example.com/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith("/_oa/")) {
      const name = u.pathname.endsWith("/runtime.js")
        ? manifest["src/index.ts"].file
        : u.pathname.split("/").pop();
      return r.fulfill({
        contentType: "text/javascript",
        body: readFileSync(join(DIST, name ?? ""), "utf8"),
      });
    }
    return r.fulfill({
      contentType: "text/html",
      body: frameHtml(kind, manifest["src/schemas.ts"].file),
    });
  });
  // The overlay is a closed shadow root; open it for the test so roles can be read.
  await page.context().addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return attach.call(this, { ...init, mode: "open" });
    };
  });
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
  await page.goto(
    `/a/${ID}?mock=${kind === "image" ? "pins-ask" : "quote-ask"}`,
  );
  return page.frameLocator("iframe.oa-vframe");
}
async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test.beforeAll(() => {
  expect(existsSync(join(DIST, "runtime.manifest.json"))).toBe(true);
});

for (const w of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: a quote ask shows an Ask marker and opens its card in the page`, async ({
      page,
    }) => {
      const frame = await open(page, "html", w, theme);
      const marker = frame.getByRole("button", {
        name: "Ask: open the question",
      });
      await expect(marker).toBeVisible({ timeout: 15_000 });
      await shot(page, `${w}-${theme}-quote-marker`);
      await marker.click();
      const card = page.locator("[data-ask-beside]");
      await expect(card).toBeVisible();
      // Drawn by the shell, outside the sandboxed frame, and inert at first.
      await expect(card).toHaveCSS("pointer-events", "none");
      await expect(card).toHaveAttribute("data-armed", "", { timeout: 3000 });
      await expect(card.getByText("Launch Thursday or Friday?")).toBeVisible();
      await shot(page, `${w}-${theme}-quote-card`);
      // Pick in place: the marker goes, the comments pane was never opened.
      await card.getByRole("button", { name: /Thursday/ }).click();
      await expect(marker).toHaveCount(0, { timeout: 10_000 });
      await shot(page, `${w}-${theme}-quote-answered`);
    });

    test(`${w} ${theme}: a pin ask shows an Ask marker and opens its card in the page`, async ({
      page,
    }) => {
      const frame = await open(page, "image", w, theme);
      await expect(frame.locator(".pin.ask").first()).toBeVisible({
        timeout: 15_000,
      });
      await shot(page, `${w}-${theme}-pin-marker`);
      await frame.locator(".pin.ask").first().click();
      const card = page.locator("[data-ask-beside]");
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("data-armed", "", { timeout: 3000 });
      await shot(page, `${w}-${theme}-pin-card`);
    });
  }

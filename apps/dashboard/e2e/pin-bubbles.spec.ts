// #2019: bubble pins on images and pdfs, and the box beside the flag. The
// frame is a stand-in page with the real built runtime (packages/runtime/dist);
// run `pnpm --filter @oa/runtime build` first. Shots only when PINS_SHOTS_DIR is set.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page, an image or a pdf under ?mock=pins
const DIST = join(process.cwd(), "../../packages/runtime/dist");
const OUT = process.env.PINS_SHOTS_DIR;

test.use({
  screenshot: "only-on-failure",
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

const CHART = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><rect width="900" height="560" fill="#fff"/><text x="40" y="60" font-family="system-ui" font-size="30" font-weight="700" fill="#15181c">Q4 revenue</text><text x="40" y="92" font-family="system-ui" font-size="16" fill="#5f6670">All regions, in thousands</text>${[
    200, 270, 235, 330, 305, 400,
  ]
    .map(
      (h, i) =>
        `<rect x="${70 + i * 130}" y="${500 - h}" width="90" height="${h}" rx="6" fill="#2350d0" opacity=".85"/>`,
    )
    .join("")}</svg>`,
)}`;

function frameHtml(kind: "image" | "pdf", schemas: string) {
  const body =
    kind === "image"
      ? `<div class="oa-image" style="padding:16px"><img alt="chart" src="${CHART}" style="display:block;max-width:100%;margin:auto"></div>`
      : `<div class="page" data-page-number="1" style="width:560px;height:720px;margin:16px auto;background:#fff;box-shadow:0 2px 10px #0003;padding:32px;font:16px system-ui"><h2>Q4 revenue</h2><img alt="" src="${CHART}" style="width:100%"></div>`;
  // The runtime clears the nonce from the address, so it is read first.
  // The renderer says hello once the runtime's comments chunk is up; so does this
  // stand-in (the same module, already loaded by the runtime, so its handlers
  // are registered by the time this resolves).
  const hello = `import("/_oa/${schemas}").then(()=>setTimeout(()=>parent.postMessage({oa:1,type:"hello",protocol:5,kind:"${kind}",nonce:window.__nonce},"*"),0))`;
  return `<!doctype html><meta name="oa-format" content="${kind}"><body style="margin:0;background:#eceef1">${body}<script>window.__nonce=new URLSearchParams(location.hash.slice(1)).get("oa")</script><script src="/_oa/runtime.js"></script><script>${hello}</script>`;
}

async function open(
  page: Page,
  kind: "image" | "pdf",
  w: number,
  theme = process.env.PINS_THEME ?? "light",
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
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
  await page.goto(`/a/${ID}?mock=${kind === "image" ? "pins" : "pins-pdf"}`);
  return page.frameLocator("iframe.oa-vframe");
}
async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  const sfx = process.env.PINS_THEME === "dark" ? "-dark" : "";
  await page.screenshot({ path: `${OUT}/${name}${sfx}.png` });
}

test.beforeAll(() => {
  expect(existsSync(join(DIST, "runtime.manifest.json"))).toBe(true);
});

for (const kind of ["image", "pdf"] as const)
  test(`${kind}: bubbles show initials and faces, and open their thread`, async ({
    page,
  }) => {
    const frame = await open(page, kind, 1280);
    // The overlay is a closed shadow root: reach it through the accessible tree.
    await expect(
      frame.getByRole("button", { name: "Comment by Sam Rivera" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      frame.getByRole("button", { name: "Comment by OA Product" }),
    ).toBeVisible({ timeout: 15_000 });
    // The resolved pin is hidden until its thread is open.
    await expect(
      frame.getByRole("button", { name: /Comment by Leo|Comment by Ada/ }),
    ).toHaveCount(0);
    await shot(page, `1280-${kind}-bubbles`);
    await frame.getByRole("button", { name: "Comment by Sam Rivera" }).click();
    await expect(
      page.getByRole("complementary", { name: "Comments" }),
    ).toBeVisible({ timeout: 15_000 });
    await shot(page, `1280-${kind}-open`);
  });

test("a resolved thread's bubble shows faded while its thread is open", async ({
  page,
}) => {
  const frame = await open(page, "image", 1280);
  const mine = frame.getByRole("button", { name: /^Comment by (Ada|Leo)/ });
  await expect(
    frame.getByRole("button", { name: "Comment by Sam Rivera" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(mine).toHaveCount(0);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page.getByRole("button", { name: /^Show resolved/ }).click();
  await page
    .locator("[data-thread]", { hasText: "Axis label looks wrong." })
    .getByRole("button", { name: "Show pin in page" })
    .click();
  await expect(mine).toHaveCount(1);
  await expect(mine).toHaveClass(/resolved/);
  await shot(page, "1280-image-resolved");
});

test("image: click-to-comment opens the box beside the flag on a wide screen", async ({
  page,
}) => {
  const frame = await open(page, "image", 1280);
  await expect(
    frame.getByRole("button", { name: "Comment by Sam Rivera" }),
  ).toBeVisible({ timeout: 15_000 });
  const img = frame.locator("img");
  const box = await img.boundingBox();
  if (!box) throw new Error("no image");
  // An image opens in pin mode: a click on it places the flag.
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.72);
  const textbox = page.getByRole("textbox", { name: "Add a comment" });
  await expect(textbox).toBeFocused();
  await expect(page.locator("[data-pin-beside]")).toContainText("Comment");
  const side = await page.locator("[data-pin-beside]").boundingBox();
  expect(side).not.toBeNull();
  // Right of the click, not in the 340px comments column.
  expect(side?.x ?? 0).toBeGreaterThan(box.x + box.width * 0.12);
  await shot(page, "1280-image-beside");
  await textbox.fill("Here is a comment");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-pin-beside]")).toHaveCount(0);
});

test("image: a click near the bottom right keeps the box fully in view", async ({
  page,
}) => {
  const frame = await open(page, "image", 1280);
  await expect(
    frame.getByRole("button", { name: "Comment by Sam Rivera" }),
  ).toBeVisible({ timeout: 15_000 });
  const img = await frame.locator("img").boundingBox();
  const host = await page.locator("iframe.oa-vframe").boundingBox();
  if (!img || !host) throw new Error("no frame");
  await page.mouse.click(img.x + img.width - 6, img.y + img.height - 6);
  const side = page.locator("[data-pin-beside]");
  await expect(side).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Add a comment" }),
  ).toBeFocused();
  const b = await side.boundingBox();
  if (!b) throw new Error("no box");
  expect(b.x).toBeGreaterThanOrEqual(host.x);
  expect(b.y).toBeGreaterThanOrEqual(host.y);
  expect(b.x + b.width).toBeLessThanOrEqual(host.x + host.width);
  expect(b.y + b.height).toBeLessThanOrEqual(host.y + host.height);
  // It is left of the flag, not on it.
  expect(b.x + b.width).toBeLessThanOrEqual(img.x + img.width - 6);
  await shot(page, "1280-image-bottom-right");
});

test("phone: the flag drops and the box is in the comments sheet", async ({
  page,
}) => {
  const frame = await open(page, "image", 390);
  await expect(
    frame.getByRole("button", { name: "Comment by Sam Rivera" }),
  ).toBeVisible({ timeout: 15_000 });
  await shot(page, "390-image-bubbles");
  const img = frame.locator("img");
  const box = await img.boundingBox();
  if (!box) throw new Error("no image");
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.72);
  const textbox = page.getByRole("textbox", { name: "Add a comment" });
  await expect(textbox).toBeVisible();
  await expect(page.locator("[data-pin-beside]")).toHaveCount(0);
  await shot(page, "390-image-sheet");
});

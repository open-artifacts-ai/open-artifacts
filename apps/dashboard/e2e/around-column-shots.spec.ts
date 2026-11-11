// #2118 part 2: title bar, Comment bubble, ask card, older-version banner.
// Shots only when AROUND_SHOTS_DIR is set.
import { mkdirSync, readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.AROUND_SHOTS_DIR;

async function setup(page: Page, w: number, theme: string) {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
}
async function shot(page: Page, name: string, clip?: { height: number }) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    ...(clip
      ? {
          clip: {
            x: 0,
            y: 0,
            width: page.viewportSize()?.width ?? 1280,
            ...clip,
          },
        }
      : {}),
  });
}

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`${w} ${theme}: title bar and older-version banner`, async ({
      page,
    }) => {
      await setup(page, w, theme);
      await page.goto(`/a/${ID}?mock=agents`);
      await expect(
        page.getByRole("button", { name: /^Comments/ }),
      ).toBeVisible();
      await shot(page, `${w}-${theme}-titlebar`, {
        height: w < 600 ? 200 : 110,
      });
      await page.goto(`/a/${ID}/v/1?mock=agents`);
      await expect(page.getByText(/an older version\./)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Back to current" }),
      ).toBeVisible();
      await shot(page, `${w}-${theme}-banner`, { height: w < 600 ? 260 : 160 });
    });

    test(`${w} ${theme}: ask card`, async ({ page }) => {
      await setup(page, w, theme);
      await page.goto(`/a/${ID}?mock=asks`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const card = page.locator("[data-ask][data-needs-you]").first();
      await expect(card).toBeVisible();
      await expect(card.locator("[data-ask-from]")).toContainText(" asks you");
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await card.screenshot({ path: `${OUT}/${w}-${theme}-ask.png` });
      }
    });

    // The runtime's overlay CSS, as shipped, on a sample paragraph. The mock
    // frame has no runtime, so the pill is laid out by hand here.
    test(`${w} ${theme}: Comment bubble`, async ({ page }) => {
      await setup(page, w, theme);
      const src = readFileSync(
        "../../packages/runtime/src/comments.ts",
        "utf8",
      );
      const css = /const OVERLAY_CSS = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
      const bubble = /const BUBBLE =\s*'([^']*)'/.exec(src)?.[1] ?? "";
      await page.setContent(
        `<style>body{margin:0;padding:48px 24px;font:17px/1.6 system-ui;background:#fff;color:#27272a;position:relative}@media(prefers-color-scheme:dark){body{background:#131518;color:#eceef1}}.sel{background:#b3d4fc;color:#17181a}${css}</style><p style="max-width:${w < 600 ? 330 : 640}px">Your agents put their work in an artifact. <span class=sel>Your team reads it, comments on it and decides</span>, right where the work is.</p><button class="btn" style="left:${w < 600 ? 70 : 170}px;top:${w < 600 ? 12 : 12}px;--ax:50%">${bubble}<span>Comment</span></button>`,
      );
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({
          path: `${OUT}/${w}-${theme}-bubble.png`,
          clip: { x: 0, y: 0, width: w < 600 ? 390 : 760, height: 150 },
        });
      }
    });
  }
}

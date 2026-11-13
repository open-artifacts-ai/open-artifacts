// #2287: Welcome (the page the server seeds) in the viewer with the real built
// runtime, the first open, the ticks, and the Solo trial chip. Run
// `pnpm --filter @oa/runtime build` first. Shots only when WELCOME_SHOTS_DIR is set.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { welcomeHtml } from "@oa/shared";
import { expect, type Page, test } from "@playwright/test";

const ID = "WmCnEfGhJk4mNpQr"; // the mock's Welcome (?mock=welcome)
const DIST = join(process.cwd(), "../../packages/runtime/dist");
const OUT = process.env.WELCOME_SHOTS_DIR;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});
test.beforeAll(() => {
  expect(existsSync(join(DIST, "runtime.manifest.json"))).toBe(true);
});

const SIZES = [
  { w: 1280, h: 800 },
  { w: 390, h: 844 },
];
const THEMES = ["light", "dark"] as const;

async function serveFrame(page: Page, host: string) {
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
    // The server injects the runtime first in <head>; so does this.
    return r.fulfill({
      contentType: "text/html",
      body: welcomeHtml(host).replace(
        "<head>",
        '<head><meta name="oa-format" content="html"><script src="/_oa/runtime.js"></script>',
      ),
    });
  });
}
async function shot(page: Page, name: string, w: number, theme: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png` });
}

for (const { w, h } of SIZES)
  for (const theme of THEMES)
    test.describe(`${w} ${theme}`, () => {
      test.beforeEach(async ({ page, baseURL }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width: w, height: h });
        await serveFrame(page, baseURL ?? "");
      });

      test("first open lands on Welcome, nothing ticked", async ({ page }) => {
        await page.goto("/?mock=welcome");
        await page.waitForURL(`**/a/${ID}**`);
        const frame = page.frameLocator("iframe.oa-vframe");
        await expect(
          frame.getByRole("heading", { name: "Welcome" }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          frame.getByText("Publish your first artifact"),
        ).toBeVisible();
        await expect(
          frame.locator('[data-step][data-done="true"]'),
        ).toHaveCount(0);
        // No sideways scroll inside the frame.
        const wide = await frame
          .locator("html")
          .evaluate((e) => e.scrollWidth > e.clientWidth);
        expect(wide).toBe(false);
        await shot(page, "1-first-open", w, theme);
        await frame.getByRole("tab", { name: "Claude Code" }).click();
        await expect(frame.getByText(/claude mcp add/)).toBeVisible();
        await shot(page, "1b-claude-tab", w, theme);
      });

      test("the shell lets the page tick: one, then all three", async ({
        page,
      }) => {
        await page.goto(`/a/${ID}?mock=welcome&opened=1&ticks=connect`);
        const frame = page.frameLocator("iframe.oa-vframe");
        await expect(frame.getByText("Agent connected")).toBeVisible({
          timeout: 15_000,
        });
        await expect(
          frame.locator('[data-step][data-done="true"]'),
        ).toHaveCount(1);
        await shot(page, "2-one-ticked", w, theme);

        await page.goto(
          `/a/${ID}?mock=welcome&opened=1&ticks=connect,publish,comment`,
        );
        await expect(frame.getByText("Commented")).toBeVisible({
          timeout: 15_000,
        });
        const link = frame.getByRole("link", { name: "Landing page" });
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(frame.getByText(/You're set/)).toBeVisible();
        await shot(page, "3-all-ticked", w, theme);
      });

      test("Library shows Welcome as a normal row", async ({ page }) => {
        await page.goto("/?mock=welcome&opened=1");
        await expect(page.getByRole("link", { name: "Welcome" })).toBeVisible();
        await shot(page, "5-library", w, theme);
      });

      test("the Solo trial chip opens its note", async ({ page }) => {
        await page.goto("/?hosted=solo");
        const chip = page.getByTestId("plan-chip");
        await expect(chip).toContainText("Solo · ");
        await expect(chip).toContainText("days free");
        await chip.click();
        await expect(page.getByText(/No card needed/)).toBeVisible();
        await shot(page, "4-plan-chip", w, theme);
      });
    });

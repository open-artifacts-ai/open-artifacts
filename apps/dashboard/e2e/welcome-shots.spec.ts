// #2287: Welcome (the page the server seeds) in the viewer with the real built
// runtime: the first open and the ticks. Run `pnpm --filter @oa/runtime build`
// first. The step states and the Solo trial chip live in
// test/welcome-page.test.tsx and test/welcome.test.tsx.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { welcomePage as welcomeHtml } from "@oa/shared";
import { expect, type Page, test } from "@playwright/test";

const ID = "WmCnEfGhJk4mNpQr"; // the mock's Welcome (?mock=welcome)
const DIST = join(process.cwd(), "../../packages/runtime/dist");

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});
test.beforeAll(() => {
  expect(existsSync(join(DIST, "runtime.manifest.json"))).toBe(true);
});

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

test.beforeEach(async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serveFrame(page, baseURL ?? "");
});

test("first open lands on Welcome, nothing ticked", async ({ page }) => {
  await page.goto("/?mock=welcome");
  await page.waitForURL(`**/a/${ID}**`);
  const frame = page.frameLocator("iframe.oa-vframe");
  await expect(frame.getByRole("heading", { name: "Welcome" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(frame.getByText("Publish your first artifact")).toBeVisible();
  await expect(frame.locator('[data-step][data-done="true"]')).toHaveCount(0);
  await frame.getByRole("tab", { name: "Claude Code" }).click();
  await expect(frame.getByText(/claude mcp add/)).toBeVisible();
});

test("the shell lets the page tick: one, then all five", async ({ page }) => {
  await page.goto(`/a/${ID}?mock=welcome&opened=1&ticks=connect`);
  const frame = page.frameLocator("iframe.oa-vframe");
  await expect(frame.getByText("Agent connected")).toBeVisible({
    timeout: 15_000,
  });
  await expect(frame.locator('[data-step][data-done="true"]')).toHaveCount(1);

  await page.goto(
    `/a/${ID}?mock=welcome&opened=1&ticks=connect,name,publish,mention,ask`,
  );
  await expect(frame.getByText("Answered")).toBeVisible({ timeout: 15_000 });
  const link = frame.getByRole("link", { name: "Landing page" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(frame.getByText(/You're set/)).toBeVisible();
});

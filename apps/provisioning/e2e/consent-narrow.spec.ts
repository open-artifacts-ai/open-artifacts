import { type Browser, chromium, expect, test } from "@playwright/test";
import { type Harness, startWorker } from "./worker.js";

// W13b review: on a phone the header drops the admin host, never the
// PRODUCTION badge, so prod consent keeps its environment cue.

let w: Harness;
let browser: Browser;

test.beforeAll(async () => {
  w = await startWorker({ env: "prod" });
  browser = await chromium.launch({
    args: [`--host-resolver-rules=${w.hostResolverRules}`],
  });
});
test.afterAll(async () => {
  await browser?.close();
  await w?.close();
});

test("prod consent at 390x844 shows the Production badge and hides the host", async () => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  await context.addCookies([
    {
      name: "__Host-oa-admin",
      value: w.sid,
      domain: "admin.localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${w.admin}${w.authorizePath}`);
  await expect(page.getByRole("heading")).toHaveText(
    "Connect this agent to the production admin?",
  );
  const badge = page.locator("header .env");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("Production");
  await expect(page.locator("header span.mono")).toBeHidden();
  await context.close();
});

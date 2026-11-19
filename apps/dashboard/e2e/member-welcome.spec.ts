// #2632 (member onboarding, slice 1): a member's first login lands on their
// own Welcome. The 3 and 5 of 5 states, the Library card and the guest note
// live in test/member-onboarding.test.tsx and test/welcome-page.test.tsx. Needs
// `pnpm --filter @oa/runtime build` first (the frame's runtime).
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
  await page.setViewportSize({ width: 1280, height: 900 });
  await serveFrame(page, baseURL ?? "");
});
const frame = (page: Page) => page.frameLocator("iframe.oa-vframe");
const done = (page: Page) =>
  frame(page).locator('.steps:not(.also .steps) [data-step][data-done="true"]');

test("a member's first login lands on their own Welcome: 0 of 5, the sixth step", async ({
  page,
}) => {
  await page.goto("/?mock=welcome&role=member");
  await page.waitForURL(`**/a/${ID}**`);
  const f = frame(page);
  await expect(f.getByRole("heading", { name: "Welcome, Ada" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    f.getByText(
      "Bob Builder added you to Acme Artifacts. Five steps and your agent is working here with you.",
    ),
  ).toBeVisible();
  await expect(
    f.getByText("Also try: comment on a teammate's page"),
  ).toBeVisible();
  await expect(done(page)).toHaveCount(0);
  await expect(f.getByText("0 of 5 done")).toBeVisible();
  // The line to paste and Copy are inside step 1 (Design).
  const one = f.locator('[data-step="connect"]');
  await expect(
    one.getByText("Set up Open Artifacts for me: follow", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(one.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(
    f.getByRole("heading", { name: "Connect your agent" }),
  ).toBeHidden();
});

// #2632 (member onboarding, slice 1): a member's own Welcome (0, 3 and 5 of
// 5, and the optional sixth step), their Library card with Hide, and the
// note a guest sees where a member would publish. At 1280 and 390, light and
// dark, with axe. Needs `pnpm --filter @oa/runtime build` first (the frame's
// runtime). PNGs to SHOTS_DIR when set.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { welcomePage as welcomeHtml } from "@oa/shared";
import { expect, type Page, test } from "@playwright/test";

const ID = "WmCnEfGhJk4mNpQr"; // the mock's Welcome (?mock=welcome)
const DIST = join(process.cwd(), "../../packages/runtime/dist");
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const ALL = "connect,name,publish,mention,ask";

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
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const shot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await settle(page);
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
  });
};
async function axe(page: Page) {
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map((x: { id: string }) => x.id);
  });
  expect(v).toEqual([]);
}

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width, height: width === 390 ? 844 : 900 },
      });
      test.beforeEach(async ({ page, baseURL }) => {
        await serveFrame(page, baseURL ?? "");
      });
      const frame = (page: Page) => page.frameLocator("iframe.oa-vframe");
      const done = (page: Page) =>
        frame(page).locator(
          '.steps:not(.also .steps) [data-step][data-done="true"]',
        );

      test("a member's first login lands on their own Welcome: 0 of 5, the sixth step", async ({
        page,
      }, info) => {
        await page.goto("/?mock=welcome&role=member");
        await page.waitForURL(`**/a/${ID}**`);
        const f = frame(page);
        await expect(
          f.getByRole("heading", { name: "Welcome, Ada" }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          f.getByText(
            "Bob Builder added you to Acme Artifacts. Five steps and your agent is working here with you.",
          ),
        ).toBeVisible();
        await expect(
          f.getByText("Also try: comment on a teammate's page"),
        ).toBeVisible();
        await expect(done(page)).toHaveCount(0);
        await shot(page, info, `member-welcome-0-${scheme}-${width}.png`);
        await axe(page);
      });

      test("3 of 5", async ({ page }, info) => {
        await page.goto(
          `/a/${ID}?mock=welcome&role=member&opened=1&ticks=connect,name,publish`,
        );
        await expect(done(page)).toHaveCount(3, { timeout: 15_000 });
        await shot(page, info, `member-welcome-3-${scheme}-${width}.png`);
      });

      test("5 of 5: You're set., the sixth step still open and not counted", async ({
        page,
      }, info) => {
        await page.goto(
          `/a/${ID}?mock=welcome&role=member&opened=1&ticks=${ALL}`,
        );
        const f = frame(page);
        await expect(f.getByText("You're set.", { exact: true })).toBeVisible({
          timeout: 15_000,
        });
        await expect(
          f.getByText(
            "Your agent hears your comments and answers them. Next: see what Acme Artifacts is working on.",
          ),
        ).toBeVisible();
        await expect(
          f.locator('[data-step="teammate"][data-done="false"]'),
        ).toHaveCount(1);
        await f.locator("#member-done").scrollIntoViewIfNeeded();
        await shot(page, info, `member-welcome-5-${scheme}-${width}.png`);
      });

      test("the sixth step done", async ({ page }, info) => {
        await page.goto(
          `/a/${ID}?mock=welcome&role=member&opened=1&ticks=${ALL}&teammate=1`,
        );
        await expect(
          frame(page).locator('[data-step="teammate"][data-done="true"]'),
        ).toHaveCount(1, { timeout: 15_000 });
        await frame(page)
          .locator('[data-step="teammate"]')
          .scrollIntoViewIfNeeded();
        await shot(page, info, `member-welcome-sixth-${scheme}-${width}.png`);
      });

      test("the Library card: the five steps and Hide (hidden isn't done)", async ({
        page,
      }, info) => {
        await page.goto("/?mock=welcome&role=member&opened=1&ticks=connect");
        const card = page.locator("section[data-member]");
        await expect(card).toBeVisible();
        await expect(card).toContainText("1 of 5");
        await expect(
          card.getByText("Paste the line below into your agent."),
        ).toHaveCount(0);
        await expect(
          card.getByText(
            "Your agent will suggest a name. It's what you'll type after @ in comments.",
          ),
        ).toBeVisible();
        await shot(page, info, `member-card-${scheme}-${width}.png`);
        await axe(page);
        const put = page.waitForRequest(
          (r) => r.method() === "PUT" && r.url().endsWith("/api/v1/onboarding"),
        );
        await card.getByRole("button", { name: "Hide" }).click();
        expect((await put).postDataJSON()).toEqual({ dismissed: true });
      });

      test("a guest: no steps, and the note where a member would publish", async ({
        page,
      }, info) => {
        await page.goto("/?role=guest");
        await expect(
          page.getByText(
            "Guests can read and comment. To publish, ask Bob Builder to make you a member.",
          ),
        ).toBeVisible();
        await expect(page.locator("section[data-member]")).toHaveCount(0);
        await shot(page, info, `member-guest-note-${scheme}-${width}.png`);
        await axe(page);
      });
    });

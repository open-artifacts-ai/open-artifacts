// #2287: Welcome (the page the server seeds) in the viewer with the real built
// runtime, the first open, the ticks, and the Solo trial chip. Run
// `pnpm --filter @oa/runtime build` first. Shots only when WELCOME_SHOTS_DIR is set.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { welcomePage as welcomeHtml } from "@oa/shared";
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
        await frame
          .getByText("You can delete this page any time")
          .scrollIntoViewIfNeeded();
        await shot(page, "1c-bottom", w, theme);
        await frame.getByRole("tab", { name: "Claude Code" }).click();
        await expect(frame.getByText(/claude mcp add/)).toBeVisible();
        await shot(page, "1b-claude-tab", w, theme);
      });

      test("the shell lets the page tick: one, then all five", async ({
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
          `/a/${ID}?mock=welcome&opened=1&ticks=connect,name,publish,mention,ask`,
        );
        await expect(frame.getByText("Answered")).toBeVisible({
          timeout: 15_000,
        });
        const link = frame.getByRole("link", { name: "Landing page" });
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(frame.getByText(/You're set/)).toBeVisible();
        await shot(page, "3-all-ticked", w, theme);
        await frame
          .getByText("You can delete this page any time")
          .scrollIntoViewIfNeeded();
        await shot(page, "3b-all-ticked-bottom", w, theme);
      });

      // #2478: the five-step checklist on the page and on the Library card.
      const STATES = [
        { name: "0-of-5", ticks: "", done: 0 },
        { name: "2-of-5", ticks: "connect,name", done: 2 },
        {
          name: "step4-stalled",
          ticks: "connect,name,publish,stalled",
          done: 3,
        },
        {
          name: "5-of-5",
          ticks: "connect,name,publish,mention,ask",
          done: 5,
        },
      ];
      for (const st of STATES) {
        test(`five steps on the page: ${st.name}`, async ({ page }) => {
          await page.goto(`/a/${ID}?mock=welcome&opened=1&ticks=${st.ticks}`);
          const frame = page.frameLocator("iframe.oa-vframe");
          await expect(
            frame.getByText("Name your agent").or(frame.getByText(/^Named: /)),
          ).toBeVisible({
            timeout: 15_000,
          });
          await expect(
            frame.locator('[data-step][data-done="true"]'),
          ).toHaveCount(st.done);
          await expect(frame.locator("[data-step]")).toHaveCount(5);
          await expect(frame.getByText("Leave a comment")).toHaveCount(0);
          if (st.name === "step4-stalled") {
            await expect(
              frame.getByText(
                'No reply yet. Your agent may not be listening. Ask it: "Check the bus."',
              ),
            ).toBeVisible();
            await expect(frame.getByText("Named: Atlas")).toBeVisible();
          } else {
            await expect(frame.getByText(/No reply yet/)).toBeHidden();
          }
          if (st.name === "5-of-5") {
            await expect(frame.getByText("Atlas replied")).toBeVisible();
            await expect(
              frame.getByText(
                "You're set. Your agent hears your comments and answers them.",
              ),
            ).toBeVisible();
          }
          // The checklist and its lines sit below the connect panel.
          await frame
            .getByText("You can delete this page any time")
            .scrollIntoViewIfNeeded();
          await shot(page, `6-welcome-${st.name}`, w, theme);
        });
        test(`five steps on the Library card: ${st.name}`, async ({ page }) => {
          await page.goto(`/?mock=welcome&opened=1&ticks=${st.ticks}`);
          const card = page.getByRole("region", { name: "Get started" });
          if (st.name === "5-of-5") {
            // Five done and only the optional invite left: the card stays.
            await expect(card).toContainText("5 of 5");
          } else {
            await expect(card).toContainText(`${st.done} of 5`);
          }
          await expect(card).toContainText("Invite your team");
          await expect(card).toContainText("(optional)");
          if (st.name === "step4-stalled")
            await expect(card).toContainText("No reply yet.");
          await shot(page, `7-library-${st.name}`, w, theme);
        });
      }

      test("Library shows Welcome as a normal row", async ({ page }) => {
        await page.goto("/?mock=welcome&opened=1");
        await expect(page.getByRole("link", { name: "Welcome" })).toBeVisible();
        await shot(page, "5-library", w, theme);
      });

      test("the Solo trial chip opens its note", async ({ page }) => {
        await page.goto("/?hosted=solo");
        const chip = page.getByTestId("plan-chip");
        await expect(chip).toContainText(/Solo trial · \d+ days left/);
        await chip.click();
        await expect(page.getByText(/No card needed/)).toBeVisible();
        await shot(page, "4-plan-chip", w, theme);
      });
    });

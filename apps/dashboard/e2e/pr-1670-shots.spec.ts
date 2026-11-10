// Shots for contributor PR #1670 ("Connect agents" nav entry, "Agent
// messaging"). Runs on main (before) and with the PR's diff (after).
import { type Page, test } from "@playwright/test";

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const emptyBus = (page: Page) =>
  page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input),
        location.href,
      );
      if (url.pathname === "/api/v1/bus/agents")
        return Response.json({ agents: [], live: true });
      if (url.pathname === "/api/v1/bus/machines")
        return Response.json({ machines: [] });
      return fetch.call(this, input, init);
    };
  });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = async (page: Page, out: string) => {
        await page.evaluate((v) => {
          document.documentElement.dataset.theme = v;
        }, scheme);
        await page.waitForLoadState("networkidle");
        await settle(page);
        await page.screenshot({ path: out });
      };
      const openNav = async (page: Page) => {
        if (width === 390)
          await page.getByRole("button", { name: "Toggle navigation" }).click();
      };

      test("sidebar", async ({ page }, info) => {
        await emptyBus(page);
        await page.goto("/?mock=bus");
        await openNav(page);
        await page.getByRole("navigation", { name: "Primary" }).waitFor();
        await shot(page, info.outputPath(`sidebar-${scheme}-${width}.png`));
      });

      test("connections", async ({ page }, info) => {
        await emptyBus(page);
        await page.goto("/settings/connections?mock=bus");
        await page.getByLabel("Setup prompt", { exact: true }).waitFor();
        await shot(page, info.outputPath(`connections-${scheme}-${width}.png`));
      });

      test("agents empty", async ({ page }, info) => {
        await emptyBus(page);
        await page.goto("/agents?mock=bus");
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await shot(page, info.outputPath(`agents-${scheme}-${width}.png`));
      });
    });

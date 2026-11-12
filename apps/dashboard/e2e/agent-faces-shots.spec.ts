// #1822: the comments panel (mock=agents) with a person, a linked agent
// ("OA Product", fox) and an unlinked agent ("Claude Code", outline), at 1280 and 390, light and dark.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
// An author's face is the one beside the name row with the "agent" tag; the
// mention chips and ask lines carry tiles too (mention-faces-shots covers those).
const author = (page: Page, linked: "true" | "false") =>
  page
    .locator(
      `[data-avatar][data-linked="${linked}"]:has(+ div [data-agent-tag])`,
    )
    .first();
const OUT = process.env.FACES_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`agent faces at ${width}px ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}?mock=agents`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      await page
        .getByRole("button", { name: /^Show \d+ earlier repl/ })
        .first()
        .click();
      await expect(author(page, "true")).toBeVisible();
      await expect(author(page, "false")).toBeVisible();
      const body = await page.screenshot();
      await info.attach(`faces-${width}-${theme}`, {
        body,
        contentType: "image/png",
      });
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: `${OUT}/faces-${width}-${theme}.png` });
      }
    });

// #2118 part 1: the comments column (thread quote, hanging face, composer card,
// heading, tint). Shots only when COLUMN_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.COLUMN_SHOTS_DIR;

async function open(page: Page, w: number, theme: string, id = ID) {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
  await page.goto(`/a/${id}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Comment on the whole page" }),
  ).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"]) {
    test(`${w} ${theme}: column, composer, quote`, async ({ page }) => {
      await open(page, w, theme);
      await shot(page, `${w}-${theme}-column`);
      if (OUT && w === 390)
        await page
          .locator("[data-thread]")
          .first()
          .screenshot({ path: `${OUT}/390-${theme}-thread.png` });
      const note = page.getByRole("textbox", {
        name: "Comment on the whole page",
      });
      await note.fill("Looks good to me");
      await shot(page, `${w}-${theme}-composer`);
      await note.fill("");
      // The frame's runtime says "comment.select" for a selection: replay it
      // from the frame with the nonce in its src.
      const src = await page.locator("iframe").first().getAttribute("src");
      const nonce = new URLSearchParams((src ?? "").split("#")[1] ?? "").get(
        "oa",
      );
      const frame = page.frames().find((f) => f !== page.mainFrame());
      await frame?.evaluate((n) => {
        parent.postMessage(
          {
            oa: 1,
            nonce: n,
            type: "comment.select",
            anchor: {
              kind: "text",
              exact:
                "Chat is great for asking, and bad for keeping. Your agents put their work in an artifact.",
              prefix: "",
              suffix: "",
            },
          },
          "*",
        );
      }, nonce);
      const box = page.getByRole("textbox", { name: "Add a comment" });
      await box.fill("Punchier please");
      await shot(page, `${w}-${theme}-quote-composer`);
    });
  }
}

// No comments: the heading shows no count.
for (const w of [1280, 390]) {
  test(`${w} light: no count at 0`, async ({ page }) => {
    await open(page, w, "light", "De6gHjKmNp7qRsTu"); // Notes: no threads
    await expect(
      page.getByRole("textbox", { name: "Comment on the whole page" }),
    ).toBeVisible();
    await expect(page.getByText(/^\d+ open$/)).toHaveCount(0);
    await shot(page, `${w}-light-zero`);
  });
}

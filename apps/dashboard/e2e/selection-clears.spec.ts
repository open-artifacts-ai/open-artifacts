// Clicking away or closing the list clears an unsent selection (Google Docs).
// The mock frame has no runtime, so its messages are replayed with the nonce.
// Shots only when SEL_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const OUT = process.env.SEL_SHOTS_DIR;
const ARTIFACTS = [
  { kind: "html", id: "Cd5fGhJkLm6nPqRs" },
  { kind: "markdown", id: "De6gHjKmNp7qRsTu" },
];
const QUOTE = "a quote the reader selected";

async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** What the frame's runtime sends. */
async function fromFrame(page: Page, type: string, extra: object = {}) {
  const src = await page.locator("iframe").first().getAttribute("src");
  const nonce = new URLSearchParams((src ?? "").split("#")[1] ?? "").get("oa");
  const frame = page.frames().find((f) => f !== page.mainFrame());
  await frame?.evaluate(
    ([n, t, x]) =>
      parent.postMessage({ oa: 1, nonce: n, type: t, ...(x as object) }, "*"),
    [nonce, type, extra] as const,
  );
}
const select = (page: Page) =>
  fromFrame(page, "comment.select", {
    anchor: { kind: "text", exact: QUOTE, prefix: "", suffix: "" },
  });
const card = (page: Page) => page.getByText(QUOTE);
const box = (page: Page) =>
  page.getByRole("textbox", { name: "Add a comment" });
/** A reader click in the shell, outside the list and the frame. */
const clickShell = (page: Page) =>
  page.evaluate(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    ),
  );

for (const w of [1280, 390]) {
  for (const { kind, id } of ARTIFACTS) {
    test.describe(`${kind} at ${w}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
        await page.goto(`/a/${id}?mock=agents`);
        await expect(page.locator("iframe").first()).toBeVisible();
        await page.waitForTimeout(500);
        await select(page);
        await expect(box(page)).toBeVisible();
        await expect(card(page)).toBeVisible();
        await shot(page, `${kind}-${w}-1-selected`);
      });

      test("a click in the frame drops the empty draft", async ({ page }) => {
        await fromFrame(page, "comment.away");
        await expect(card(page)).toHaveCount(0);
        await shot(page, `${kind}-${w}-2-after-frame-click`);
      });

      test("a click in the shell drops the empty draft", async ({ page }) => {
        await clickShell(page);
        await expect(card(page)).toHaveCount(0);
        await shot(page, `${kind}-${w}-3-after-shell-click`);
      });

      test("closing the list drops the empty draft", async ({ page }) => {
        if (w < 600) await page.keyboard.press("Escape");
        else await page.getByRole("button", { name: /^Comments/ }).click();
        await expect(card(page)).toHaveCount(0);
        await shot(page, `${kind}-${w}-4-after-close`);
      });

      test("a typed draft survives a click away", async ({ page }) => {
        await box(page).fill("half a thought");
        await fromFrame(page, "comment.away");
        await clickShell(page);
        await expect(card(page)).toBeVisible();
        await expect(box(page)).toHaveValue("half a thought");
        await shot(page, `${kind}-${w}-5-typed-kept`);
      });

      test("a click inside the card keeps the draft", async ({ page }) => {
        await box(page).click();
        await card(page).click();
        await expect(card(page)).toBeVisible();
        await expect(box(page)).toBeVisible();
      });
    });
  }
}

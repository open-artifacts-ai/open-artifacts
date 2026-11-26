// Clicking away or closing the list clears an unsent selection (Google Docs).
// The mock frame has no runtime, so its messages are replayed with the nonce.
// Shots only when SEL_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const OUT = process.env.SEL_SHOTS_DIR;
// One artifact, one size: the rest of the unsent-selection rules (shell click,
// closing the list, reopening, a new selection, a click in the card) are in
// test/comments.test.tsx › "clicking away from an unsent selection".
const ARTIFACTS = [{ kind: "html", id: "Cd5fGhJkLm6nPqRs" }];
const QUOTE = "a quote the reader selected";

async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    animations: "disabled",
  });
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

for (const w of [1280]) {
  for (const { kind, id } of ARTIFACTS) {
    test.describe(`${kind} at ${w}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
        await page.goto(`/a/${id}?mock=agents`);
        const iframe = page.locator("iframe").first();
        await expect(iframe).toBeVisible();
        await expect(iframe).toHaveAttribute("src", /#oa=/);
        await expect
          .poll(() => page.frames().some((f) => f !== page.mainFrame()))
          .toBe(true);
        await expect(async () => {
          await select(page);
          await expect(box(page)).toBeVisible({ timeout: 200 });
        }).toPass();
        await expect(card(page)).toBeVisible();
        await shot(page, `${kind}-${w}-1-selected`);
      });

      test("a click in the frame drops the empty draft", async ({ page }) => {
        await fromFrame(page, "comment.away");
        await expect(card(page)).toHaveCount(0);
        await shot(page, `${kind}-${w}-2-after-frame-click`);
      });

      test("a typed draft survives a click away", async ({ page }) => {
        await box(page).fill("half a thought");
        await fromFrame(page, "comment.away");
        await clickShell(page);
        await expect(card(page)).toBeVisible();
        await expect(box(page)).toHaveValue("half a thought");
        await shot(page, `${kind}-${w}-5-typed-kept`);
      });
    });
  }
}

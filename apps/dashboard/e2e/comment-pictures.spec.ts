// #2508 slice A2: pictures in the comments drawer (mocks in src/mockPictures.ts).
// Two happy paths at 1280 light; the limits, errors, HEIC, alt text, removal
// and guests are vitest cases in test/comment-pictures.test.tsx (#2711).
import { expect, type Locator, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
/** A real PNG drawn in the page (a screenshot stand-in). */
async function png(page: Page, hue: number, w = 1600, h = 1000) {
  const b64 = await page.evaluate(
    ([hue, w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.fillStyle = `hsl(${hue} 60% 80%)`;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#fff";
      g.fillRect(w * 0.08, h * 0.12, w * 0.5, h * 0.1);
      g.fillRect(w * 0.08, h * 0.32, w * 0.84, h * 0.5);
      return c.toDataURL("image/png").split(",")[1] ?? "";
    },
    [hue, w, h] as const,
  );
  return Buffer.from(b64, "base64");
}
const file = async (page: Page, hue: number, name = `shot-${hue}.png`) => ({
  name,
  mimeType: "image/png",
  buffer: await png(page, hue),
});

async function open(page: Page, query = "mock=agents") {
  await page.goto(`/a/${ID}?${query}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const box = page.getByRole("textbox", { name: "Comment on the whole page" });
  await expect(box).toBeVisible();
  return box;
}
/** The note box's card: the field, thumbnails, notes and its own picture input. */
const cardOf = (box: Locator) =>
  box.locator("xpath=ancestor::div[.//input[@data-attach-input]][1]");

test.use({ colorScheme: "light", viewport: { width: 1280, height: 800 } });

test("posted: the comment shows its picture", async ({ page }) => {
  const box = await open(page);
  const card = cardOf(box);
  await box.fill("The button on the split one sits too low.");
  await card
    .locator("[data-attach-input]")
    .setInputFiles([await file(page, 220)]);
  await expect(card.locator('[data-attached-picture="done"]')).toHaveCount(1);
  const post = page.waitForRequest(
    (r) =>
      r.method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/artifacts/${ID}/comments`,
  );
  await card.getByRole("button", { name: "Comment", exact: true }).click();
  expect((await post).postDataJSON()).toMatchObject({
    body: "The button on the split one sits too low.",
    pictures: [{ pictureId: expect.any(String) }],
  });
  const thread = page.locator("[data-thread]", {
    hasText: "The button on the split one",
  });
  // Thumbnails load lazily: bring it on screen.
  await thread.locator("[data-picture]").first().scrollIntoViewIfNeeded();
  const posted = thread.locator('[data-picture="ok"]');
  await expect(posted).toHaveCount(1);
  await expect(card.locator("[data-attached-picture]")).toHaveCount(0);
  await posted.scrollIntoViewIfNeeded();
});

test("the full-size view: Open original, arrows, Esc", async ({ page }) => {
  await open(page, "mock=pictures");
  const pics = page.locator("[data-comment-pictures]").first();
  await expect(pics.locator('[data-picture="ok"]')).toHaveCount(2);
  await pics.locator('[data-picture="ok"]').first().click();
  const lb = page.locator("[data-lightbox]");
  await expect(lb).toBeVisible();
  await expect(lb.getByText(/1 of 2/)).toBeVisible();
  await expect(
    lb.getByText("Before: the comments view at 760px.").last(),
  ).toBeVisible();
  const original = lb.getByRole("link", { name: "Open original" });
  await expect(original).toHaveAttribute("target", "_blank");
  await page.keyboard.press("ArrowRight");
  await expect(lb.getByText(/2 of 2/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(lb).toHaveCount(0);
  // Esc closes the picture only: the comments stay open.
  await expect(
    page
      .getByRole("complementary", { name: "Comments" })
      .or(page.getByRole("dialog", { name: "Comments" })),
  ).toBeVisible();
});

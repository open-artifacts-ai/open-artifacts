// #2179: a reply that arrives while the page is open shows at once in its
// folded thread, tinted for a moment, without a click and without moving the
// document or the reader's place in the panel.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** Another person's reply, through the mock API (the page sees the socket event). */
const reply = (page: Page, body: string) =>
  page.evaluate(
    async ({ id, body }) => {
      const list = (await (
        await fetch(`/api/v1/artifacts/${id}/comments`)
      ).json()) as { threads: { id: string; status: string }[] };
      const t = list.threads.find((t) => t.status === "open");
      await fetch(`/api/v1/artifacts/${id}/comments/${t?.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
    { id: ID, body },
  );

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`${w}px: a live reply shows with no click`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Comment on the whole page" }),
    ).toBeVisible();
    await reply(page, "Arrived while you were reading");
    const row = page
      .locator("[data-comment]")
      .filter({ hasText: "Arrived while you were reading" });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-live", "");
    await expect(row).not.toHaveAttribute("data-live", "", { timeout: 6000 });
    await expect(row).toBeVisible();
    const doc = await page.evaluate(() => ({
      y: Math.round(scrollY),
      h: (document.scrollingElement as HTMLElement).scrollHeight,
      ih: innerHeight,
    }));
    expect(doc.y).toBe(0);
    expect(doc.h).toBe(doc.ih);
    // Scrolled to the bottom, the header is still in view.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("*")) {
        const o = getComputedStyle(el).overflowY;
        if (
          (o === "auto" || o === "scroll") &&
          el.scrollHeight > el.clientHeight
        )
          el.scrollTop = el.scrollHeight;
      }
    });
    const head = page.locator("[data-comments-header]");
    await expect(head).toBeInViewport();
    await expect(head).toContainText("Comments");
  });

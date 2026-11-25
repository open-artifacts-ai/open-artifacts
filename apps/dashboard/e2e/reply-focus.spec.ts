// #3042: clicking Reply on a thread taller than the panel puts the caret in the
// reply box and scrolls just enough to show it, never to the thread's top.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** A page note with enough long replies to outgrow the panel. */
async function longThread(page: Page, marker: string) {
  return page.evaluate(async (marker) => {
    const post = async (url: string, body: unknown) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "X-OA-Request": "1" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const t = (await post(
      `/api/v1/artifacts/${marker.split("|")[0]}/comments`,
      { anchor: { kind: "note" }, body: marker.split("|")[1] },
    )) as { id: string };
    for (let i = 0; i < 6; i += 1)
      await post(
        `/api/v1/artifacts/${marker.split("|")[0]}/comments/${t.id}/replies`,
        {
          body: `Reply ${i + 1}. ${"This is a long line of words in a reply. ".repeat(6)}`,
        },
      );
    return t.id;
  }, marker);
}

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`${w}px: Reply puts the caret in the reply box`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const marker = `Long thread ${w}`;
    // The mock broadcasts the post, so the list picks the thread up on its own.
    await longThread(page, `${ID}|${marker}`);
    const card = page.locator("[data-thread]").filter({ hasText: marker });
    const reply = card.getByRole("button", { name: "Reply" });
    await expect(reply).toBeVisible();

    await reply.click();
    // The card is taller than the panel, or this test would not catch the jump.
    expect((await card.boundingBox())?.height ?? 0).toBeGreaterThan(h * 0.8);
    const field = page.getByRole("textbox", { name: "Reply" });
    await expect(field).toBeFocused();
    // And it is in view, not below the panel's edge.
    await expect(field).toBeInViewport({ ratio: 1 });
    // The thread's top did not jump under the header.
    const top = await card.evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeLessThan(0);
  });

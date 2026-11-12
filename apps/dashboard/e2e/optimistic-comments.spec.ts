// A posted comment shows at once (with a slow server), stays one comment, and
// rolls back with its text on an error.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const SHOTS = process.env.OA_SHOTS_DIR;

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

/** Wrap fetch before the mock sees it: POSTs to comments wait `delay` ms, or fail with `fail`. */
const slowOrBroken = (page: Page, o: { delay?: number; fail?: number }) =>
  page.addInitScript((o) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (
        init?.method ??
        (input as Request).method ??
        "GET"
      ).toUpperCase();
      if (method === "POST" && /\/comments(\/[^/]+\/replies)?$/.test(url)) {
        await new Promise((r) => setTimeout(r, o.delay ?? 0));
        if (o.fail)
          return new Response(
            JSON.stringify({ error: { code: "rate_limited", message: "x" } }),
            { status: o.fail, headers: { "content-type": "application/json" } },
          );
      }
      return real(input, init);
    };
  }, o);

const open = async (page: Page, w: number, h: number) => {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  return page.getByRole("textbox", { name: "Comment on the whole page" });
};

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`${w}px ${scheme}: slow server, the comment shows at once and stays one`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await slowOrBroken(page, { delay: 1500 });
      const box = await open(page, w, h);
      await box.fill("Posted with a slow server");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const row = page
        .locator("[data-comment]")
        .filter({ hasText: "Posted with a slow server" });
      await expect(row).toBeVisible({ timeout: 500 });
      await expect(row).toHaveAttribute("data-sending", "");
      await expect(box).toHaveValue("");
      await row.scrollIntoViewIfNeeded();
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/sending-${w}-${scheme}.png`,
        });
      await expect(row).not.toHaveAttribute("data-sending", "", {
        timeout: 5000,
      });
      await page.waitForTimeout(800);
      await expect(
        page
          .locator("[data-comment]")
          .filter({ hasText: "Posted with a slow server" }),
      ).toHaveCount(1);
    });

test("an error rolls the comment back and the text returns", async ({
  page,
}) => {
  await slowOrBroken(page, { delay: 300, fail: 429 });
  const box = await open(page, 1280, 800);
  await box.fill("This will fail");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const row = page
    .locator("[data-comment]")
    .filter({ hasText: "This will fail" });
  await expect(row).toBeVisible({ timeout: 250 });
  await expect(
    page.getByText("Too many comments. Try again in a minute."),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(box).toHaveValue("This will fail");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/rollback-1280.png` });
});

/** Wrap fetch for the answer route: wait `delay` ms, then fail with 500, or answer `other` for real and say 409. */
const answerRoute = (
  page: Page,
  o: { delay: number; mode: "ok" | "fail" | "conflict"; other?: string },
) =>
  page.addInitScript((o) => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = (
        init?.method ??
        (typeof input === "string" ? "GET" : (input as Request).method)
      ).toUpperCase();
      if (method === "POST" && /\/answer$/.test(url)) {
        await new Promise((r) => setTimeout(r, o.delay));
        const json = { "content-type": "application/json" };
        if (o.mode === "fail")
          return new Response(
            JSON.stringify({ error: { code: "forbidden", message: "x" } }),
            { status: 403, headers: json },
          );
        if (o.mode === "conflict") {
          await real(input, {
            ...init,
            body: JSON.stringify({ optionId: o.other }),
          });
          return new Response(
            JSON.stringify({ error: { code: "conflict", message: "x" } }),
            { status: 409, headers: json },
          );
        }
      }
      return real(input, init);
    };
  }, o);

const openAsk = async (page: Page, w = 1280, h = 800) => {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`/a/${ID}?mock=asks`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const first = page
    .locator("[data-ask]")
    .filter({ hasText: "Which layout do we ship?" });
  await expect(first).toBeVisible();
  return first;
};

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const) {
  test(`${w}px: an ask pick shows as sending (not answered), then settles`, async ({
    page,
  }) => {
    await answerRoute(page, { delay: 1500, mode: "ok" });
    const ask = await openAsk(page, w, h);
    await ask.locator("[data-option]").first().click();
    await expect(ask.locator("[data-sending]")).toHaveCount(1, {
      timeout: 500,
    });
    await expect(ask.locator("[data-option]").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ask.locator("[data-option]").nth(1)).toBeDisabled();
    await expect(ask.getByText(/You picked/)).toHaveCount(0);
    // Still "needs you": the card's border and the header count stay until confirmed.
    await expect(ask).toHaveAttribute("data-needs-you", "");
    await expect(
      page.getByRole("button", { name: /^\d+ asks? for you/ }).first(),
    ).toBeVisible();
    await ask.scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ask-sending-${w}.png` });
    await expect(ask.getByText(/You picked/)).toHaveCount(1, { timeout: 5000 });
    await expect(ask.locator("[data-sending]")).toHaveCount(0);
  });

  test(`${w}px: a failed ask pick returns to the open card with the error`, async ({
    page,
  }) => {
    await answerRoute(page, { delay: 300, mode: "fail" });
    const ask = await openAsk(page, w, h);
    const opt = ask.locator("[data-option]").first();
    const id = await opt.getAttribute("data-option");
    await opt.click();
    await expect(page.getByRole("alert").first()).toContainText(
      "Only the people this ask is addressed to can answer.",
    );
    await expect(ask.getByText(/You picked/)).toHaveCount(0);
    await expect(ask.locator(`[data-option="${id}"]`)).toBeFocused();
    await expect(ask.locator(`[data-option="${id}"]`)).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/ask-failed-${w}.png` });
  });
}

test("a 409 settles to the answer the server has", async ({ page }) => {
  await answerRoute(page, { delay: 300, mode: "conflict", other: "wide" });
  const ask = await openAsk(page);
  await ask.locator('[data-option="compact"]').click();
  await expect(ask.getByText(/You picked A/)).toBeVisible();
  await expect(ask.getByText(/You picked B/)).toHaveCount(0);
});

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`${w}px: a reply that fails while its thread is not open shows a Restore line`, async ({
    page,
  }) => {
    await slowOrBroken(page, { delay: 900, fail: 429 });
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const cards = page.locator("[data-thread]");
    await expect(cards.first()).toBeVisible();
    const first = cards.first();
    const firstId = await first.getAttribute("data-thread");
    await first.getByRole("button", { name: "Reply" }).first().click();
    await page
      .locator(`[data-thread="${firstId}"]`)
      .getByRole("textbox", { name: "Reply" })
      .fill("Keep this reply");
    await page
      .locator(`[data-thread="${firstId}"]`)
      .getByRole("button", { name: "Reply", exact: true })
      .last()
      .click();
    // Open another thread before the error lands: the first one's box closes.
    await cards.nth(1).getByRole("button").first().click();
    const line = page
      .locator(`[data-thread="${firstId}"]`)
      .getByText(/Your reply wasn.t posted/);
    await expect(line).toBeVisible({ timeout: 4000 });
    await line.scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/restore-${w}.png` });
    await page
      .locator(`[data-thread="${firstId}"]`)
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(
      page
        .locator(`[data-thread="${firstId}"]`)
        .getByRole("textbox", { name: "Reply" }),
    ).toHaveValue("Keep this reply");
  });

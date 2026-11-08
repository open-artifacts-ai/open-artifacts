import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

// #1732: on touch, a selection in the frame shows the shell's "Comment on
// selection" bar; one tap opens the composer on that quote.
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<h1>Q3 plan</h1>
<p>Budget is flat. Hiring stays at two roles, both in platform.</p>
<p id="q">Risks: the vendor contract, and whether the launch moves to the second week of October.</p>
<p>Next steps are in the tracker, and owners sign off by Friday.</p>`;

const QUOTE = "the launch moves to the second week of October";
const shots = process.env.OA_SHOTS_DIR;

/** Selects QUOTE inside #q, as a long-press would. */
const select = (page: import("@playwright/test").Page) =>
  artifactFrame(page)
    .locator("#q")
    .evaluate((el, t) => {
      const n = el.firstChild as Text;
      const i = n.data.indexOf(t);
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    }, QUOTE);

for (const scheme of ["light", "dark"] as const)
  test.describe(`touch, ${scheme}`, () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      colorScheme: scheme,
    });

    test(`the bar follows the selection and one tap opens the composer (${scheme})`, async ({
      page,
      member,
    }, info) => {
      const { id } = await publishViaApi(member.pat, {
        title: `Selection ${uniq()}`,
        format: "html",
        content: PAGE,
      });
      await page.goto(`/a/${id}`);
      await expect(artifactFrame(page).locator("#q")).toBeVisible();
      const bar = page.locator("div.fixed > button", {
        hasText: "Comment on selection",
      });
      await expect(bar).toHaveCount(0);

      await select(page);
      await expect(bar).toBeVisible();
      // Below 600px the header button reads "Comment".
      await expect(
        page.getByRole("button", { name: "Comment", exact: true }),
      ).toBeVisible();
      if (shots)
        await page.screenshot({
          path: `${shots}/selected-390-${scheme}-${info.project.name}.png`,
        });

      // Clearing the selection hides the bar.
      await artifactFrame(page)
        .locator("body")
        .evaluate(() => getSelection()?.removeAllRanges());
      await expect(bar).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /^Comments/ }),
      ).toBeVisible();

      // Select again; one tap opens the composer on the quote.
      await select(page);
      await bar.tap();
      const sheet = page.getByRole("dialog", { name: "Comments" });
      await expect(sheet.getByText(QUOTE)).toBeVisible();
      await expect(
        sheet.getByRole("textbox", { name: "Add a comment" }),
      ).toBeVisible();
      await expect(bar).toHaveCount(0);
      if (shots)
        await page.screenshot({
          path: `${shots}/tapped-390-${scheme}-${info.project.name}.png`,
        });
    });
  });

test.describe("fine pointer", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("no bar; the header button switches", async ({ page, member }, info) => {
    const { id } = await publishViaApi(member.pat, {
      title: `Selection ${uniq()}`,
      format: "html",
      content: PAGE,
    });
    await page.goto(`/a/${id}`);
    await expect(artifactFrame(page).locator("#q")).toBeVisible();
    await select(page);
    // The header button is the only "Comment on selection" in the shell.
    await expect(
      page.getByRole("button", { name: "Comment on selection" }),
    ).toHaveCount(1);
    await expect(page.locator("div.fixed > button")).toHaveCount(0);
    if (shots)
      await page.screenshot({
        path: `${shots}/selected-1280-light-${info.project.name}.png`,
      });
  });
});

// #1836 and #1837 on the mock app: the invite dialog's trial notice, and the
// Plan page's comparison at phone width. OA_SHOTS_DIR, when set, also writes
// each state's PNG there (the reviewer's shots); the runs attach them anyway.
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const DIR = process.env.OA_SHOTS_DIR;
const WIDTHS = [1280, 390] as const;

const shoot = async (page: Page, name: string, info: TestInfo) => {
  const body = await page.screenshot({ fullPage: true });
  await info.attach(name, { body, contentType: "image/png" });
  if (DIR)
    await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
};
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);

for (const width of WIDTHS) {
  test(`plan comparison at ${width}px (solo)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/plan?hosted=solo");
    const compare = page.getByRole("region", { name: "Compare plans" });
    await expect(compare).toBeVisible();
    const stacked = page.getByTestId("compare-stacked");
    const table = page.getByRole("table");
    if (width === 390) {
      await expect(stacked).toBeVisible();
      await expect(table).toBeHidden();
      // Every price in full: nothing clips inside its box.
      for (const price of [
        "$1 a month or $12 a year, per instance",
        "$10 per creator",
        "$25 per creator",
      ]) {
        const el = stacked.getByText(price, { exact: true });
        await expect(el).toBeVisible();
        const clipped = await el.evaluate((n) => n.scrollWidth > n.clientWidth);
        expect(clipped, price).toBe(false);
        const box = await el.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      for (const plan of ["Solo", "Team", "Business"])
        await expect(
          stacked.getByRole("heading", { name: plan }),
        ).toBeVisible();
    } else {
      await expect(table).toBeVisible();
      await expect(stacked).toBeHidden();
    }
    await noSideScroll(page);
    await shoot(page, `plan-solo-${width}`, info);
  });
}

for (const width of WIDTHS)
  for (const [token, label] of [
    ["solo", "never-ran"],
    ["solo-used-trial", "trial-used"],
    ["plan-team", "team"],
  ] as const)
    test(`invite dialog at ${width}px (${label})`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings/members?hosted=${token}`);
      await page.getByRole("button", { name: "Add member" }).first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // The open animation is done: a shot mid-fade shows the page through it.
      await expect(dialog).toHaveCSS("opacity", "1");
      const start = dialog.getByRole("button", {
        name: "Add member and start trial",
      });
      const notice = dialog.getByText(
        "This starts your 14-day trial of Business.",
      );
      if (token === "solo") {
        await expect(notice).toBeVisible();
        await expect(
          dialog.getByText(/^Trial ends [A-Z][a-z]{2} \d+, \d{4}\.$/),
        ).toBeVisible();
        await expect(start).toBeVisible();
      } else {
        await expect(notice).toHaveCount(0);
        await expect(start).toHaveCount(0);
        await expect(
          dialog.getByRole("button", { name: "Add member" }),
        ).toBeVisible();
      }
      await noSideScroll(page);
      await shoot(page, `invite-${label}-${width}`, info);
    });

// Restore starts the trial too: its confirm carries the same notice.
for (const width of WIDTHS)
  for (const [token, label] of [
    ["solo,removed-people", "never-ran"],
    ["solo-used-trial,removed-people", "trial-used"],
  ] as const)
    test(`restore dialog at ${width}px (${label})`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/settings/members?hosted=${token}`);
      await page.getByRole("button", { name: /^Removed \(/ }).click();
      await page
        .getByRole("button", { name: /^Restore / })
        .first()
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveCSS("opacity", "1");
      const notice = dialog.getByText(
        "This starts your 14-day trial of Business.",
      );
      if (label === "never-ran") {
        await expect(notice).toBeVisible();
        await expect(dialog.getByText(/^Trial ends /)).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Restore and start trial" }),
        ).toBeVisible();
      } else {
        await expect(notice).toHaveCount(0);
        await expect(
          dialog.getByRole("button", { name: "Restore", exact: true }),
        ).toBeVisible();
      }
      await noSideScroll(page);
      await shoot(page, `restore-${label}-${width}`, info);
    });

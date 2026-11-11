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

for (const width of WIDTHS)
  for (const interval of ["Yearly", "Monthly"] as const)
    test(`plan cards and comparison at ${width}px, ${interval} (solo, #2007)`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/plan?hosted=solo");
      const compare = page.getByRole("region", { name: "Compare plans" });
      await expect(compare).toBeVisible();
      await compare.getByRole("button", { name: interval }).click();
      // Every card's price in full, inside the viewport.
      for (const c of ["solo", "team", "business"]) {
        const card = page.getByTestId(`plan-card-${c}`);
        await expect(card).toBeVisible();
        const box = await card.boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      }
      // Phone: the cards stack, one under the next.
      const solo = await page.getByTestId("plan-card-solo").boundingBox();
      const team = await page.getByTestId("plan-card-team").boundingBox();
      if (width === 390)
        expect(team?.y ?? 0).toBeGreaterThan(
          (solo?.y ?? 0) + (solo?.height ?? 0),
        );
      else expect(team?.y).toBe(solo?.y);
      await expect(page.getByRole("table")).toBeVisible();
      await noSideScroll(page);
      await shoot(page, `plan-solo-${width}-${interval.toLowerCase()}`, info);
    });

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
      const notice = dialog.getByText("This starts your 30-day Team trial.");
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
      const notice = dialog.getByText("This starts your 30-day Team trial.");
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

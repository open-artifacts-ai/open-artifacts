// The read-only banner per reason (owner and member), the Solo "Free month"
// pill and a refused invite, on the mock app at 1280 and 390px. OA_SHOTS_DIR,
// when set, also writes each state's PNG there.
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

/** The server's /me for a member of a locked instance: the plan cap. */
const asMember = (page: Page) =>
  page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const res = await real(...args);
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      if (!/\/api\/v1\/me(\?|$)/.test(url)) return res;
      const me = await res.clone().json();
      me.user.role = "member";
      me.auth = {
        method: "google",
        readOnly: true,
        cap: "plan",
        expiresAt: null,
      };
      return new Response(JSON.stringify(me), {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    };
  });

const REASONS = [
  ["lapsed", "plan-team-lapsed", "Manage billing", "/settings/plan"],
  [
    "payment_failed",
    "plan-team-payment-failed",
    "Manage billing",
    "/settings/plan",
  ],
  [
    "suspended",
    "plan-team-suspended",
    "Email support",
    "mailto:hello@open-artifacts.com",
  ],
  ["billing_unreachable", "plan-team-unreachable", null, null],
] as const;

for (const width of WIDTHS)
  for (const [reason, token, button, href] of REASONS)
    for (const who of ["owner", "member"] as const)
      test(`banner ${reason} as ${who} at ${width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 700 });
        if (who === "member") await asMember(page);
        await page.goto(`/?hosted=${token}`);
        const banner = page.getByTestId("plan-banner");
        await expect(banner).toBeVisible();
        const action = banner.getByRole("link");
        if (who === "owner" && button) {
          await expect(action).toHaveText(button);
          await expect(action).toHaveAttribute("href", href as string);
        } else {
          await expect(action).toHaveCount(0);
        }
        await expect(banner).not.toContainText("Spaces");
        await noSideScroll(page);
        await shoot(page, `banner-${reason}-${who}-${width}`, info);
      });

for (const width of WIDTHS) {
  test(`Solo free-month pill at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/plan?hosted=solo");
    const card = page.locator("#oa-main");
    await expect(card.getByText("Free month", { exact: true })).toBeVisible();
    await expect(card.getByText("Trial", { exact: true })).toHaveCount(0);
    await noSideScroll(page);
    await shoot(page, `plan-solo-free-month-${width}`, info);
  });

  test(`a refused invite names the invite at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/members?hosted=solo-used-trial");
    await page.getByRole("button", { name: "Add member" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email").fill("ana@example.com");
    await dialog.getByRole("button", { name: "Add member" }).click();
    await expect(
      dialog.getByText(
        "Inviting people is a team feature. Choose a plan to continue.",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: "Choose a plan" }),
    ).toHaveAttribute("href", "/settings/plan");
    await expect(dialog).not.toContainText("Spaces");
    await expect(dialog).toHaveCSS("opacity", "1");
    await noSideScroll(page);
    await shoot(page, `invite-refused-${width}`, info);
  });
}

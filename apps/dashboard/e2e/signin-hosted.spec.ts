// Hosted sign-in: the Google page with its guest link, and the guest code flow
// (typed and keyboard-only) through to the server's next.
import { expect, type Page, test } from "@playwright/test";

/** The hosted mocks' instance name (`/api/v1/me`). */
const NAME = "Acme Artifacts";
const GUEST = "Get a login code";

const signIn = async (
  page: Page,
  query: string,
  heading = `Log in to ${NAME}`,
) => {
  await page.goto(`/sign-in?${query}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: heading }).waitFor();
};

test("Google: one button, and a guest link", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "hosted=1");
  const google = page.getByRole("link", { name: "Continue with Google" });
  await expect(google).toHaveAttribute("href", "/auth/login/google?next=%2F");
  await expect(
    page.getByRole("link", { name: GUEST, exact: true }),
  ).toHaveAttribute("href", "/sign-in?method=code&next=%2F");
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("guest link to code page; a typed code opens the server's next", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "hosted=1&next=%2Fshared");
  await page.getByRole("link", { name: GUEST, exact: true }).click();
  await page.getByRole("heading", { name: GUEST }).waitFor();
  await page.getByRole("textbox", { name: "Email" }).fill("guest@outside.org");
  await page.getByRole("button", { name: "Send code" }).click();
  await page
    .getByRole("textbox", { name: "Code", exact: true })
    .fill("2468 1357");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/shared$/);
});

test("keyboard: log in with an emailed code, no mouse", {
  tag: "@smoke",
}, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/sign-in?hosted=1&method=code&next=%2Fshared");
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "Email" }).focus();
  await page.keyboard.type("guest@outside.org");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Code", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("24681357");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/shared$/);
});

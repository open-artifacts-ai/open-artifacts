import { R } from "@oa/shared";
import { A, api, expect, person, test } from "./fixtures";

// The hosted-only UI on rl-a (FEATURES spaces, usage_off, guests_read_only).

// Item 36: direct-mode installs show no hosting line until AuthProviders
// says which kind of install it is. Drop the marker when that lands.
const HOSTED_FLAG = "item 36: AuthProviders has no hosted flag yet";

test("Me reports rl-a's features", async ({ browser }) => {
  const admin = await person(browser, "admin", "admin");
  const me = (await (await api(admin, R.me)).json()) as {
    instance: { features: string[] };
  };
  expect([...me.instance.features].sort()).toEqual(
    ["guests_read_only", "spaces", "usage_off"].sort(),
  );
});

test("usage_off: no Usage in Settings, the page goes to Profile, and R.usage is 404", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const page = admin.page;
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Usage" })).toHaveCount(0);
  await page.goto("/settings/usage");
  await expect(page).toHaveURL(/\/settings\/profile$/);
  expect((await api(admin, R.usage)).status).toBe(404);
});

test("the sign-in page never calls rl-a self-hosted", async ({ page }) => {
  await page.goto(`${A.app}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Self-hosted on Cloudflare")).toHaveCount(0);
});

test("the sign-in page says it's hosted by Open Artifacts", async ({
  page,
}) => {
  test.fail(true, HOSTED_FLAG);
  await page.goto(`${A.app}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Counted once the page is up, not waited for: a timeout isn't an expected failure.
  expect(await page.getByText("Hosted by Open Artifacts").count()).toBe(1);
});

// Platform's TIER var: assert the tier copy once Me reports it.
test.fixme("the tier copy matches rl-a's tier", async () => {});

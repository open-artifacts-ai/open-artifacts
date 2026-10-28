import { R, TIER_FEATURES, TierSchema } from "@oa/shared";
import { A, api, expect, person, test } from "./fixtures";

// The hosted-only UI on rl-a: its tier and features, usage_off, the hosting
// line. M1 has no tier UI (no self-serve or billing), so the tier is an API check.

// The tier rl-a should be on (CI sets it once Platform has applied TIER).
// Unset: rl-a has no tier yet and today's FEATURES.
const TIER = process.env.T19_EXPECT_TIER
  ? TierSchema.parse(process.env.T19_EXPECT_TIER)
  : null;

test("Me reports rl-a's tier, and the features follow from it", async ({
  browser,
}) => {
  const admin = await person(browser, "admin", "admin");
  const me = (await (await api(admin, R.me)).json()) as {
    instance: { features: string[]; tier?: string | null };
  };
  expect(me.instance.tier ?? null).toBe(TIER);
  // Hosted adds usage_off on every tier; /me adds guests_read_only.
  const want = TIER
    ? [...TIER_FEATURES[TIER], "usage_off", "guests_read_only"]
    : ["guests_read_only", "spaces", "usage_off"];
  expect([...me.instance.features].sort()).toEqual([...want].sort());
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
  await page.goto(`${A.app}/sign-in`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Hosted by Open Artifacts")).toHaveCount(1);
});

// Settings tab strip order on a hosted instance.
import { expect, test } from "@playwright/test";

test("hosted: the Spaces tab sits after Members", async ({ page }) => {
  await page.goto("/settings/profile?hosted=1");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link", { name: "Spaces" })).toHaveAttribute(
    "href",
    "/settings/spaces",
  );
  await expect(nav.getByRole("link")).toHaveText([
    "Profile",
    "Notifications",
    "Security",
    "Members",
    "Spaces",
    "Directory",
    "Connections",
    "Instance",
    "Plan and billing",
  ]);
});

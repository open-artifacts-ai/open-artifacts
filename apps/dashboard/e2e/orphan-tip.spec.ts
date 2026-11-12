// #2156: on a phone (touch, 390) a tap opens the orphan tooltip and a tap outside closes it (?mock=orphan).
import { expect, test } from "@playwright/test";

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test("orphan tooltip: tap opens, outside tap closes", async ({
  page,
}, info) => {
  await page.goto(
    "/settings/spaces?hosted=plan-team&mock=orphan&space=SpEngNpQrSt2uVwX",
  );
  const card = page.getByRole("region", { name: "People" });
  const olive = card.getByRole("listitem").filter({ hasText: "Olive Gray" });
  const trigger = olive.getByRole("button", {
    name: "No longer in their group",
  });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await trigger.tap();
  await expect(page.getByRole("tooltip")).toContainText(
    "Their group no longer lists them",
  );
  // Still open a moment later (no close from the tap's own pointerleave/click).
  await page.waitForTimeout(400);
  await expect(page.getByRole("tooltip")).toContainText(
    "Their group no longer lists them",
  );
  await page.screenshot({ path: info.outputPath("orphan-tip-open-390.png") });
  // Outside tap: the People heading (no action).
  await card.getByRole("heading", { name: "People" }).tap();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // Re-tap opens again, a second tap on the trigger closes.
  await trigger.tap();
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await trigger.tap();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

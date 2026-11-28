// The phone navigation sheet: opens, navigates, closes and returns focus.
import { expect, test } from "@playwright/test";

test("phone: a 288px sheet that navigates, closes and returns focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Toggle navigation" });
  await trigger.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: "Trash" })).toBeVisible();
  // The sheet slides in with a transform: measure once it has landed at the
  // left edge, not mid-slide (sub-pixel widths, Platform's #755 shard 3).
  await expect.poll(async () => (await sheet.boundingBox())?.x).toBe(0);
  expect((await sheet.boundingBox())?.width).toBeCloseTo(288, 2);
  // The desktop's insets: brand 8px in and 48px tall, rows 16px in.
  const inset = await sheet.evaluate((d) => {
    const left = d.getBoundingClientRect().left;
    const head = d.querySelector("[data-slot=sidebar-header]");
    const brand = head?.querySelector("a")?.getBoundingClientRect();
    const row = d
      .querySelector("nav a[data-slot=sidebar-menu-button]")
      ?.getBoundingClientRect();
    return {
      brandX: (brand?.left ?? 0) - left,
      brandY: (brand?.top ?? 0) - d.getBoundingClientRect().top,
      brandRow: head?.getBoundingClientRect().height,
      rowX: (row?.left ?? 0) - left,
      markers: [...d.querySelectorAll("li")].some(
        (li) => getComputedStyle(li).listStyleType !== "none",
      ),
    };
  });
  expect(inset).toEqual({
    brandX: 8,
    brandY: 8,
    brandRow: 48,
    rowX: 16,
    markers: false,
  });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("dialog").getByRole("link", { name: "Trash" }).click();
  await expect(page).toHaveURL(/\/trash$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

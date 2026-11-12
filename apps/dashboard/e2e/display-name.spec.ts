import { expect, test } from "@playwright/test";

const TITLE = "What do you like to be called?";

test("display-name dialog: Save sends the trimmed name and closes", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Your name");
  await expect(field).toHaveValue("Ada Lovelace");
  await expect(field).toBeFocused();
  await field.fill("  Ada L.  ");
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({ displayName: "Ada L." });
  await expect(dialog).toBeHidden();
});

test("display-name dialog: Not now hides it for the rest of the session", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeFocused();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("display-name dialog: Escape dismisses, a backdrop click doesn't", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Settings → Profile saves the display name", async ({ page }) => {
  await page.goto("/settings/profile");
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByLabel("Email")).toHaveValue("ada@example.com");
  await page.getByLabel("Display name").fill(" Ada Lovelace ");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await save.click();
  expect((await patch).postDataJSON()).toEqual({
    displayName: "Ada Lovelace",
  });
  await expect(
    page.getByText("Display name saved", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
});

// #2277. PROFILE_SHOTS_DIR saves the PNGs.
test("Settings → Profile says when the name is hidden as an agent's", async ({
  page,
}) => {
  const hint = page.getByText(/Others see your email instead of this name/);
  await page.goto("/settings/profile?mock=agent-name");
  const field = page.getByLabel("Display name");
  await expect(field).toHaveValue("Ada's agent");
  await expect(hint).toBeVisible();
  await expect(field).toHaveAttribute(
    "aria-describedby",
    /oa-profile-name-hidden/,
  );
  const out = process.env.PROFILE_SHOTS_DIR;
  if (out)
    for (const [w, theme] of [
      [1280, "light"],
      [1280, "dark"],
      [390, "light"],
      [390, "dark"],
    ] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: 800 });
      // Settled: real value, enabled form, theme transitions done.
      await expect(field).toHaveValue("Ada's agent");
      await expect(field).toBeEnabled();
      await expect(hint).toBeVisible();
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      await page.screenshot({ path: `${out}/profile-hint-${w}-${theme}.png` });
    }
  await field.fill("Ada");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(hint).toHaveCount(0);
});

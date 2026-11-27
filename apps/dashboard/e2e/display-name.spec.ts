import { expect, test } from "@playwright/test";

const TITLE = "What do you like to be called?";

test("display-name dialog saves the trimmed name and suggested handle", async ({
  page,
}) => {
  await page.goto("/?mock=name");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Your name");
  await expect(field).toHaveValue("Ada Lovelace");
  await expect(field).toBeFocused();
  await field.fill("  Ada L.  ");
  await expect(dialog.getByLabel("Handle", { exact: true })).toHaveValue(
    "ada-l.",
  );
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({
    displayName: "Ada L.",
    handle: "ada-l.",
  });
  await expect(dialog).toBeHidden();
});

test("Settings → Profile saves the display name and chosen handle", async ({
  page,
}) => {
  await page.goto("/settings/profile");
  await expect(page.getByRole("link", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await expect(page.getByLabel("Email")).toHaveValue("ada@example.com");
  await page.getByLabel("Display name").fill(" Ada Lovelace ");
  const handle = page.getByLabel("Handle", { exact: true });
  await expect(handle).toHaveValue("ada-lovelace");
  await handle.fill("ada-l");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  const patch = page.waitForRequest(
    (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
  );
  await save.click();
  expect((await patch).postDataJSON()).toEqual({
    displayName: "Ada Lovelace",
    handle: "ada-l",
  });
  await expect(page.getByText("Handle saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
});

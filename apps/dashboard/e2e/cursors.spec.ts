import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"])
  test(`enabled controls show a pointer and remain actionable (${theme})`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(
      nav.getByRole("link", { name: "Library", exact: true }),
    ).toHaveCSS("cursor", "pointer");
    await expect(
      page.getByRole("searchbox", { name: "Search artifacts" }),
    ).toHaveCSS("cursor", "text");

    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle).toHaveCSS("cursor", "pointer");
    await toggle.click();
    await expect(
      page.locator("[data-side][data-state]").first(),
    ).toHaveAttribute("data-state", "collapsed");

    const upload = page.getByRole("button", {
      name: "Upload files",
      exact: true,
    });
    await expect(upload).toHaveCSS("cursor", "pointer");
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    expect((await chooser).isMultiple()).toBe(true);

    const mine = page.getByRole("tab", { name: "Mine", exact: true });
    await expect(mine).toHaveCSS("cursor", "pointer");
    await mine.click();
    await expect(page).toHaveURL(/\/mine$/);
    await expect(mine).toHaveAttribute("aria-selected", "true");

    const account = page.getByRole("button", { name: "Account menu" });
    await expect(account).toHaveCSS("cursor", "pointer");
    await account.click();
    const signOut = page.getByRole("menuitem", { name: "Sign out" });
    await expect(signOut).toBeVisible();
    await expect(signOut).toHaveCSS("cursor", "pointer");
    await page.keyboard.press("Escape");

    const agent = page.getByRole("combobox", { name: "Agent", exact: true });
    await expect(agent).toHaveCSS("cursor", "pointer");
    await agent.click();
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible();
    await expect(option).toHaveCSS("cursor", "pointer");
    await option.click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

test("disabled controls, text fields and explicit cursor overrides keep their affordances", async ({
  page,
}) => {
  await page.goto("/settings/profile");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await expect(save).not.toHaveCSS("cursor", "pointer");
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  await expect(name).toHaveCSS("cursor", "text");
  await name.fill("Cursor check");
  await expect(save).toBeEnabled();
  await expect(save).toHaveCSS("cursor", "pointer");
  await save.click();
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("Display name saved", { exact: true }),
  ).toBeVisible();

  // Preserve specialized utility and inline cursors, including when a control
  // has a non-native role. Plain text must not become a click target.
  await page.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.id = "cursor-exceptions";
    fixture.innerHTML = `
      <button class="cursor-text">Editable title</button>
      <button class="cursor-grab">Drag handle</button>
      <button style="cursor:ew-resize">Resize handle</button>
      <button style="cursor:wait">Working</button>
      <div role="button" aria-disabled="true">Unavailable action</div>
      <div role="menuitem" data-disabled>Unavailable menu item</div>
      <p>Selectable text</p>`;
    document.body.append(fixture);
  });
  await expect(page.getByRole("button", { name: "Editable title" })).toHaveCSS(
    "cursor",
    "text",
  );
  await expect(page.getByRole("button", { name: "Drag handle" })).toHaveCSS(
    "cursor",
    "grab",
  );
  await expect(page.getByRole("button", { name: "Resize handle" })).toHaveCSS(
    "cursor",
    "ew-resize",
  );
  await expect(page.getByRole("button", { name: "Working" })).toHaveCSS(
    "cursor",
    "wait",
  );
  await expect(
    page.getByRole("button", { name: "Unavailable action" }),
  ).not.toHaveCSS("cursor", "pointer");
  await expect(
    page.getByRole("menuitem", { name: "Unavailable menu item" }),
  ).not.toHaveCSS("cursor", "pointer");
  await expect(
    page.getByText("Selectable text", { exact: true }),
  ).not.toHaveCSS("cursor", "pointer");
});

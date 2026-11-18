// Settings > Connections: keyboard-only token create and revoke, and token secrecy after Done.
import { expect, test } from "@playwright/test";

test("keyboard: create and revoke a token without a mouse", async ({
  page,
}) => {
  await page.goto("/settings/connections");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Create token" }).focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "Create token" });
  await expect(dlg.getByRole("textbox", { name: "Label" })).toBeFocused();
  await page.keyboard.type("kbd");
  await page.keyboard.press("Enter");
  const made = page.getByRole("dialog", { name: "Token created" });
  await expect(made).toBeVisible();
  // Escape must not close it while the token is on screen.
  await page.keyboard.press("Escape");
  await expect(made).toBeVisible();
  await made.getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Enter");
  await expect(made).toBeHidden();
  // Focus returns to the trigger.
  await expect(
    page.getByRole("button", { name: "Create token" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Revoke kbd" }).focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("alertdialog", { name: 'Revoke "kbd"?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Revoke" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("kbd", { exact: true })).toHaveCount(0);
});

test("token secrecy: gone from DOM, storage, history and console after Done", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  await page.goto("/settings/connections");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Create token" }).click();
  await page.getByRole("textbox", { name: "Label" }).fill("secret");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  const made = page.getByRole("dialog", { name: "Token created" });
  const token = (await made.locator("code.oa-token").textContent()) ?? "";
  expect(token).toMatch(/^oa_pat_/);
  // Neither the save command nor any snippet carries it.
  for (const tab of await made.getByRole("tab").all()) {
    await tab.click();
    for (const pre of await made.locator("pre").all())
      await expect(pre).not.toContainText(token);
  }
  await made.getByRole("button", { name: "Done" }).click();
  await expect(made).toBeHidden();
  const where = await page.evaluate((t) => {
    const hits: string[] = [];
    if (document.documentElement.outerHTML.includes(t)) hits.push("dom");
    if (JSON.stringify({ ...localStorage }).includes(t))
      hits.push("localStorage");
    if (JSON.stringify({ ...sessionStorage }).includes(t))
      hits.push("sessionStorage");
    if (JSON.stringify(history.state ?? null).includes(t)) hits.push("history");
    if (location.href.includes(t)) hits.push("url");
    return hits;
  }, token);
  expect(where).toEqual([]);
  expect(
    logs.filter(
      (l) =>
        l.includes(token) &&
        !l.includes("[MSW]") &&
        !l.startsWith("Response {"),
    ),
  ).toEqual([]);
});

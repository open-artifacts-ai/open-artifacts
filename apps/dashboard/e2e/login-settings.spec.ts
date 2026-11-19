// #2520: Settings > Login, turning the domain join on, on the PROVISIONAL
// mocks (?mock=login, mockLogin.ts). The per-state pages, the other dialogs and
// the invite rows live in test/login-settings.test.tsx.
import { expect, test } from "@playwright/test";

test("turn on: the dialog, then the login comes back with it on", async ({
  page,
}) => {
  await page.goto("/settings/login?hosted=1&mock=login&login=owner-off");
  const sw = page.getByRole("switch", { name: "Anyone at your domain" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  const d = page.getByRole("alertdialog", {
    name: "Let anyone at acme.com join?",
  });
  await expect(d).toContainText("Anyone in this Google Workspace can join.");
  await d.getByRole("button", { name: "Log in again and turn on" }).click();
  await page.waitForURL(/reauthed=1/);
  // Back from the login: asked again, nothing sent until confirmed.
  await page
    .getByRole("alertdialog", { name: "Let anyone at acme.com join?" })
    .getByRole("button", { name: "Log in again and turn on" })
    .click();
  await expect(
    page.getByRole("switch", { name: "Anyone at your domain" }),
  ).toHaveAttribute("aria-checked", "true");
});

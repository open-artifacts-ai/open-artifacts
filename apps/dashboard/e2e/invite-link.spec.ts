// #167: with email off, adding a member or sharing shows the link to send;
// with it on (?mock=email, ?mock=email-fail) the copy says what was emailed.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const axeRun = async (page: Page): Promise<string[]> => {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; impact: string; nodes: { target: string[] }[] }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 4)
            .join(" | ")}`,
      );
  });
};

test("adding a member confirms with the sign-in link and copies it", async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings/members");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("doesn't send invitations");
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "new.person@example.com can now sign in",
    }),
  ).toBeVisible();
  const origin = new URL(baseURL ?? page.url()).origin;
  await expect(
    dialog.getByRole("textbox", { name: "Sign-in link" }),
  ).toHaveValue(origin);
  await expect(dialog).toContainText(`They'll sign in at ${origin}`);
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(dialog.getByRole("button", { name: /Copied/ })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    origin,
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("sharing confirms with the artifact link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Landing page" }).first().click();
  await page.waitForURL(/\/a\//);
  const viewer = page.url().split("?")[0] as string;
  await page.goto(`${viewer}?panel=open&tab=share`);
  await expect(
    page.getByText("No email is sent. Copy the link and share it yourself."),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Shared with eve@example.com")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Artifact link" }),
  ).toHaveValue(viewer);
});

test("email on: the invite is emailed, and the dialog says so", async ({
  page,
  baseURL,
}) => {
  await page.goto("/settings/members?mock=email");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "We'll email them a link to Acme Artifacts. They'll sign in with a one-time code.",
  );
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "Invitation sent to new.person@example.com",
    }),
  ).toBeVisible();
  const origin = new URL(baseURL ?? page.url()).origin;
  await expect(dialog).toContainText(
    `They can also sign in at ${origin} with a one-time code.`,
  );
  await expect(
    dialog.getByRole("textbox", { name: "Sign-in link" }),
  ).toHaveValue(origin);
});

test("email on but the send failed: the link to send, and why", async ({
  page,
}) => {
  await page.goto("/settings/members?mock=email-fail");
  await page.getByRole("button", { name: "Add member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill("new.person@example.com");
  await dialog.getByRole("button", { name: "Add member" }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "new.person@example.com can now sign in",
    }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    "The email didn't send. Copy the link and share it yourself.",
  );
});

test("email on: sharing says the link was emailed", async ({ page }) => {
  await page.goto("/a/Cd5fGhJkLm6nPqRs?mock=email&panel=open&tab=share");
  await expect(
    page.getByText(
      "We'll email them a link. You can also copy it and send it yourself.",
    ),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill("eve@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("Shared with eve@example.com")).toBeVisible();
  await expect(
    page.getByText(
      "We emailed them a link. They'll sign in with a one-time code.",
    ),
  ).toBeVisible();
});

// Hosted P4 Task 15 (D14 A): Members rows with the Restricted badge and the
// More menu keep the layout at 390 and 1280, light and dark.
for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`hosted members ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 860 } });

      test("badge, reason and the More menu", async ({ page }, info) => {
        await page.goto("/settings/members?hosted=1");
        await page.waitForLoadState("networkidle");
        const dan = page.locator("li", { hasText: "Dan Contractor" });
        await expect(
          dan
            .getByText("Restricted", { exact: true })
            .filter({ visible: true }),
        ).toHaveCount(1);
        // At <= 600px the badge and reason move to the control line.
        await expect(
          dan
            .getByText(
              width > 600
                ? "dan@example.com · via Contractors"
                : "via Contractors",
            )
            .filter({ visible: true }),
        ).toHaveCount(1);
        const over = await page.evaluate(
          () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
        );
        expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
        let v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await page.screenshot({
          path: info.outputPath(`members-restricted-${scheme}-${width}.png`),
          fullPage: true,
        });
        await dan
          .getByRole("button", { name: "More for Dan Contractor" })
          .click();
        const menu = page.getByRole("menu");
        await expect(
          menu.getByRole("menuitem", { name: /Restricted via Contractors/ }),
        ).toBeDisabled();
        await page.waitForFunction(() =>
          document.getAnimations().every((x) => x.playState !== "running"),
        );
        await page.screenshot({
          path: info.outputPath(`members-menu-${scheme}-${width}.png`),
          fullPage: true,
        });
        await menu
          .getByRole("menuitem", { name: "Restrict manually…" })
          .click();
        await expect(page.getByRole("alertdialog")).toContainText(
          "Restrict Dan Contractor?",
        );
        await page.waitForFunction(() =>
          document.getAnimations().every((x) => x.playState !== "running"),
        );
        v = await axeRun(page);
        expect(v, v.join("\n")).toEqual([]);
        await page.screenshot({
          path: info.outputPath(`members-confirm-${scheme}-${width}.png`),
          fullPage: true,
        });
      });
    });

test("keyboard: open the More menu, restrict manually, focus comes back", async ({
  page,
}) => {
  await page.goto("/settings/members?hosted=1");
  await page.waitForLoadState("networkidle");
  const more = page.getByRole("button", { name: "More for Bob Builder" });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Restrict manually…" }).focus();
  await page.keyboard.press("Enter");
  const d = page.getByRole("alertdialog");
  await d.getByRole("button", { name: "Restrict" }).focus();
  await page.keyboard.press("Enter");
  await expect(d).toHaveCount(0);
  await expect(page.locator("li", { hasText: "Bob Builder" })).toContainText(
    "bob@example.com · manually",
  );
  await expect(more).toBeFocused();
});

// Hosted P4 Task 13 (D7): the Departed card above Members and the transfer
// dialog, at 1280 and 390, light and dark, with axe.
for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`departed card and transfer dialog at ${width}px ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/members?hosted=1");
      await page.waitForLoadState("networkidle");
      const card = page.getByRole("region", { name: "Departed" });
      await expect(card).toContainText(
        "2 personal artifacts (plus 1 in trash) · their space artifacts stay put",
      );
      await expect(
        page.getByRole("link", { name: "Members, needs attention" }),
      ).toBeVisible();
      const over = await page.evaluate(
        () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
      );
      expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
      await page.screenshot({
        path: info.outputPath(`departed-${scheme}-${width}.png`),
        fullPage: true,
      });
      // Parity 1: the row's button is "Transfer all to me"; the dialog is in More.
      await card
        .getByRole("button", { name: "More for Carol Departed" })
        .click();
      await page
        .getByRole("menuitem", { name: "Transfer to someone else…" })
        .click();
      const d = page.getByRole("dialog");
      await expect(d).toContainText(
        "Transfer Carol Departed's 2 personal artifacts",
      );
      await d.getByRole("combobox", { name: "Give them to" }).click();
      await page.getByRole("option", { name: "Bob Builder" }).click();
      await page.waitForFunction(() =>
        document.getAnimations().every((x) => x.playState !== "running"),
      );
      await page.addScriptTag({ path: AXE });
      const v: string[] = await page.evaluate(async () => {
        // @ts-expect-error injected
        const r = await axe.run(document, { resultTypes: ["violations"] });
        return r.violations
          .filter(
            (x: { impact: string }) =>
              x.impact === "serious" || x.impact === "critical",
          )
          .map((x: { id: string }) => x.id);
      });
      expect(v).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`transfer-${scheme}-${width}.png`),
      });
      await d.getByRole("button", { name: "Transfer 2" }).click();
      await expect(
        page.getByText("Moved 2 artifacts (and 1 in trash) to Bob Builder."),
      ).toBeVisible();
      await expect(card).toBeHidden();
    });

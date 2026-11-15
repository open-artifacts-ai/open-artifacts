// #2520: Settings > Login, the domain dialogs, the invite dialog's rows and
// the first-invite step, on the PROVISIONAL mocks (?mock=login, mockLogin.ts),
// at 1280 and 390, light and dark: axe and no sideways scroll everywhere.
// Shots only when LOGIN_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const OUT = process.env.LOGIN_SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

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

/** axe, no sideways scroll, and a shot. */
const check = async (page: Page, name: string) => {
  await settled(page);
  const v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
  const over = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) - innerWidth,
  );
  expect(over, "horizontal overflow px").toBeLessThanOrEqual(0);
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};

const open = async (page: Page, path: string, scenario: string) => {
  const sep = path.includes("?") ? "&" : "?";
  await page.goto(`${path}${sep}hosted=1&mock=login&login=${scenario}`);
};

const PAGES: { s: string; sees: string; hides?: string }[] = [
  { s: "owner-off", sees: "Off. Only people you invite can get in." },
  {
    s: "owner-on",
    sees: "Your own Google Workspace domain, taken from your login.",
  },
  { s: "admin", sees: "Anyone at your domain" },
  { s: "gmail", sees: "Not available: you log in with a Gmail address" },
  { s: "solo", sees: "How people log in", hides: "Who can get in" },
  { s: "selfhost", sees: "Set by whoever runs this server." },
  { s: "codes-off", sees: "Everyone who can get in uses Google." },
  { s: "no-google", sees: "Everyone who can get in uses an email code." },
];

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const tag = `${scheme}-${width}`;

      for (const p of PAGES)
        test(`Login: ${p.s}`, async ({ page }) => {
          await open(page, "/settings/login", p.s);
          await expect(
            page.getByRole("heading", { name: "How people log in" }),
          ).toBeVisible();
          await expect(page.getByText(p.sees).first()).toBeVisible();
          if (p.hides)
            await expect(
              page.getByRole("heading", { name: p.hides }),
            ).toHaveCount(0);
          // The tab sits between Members and Spaces (or Members and the next).
          const tabs = page.getByRole("navigation", {
            name: "Settings sections",
          });
          await expect(
            tabs.getByRole("link", { name: "Login", exact: true }),
          ).toBeVisible();
          if (p.s === "admin")
            await expect(
              page.getByRole("switch", { name: "Anyone at your domain" }),
            ).toHaveCount(0);
          await check(page, `login-${p.s}-${tag}`);
        });

      test("turn on: the dialog, then the login comes back with it on", async ({
        page,
      }) => {
        await open(page, "/settings/login", "owner-off");
        const sw = page.getByRole("switch", { name: "Anyone at your domain" });
        await expect(sw).toHaveAttribute("aria-checked", "false");
        await sw.click();
        const d = page.getByRole("alertdialog", {
          name: "Let anyone at acme.com join?",
        });
        await expect(d).toContainText(
          "Anyone in this Google Workspace can join.",
        );
        await check(page, `domain-on-dialog-${tag}`);
        await d
          .getByRole("button", { name: "Log in again and turn on" })
          .click();
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

      test("turn off: the dialog", async ({ page }) => {
        await open(page, "/settings/login", "owner-on");
        await page
          .getByRole("switch", { name: "Anyone at your domain" })
          .click();
        const d = page.getByRole("alertdialog", {
          name: "Stop letting acme.com join by itself?",
        });
        await expect(d).toContainText(
          "The 14 members who already joined keep their access.",
        );
        await check(page, `domain-off-dialog-${tag}`);
        await d.getByRole("button", { name: "Turn off" }).click();
        await expect(
          page.getByText("Off. Only people you invite can get in."),
        ).toBeVisible();
      });

      test("apply_pending: Saving, then Saved", async ({ page }) => {
        await open(page, "/settings/login?reauthed=1", "pending");
        await page
          .getByRole("switch", { name: "Anyone at your domain" })
          .click();
        await page
          .getByRole("button", { name: "Log in again and turn on" })
          .click();
        await expect(page.getByText("Saved.")).toBeVisible();
        await check(page, `domain-saved-${tag}`);
      });

      for (const [s, list, expectText] of [
        [
          "owner-on",
          "pat@acme.com, sam@globex.io, lee@gmail.com ",
          "At your domain. Logs in with Google or an email code.",
        ],
        [
          "codes-off",
          "pat@acme.com sam@globex.io ",
          "Logs in with Google, if their address is a Google Workspace account",
        ],
        [
          "no-google",
          "sam@globex.io ",
          "Can't log in here yet. Their Google account must be Gmail or Google Workspace.",
        ],
        ["no-email", "pat@acme.com ", "An invite lasts 30 days."],
      ] as const)
        test(`invite rows: ${s}`, async ({ page }) => {
          await open(page, "/settings/members", s);
          await page.getByRole("button", { name: "Invite people" }).click();
          const d = page.getByRole("dialog", { name: "Invite people" });
          await d.getByRole("textbox", { name: "Email" }).fill(list);
          await expect(d.getByText(expectText)).toBeVisible();
          await expect(d).not.toContainText("may not be able to log in");
          await check(page, `invite-${s}-${tag}`);
        });

      test("invite: a removed member, with the date", async ({ page }) => {
        await open(page, "/settings/members", "owner-on");
        await page.getByRole("button", { name: "Invite people" }).click();
        const d = page.getByRole("dialog", { name: "Invite people" });
        await d
          .getByRole("textbox", { name: "Email" })
          .fill("removed@acme.com sam@globex.io ");
        await expect(
          d.getByText("Removed on Nov 12. Restore them to let them back in."),
        ).toBeVisible();
        await check(page, `invite-removed-${tag}`);
      });

      test("domain_unproven", async ({ page }) => {
        await open(page, "/settings/login?reauthed=1", "unproven");
        await page
          .getByRole("switch", { name: "Anyone at your domain" })
          .click();
        await page
          .getByRole("button", { name: "Log in again and turn on" })
          .click();
        await expect(
          page.getByText(
            "We couldn't confirm that acme.com is your Google Workspace domain.",
            { exact: false },
          ),
        ).toBeVisible();
        await check(page, `domain-unproven-${tag}`);
      });

      test("first invite", async ({ page }) => {
        await open(page, "/settings/members", "first-invite");
        await page.getByRole("button", { name: "Invite people" }).click();
        const d = page.getByRole("dialog", {
          name: "Who should be able to join Acme Artifacts?",
        });
        await expect(
          d.getByRole("radio", { name: /Only people I invite/ }),
        ).toBeChecked();
        await check(page, `first-invite-${tag}`);
        await d.getByRole("button", { name: "Skip for now" }).click();
        await expect(
          page.getByRole("dialog", { name: "Invite people" }),
        ).toBeVisible();
      });
    });

test("a member sees no Login tab", async ({ page }) => {
  await page.goto("/settings/profile?hosted=1&mock=login&role=member");
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(tabs.getByRole("link", { name: "Profile" })).toBeVisible();
  await expect(
    tabs.getByRole("link", { name: "Login", exact: true }),
  ).toHaveCount(0);
});

test("a server without login settings: no Login tab", async ({ page }) => {
  await page.goto("/settings/members?hosted=1");
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(tabs.getByRole("link", { name: "Members" })).toBeVisible();
  await expect(
    tabs.getByRole("link", { name: "Login", exact: true }),
  ).toHaveCount(0);
});

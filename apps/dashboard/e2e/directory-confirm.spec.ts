// Directory connect confirm step (#564, Design's recommended copy) at 1280 and
// 390, light and dark: the pre-Google dialog, pending_confirm (and capped),
// Cancel's "Nobody was added" and the expired warning. The mocks don't model
// pending_confirm, so the page's status and confirm/cancel are answered in
// the page.
import { expect, type Page, test } from "@playwright/test";

type Mode = "pending" | "capped" | "expire";

const pending = (page: Page, mode: Mode) =>
  page.addInitScript((mode) => {
    const real = window.fetch.bind(window);
    let state: "pending" | "off" = "pending";
    window.fetch = async (input, init) => {
      const r = new Request(input, init);
      const path = new URL(r.url).pathname;
      if (path === "/api/v1/directory" && r.method === "GET") {
        const res = await real(input, init);
        const body = await res.clone().json();
        const now = Date.now();
        return Response.json(
          state === "pending"
            ? {
                ...body,
                state: "pending_confirm",
                healthy: null,
                lastSuccessAt: null,
                held: [],
                pendingCount: mode === "capped" ? 500 : 12,
                pendingCountCapped: mode === "capped",
                pendingExpiresAt: new Date(now + 23 * 3600_000).toISOString(),
              }
            : {
                ...body,
                mode: "off",
                state: "never",
                binding: null,
                healthy: null,
                lastSuccessAt: null,
                held: [],
                pendingCount: null,
                pendingCountCapped: false,
                pendingExpiresAt: null,
              },
          { headers: res.headers },
        );
      }
      if (path === "/api/v1/directory/cancel" && r.method === "POST") {
        state = "off";
        return new Response(null, { status: 204 });
      }
      if (path === "/api/v1/directory/confirm" && r.method === "POST") {
        state = "off";
        return Response.json(
          { error: { code: "conflict", message: "expired" } },
          { status: 409 },
        );
      }
      return real(input, init);
    };
  }, mode);

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const status = (page: Page) =>
  page.getByRole("status", { name: "Sync status" });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`directory confirm ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = async (
        page: Page,
        name: string,
        out: (n: string) => string,
      ) => {
        await settle(page);
        await page.screenshot({
          path: out(`dir-${name}-${scheme}-${width}.png`),
          fullPage: true,
        });
      };

      test("the pre-Google dialog", async ({ page }, info) => {
        await page.goto("/settings/directory?hosted=sync-off");
        await status(page)
          .getByRole("button", { name: "Connect Google Workspace" })
          .click();
        const d = page.getByRole("dialog", {
          name: "Connect Google Workspace",
        });
        await expect(d).toContainText(
          "You'll see how many people before anything changes.",
        );
        await expect(
          d.getByRole("link", { name: "Continue to Google" }),
        ).toBeVisible();
        await shot(page, "connect", (n) => info.outputPath(n));
      });

      test("pending, then Cancel: nobody was added", async ({ page }, info) => {
        await pending(page, "pending");
        await page.goto("/settings/directory?hosted=1");
        await expect(
          status(page).getByRole("heading", { level: 2 }),
        ).toHaveText("Add 12 people?");
        await expect(status(page)).toContainText("Confirm by ");
        await shot(page, "pending", (n) => info.outputPath(n));
        await status(page).getByRole("button", { name: "Cancel" }).click();
        await expect(
          page.getByText("Not connected. Nobody was added."),
        ).toBeVisible();
        await shot(page, "cancelled", (n) => info.outputPath(n));
      });

      test("capped", async ({ page }, info) => {
        await pending(page, "capped");
        await page.goto("/settings/directory?hosted=1");
        await expect(
          status(page).getByRole("heading", { level: 2 }),
        ).toHaveText("Add 500+ people?");
        await expect(
          status(page).getByRole("button", { name: "Add people" }),
        ).toBeVisible();
        await shot(page, "capped", (n) => info.outputPath(n));
      });

      test("expired: back to Connect with the warning", async ({
        page,
      }, info) => {
        await pending(page, "expire");
        await page.goto("/settings/directory?hosted=1");
        await status(page)
          .getByRole("button", { name: "Add 12 people" })
          .click();
        await expect(
          page.getByText(
            "This confirmation expired after 24 hours. Connect again to see the current count.",
          ),
        ).toBeVisible();
        await expect(
          status(page).getByRole("button", {
            name: "Connect Google Workspace",
          }),
        ).toBeVisible();
        await shot(page, "expired", (n) => info.outputPath(n));
      });
    });

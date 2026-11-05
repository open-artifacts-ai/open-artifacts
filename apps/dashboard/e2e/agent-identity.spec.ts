// Agent identity cards (Design ecAopo8RUyk2Xomu, #559) at 1280 and 390, light
// and dark: a 60-character label, no label, a hosted service, an old
// connection, editing a label, and the empty state. The list is answered in
// the page so every case shows at once.
import { expect, type Page, test } from "@playwright/test";

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ROWS = [
  {
    grantId: "AgLabel60xxxxxxx",
    clientName: "Claude Code",
    clientVersion: "2.1.307",
    createdAt: ago(3 * 864e5),
    label: "Studio work laptop, the silver one with stickers on the lid.",
    redirectKind: "computer",
    approvedFrom: { browser: "chrome", os: "macos" },
    lastUsedAt: ago(2 * 3600e3),
    versionsPublished: 42,
  },
  {
    grantId: "AgPlainxxxxxxxxx",
    clientName: "Codex CLI",
    clientVersion: "0.9.1",
    createdAt: ago(10 * 864e5),
    redirectKind: "computer",
    approvedFrom: { browser: "firefox", os: "linux" },
    lastUsedAt: ago(864e5),
    versionsPublished: 1,
  },
  {
    grantId: "AgHostedxxxxxxxx",
    clientName: "Acme Agent",
    clientVersion: "3.0",
    createdAt: ago(20 * 864e5),
    redirectKind: "hosted",
    redirectHost: "agents.acme.example",
    approvedFrom: { browser: "safari", os: "ios" },
  },
  {
    grantId: "AgOldxxxxxxxxxxx",
    clientName: "Example MCP client",
    createdAt: "2026-01-02T10:00:00.000Z",
  },
];

const serve = (page: Page, rows: unknown[]) =>
  page.addInitScript((rows) => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const r = new Request(input, init);
      return r.method === "GET" &&
        new URL(r.url).pathname === "/api/v1/oauth-clients"
        ? Promise.resolve(Response.json(rows))
        : real(input, init);
    };
  }, rows);
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const card = (page: Page) =>
  page.getByRole("region", { name: "Connected agents" });

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`agents ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 1000 } });
      const shot = async (
        page: Page,
        name: string,
        out: (n: string) => string,
      ) => {
        await settle(page);
        await card(page).screenshot({
          path: out(`agents-${name}-${scheme}-${width}.png`),
        });
      };

      test("rows: label, plain, hosted, old", async ({ page }, info) => {
        await serve(page, ROWS);
        await page.goto("/settings/agents");
        await expect(card(page).getByText("Hosted service at")).toBeVisible();
        await expect(
          card(page).getByText(/before these details were recorded/),
        ).toBeVisible();
        await expect(card(page).getByText("reported by the agent")).toHaveCount(
          4,
        );
        await shot(page, "rows", (n) => info.outputPath(n));
        // Editing a label in place.
        await card(page)
          .locator("li", { hasText: "Codex CLI" })
          .getByRole("button", { name: "Add label" })
          .click();
        await expect(
          card(page).getByRole("textbox", { name: "Your label" }),
        ).toBeFocused();
        await shot(page, "editing", (n) => info.outputPath(n));
      });

      test("empty", async ({ page }, info) => {
        await serve(page, []);
        await page.goto("/settings/agents");
        await expect(
          card(page).getByText("No agents connected yet."),
        ).toBeVisible();
        await shot(page, "empty", (n) => info.outputPath(n));
      });
    });

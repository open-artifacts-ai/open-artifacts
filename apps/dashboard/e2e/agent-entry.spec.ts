import { expect, test } from "@playwright/test";

for (const width of [1280, 390])
  for (const theme of ["light", "dark"])
    test(`agent setup is distinct from messaging at ${width}px ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // The API supplies a live bus with no paired machines or running agents.
      // Keep the normal artifact/connection mocks so this starts in a populated library.
      await page.addInitScript(() => {
        const fetch = window.fetch;
        window.fetch = async function (input, init) {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof Request
                ? input.url
                : String(input),
            location.href,
          );
          if (url.pathname === "/api/v1/bus/agents")
            return Response.json({ agents: [], live: true });
          if (url.pathname === "/api/v1/bus/machines")
            return Response.json({ machines: [] });
          return fetch.call(this, input, init);
        };
      });
      await page.goto("/?mock=bus");
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(
        page.getByRole("link", { name: "Landing page", exact: true }),
      ).toBeVisible();
      const nav = page.getByRole("navigation", { name: "Primary" });
      if (width === 390)
        await page.getByRole("button", { name: "Toggle navigation" }).click();
      await expect(
        nav.getByRole("link", { name: "Agent messaging" }),
      ).toHaveAttribute("href", "/agents");
      await nav.getByRole("link", { name: "Connect agents" }).click();
      await expect(page).toHaveURL(/\/settings\/connections$/);
      await expect(
        page.getByLabel("Setup prompt", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "MCP server", exact: true }),
      ).toBeVisible();
      await page.getByRole("tab", { name: "Codex CLI", exact: true }).click();
      await expect(page.getByText(/codex mcp add/)).toBeVisible();
      if (width === 390) {
        await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(
          0,
        );
        await page.getByRole("button", { name: "Toggle navigation" }).click();
      }
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      await expect(
        nav.getByRole("link", { name: "Connect agents" }),
      ).toHaveAttribute("aria-current", "page");
      await expect(
        nav.getByRole("link", { name: /^Settings/ }),
      ).not.toHaveAttribute("aria-current");
      await nav.getByRole("link", { name: "Agent messaging" }).click();
      await expect(
        page.getByRole("heading", { name: "Agent messaging", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Connect a machine first.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Go to Machines" }),
      ).toHaveAttribute("href", "/settings/machines");
      await page
        .getByRole("link", { name: "Connect an agent to your library" })
        .click();
      await expect(
        page.getByLabel("Setup prompt", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBe(0);
    });

test("messaging deep links and tabs keep their URLs", async ({ page }) => {
  await page.goto("/agents/namespaces?mock=bus");
  await expect(
    page.getByRole("heading", { name: "Agent messaging", exact: true }),
  ).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Agents sections" });
  await expect(
    sections.getByRole("link", { name: "Namespaces", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("link", { name: "Roles and access", exact: true })
    .click();
  await expect(page).toHaveURL(/\/agents\/roles$/);
  await expect(
    sections.getByRole("link", { name: "Roles and access", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Agent messaging" }),
  ).toHaveAttribute("aria-current", "page");
});

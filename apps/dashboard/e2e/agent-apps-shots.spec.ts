// agy S6: the Agents page shows each agent's app with its mark, in light and
// dark. Shots only when AGENT_APPS_SHOTS_DIR is set; the assertions always run.
// The mock agents cover every known kind; one more, of a kind the server
// doesn't know, is added to the list here.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const OUT = process.env.AGENT_APPS_SHOTS_DIR;

const APPS = [
  "Claude Code",
  "Codex",
  "Antigravity",
  "oh-my-pi",
  "OpenClaw",
  "OpenCode",
  "Pi",
  "Hermes",
  "kiro",
];

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: every agent's app and mark`, async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await real(input, init);
        const url = new Request(input, init).url;
        if (!url.includes("/api/v1/bus/agents")) return res;
        const body = await res.json();
        const base = body.agents[0];
        const { product: _, ...rest } = base;
        body.agents.push({
          ...rest,
          id: "BaZ9nPqRsTu4vWxY",
          name: "scout",
          kind: "kiro",
          statusLabel: "A kind this server doesn't know yet",
        });
        return new Response(JSON.stringify(body), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      };
    });
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1440, height: 820 });
    await page.goto("/agents?mock=bus");
    const table = page.getByRole("table", { name: "Agents" });
    await expect(
      table.getByRole("columnheader", { name: "App" }),
    ).toBeVisible();
    for (const app of APPS)
      await expect(table.getByRole("img", { name: app, exact: true })).toBeVisible();
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: `${OUT}/agents-${theme}.png` });
    }
  });
}

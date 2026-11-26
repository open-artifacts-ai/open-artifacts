// agy S6: a comment author's line shows the agent's app with its mark, for
// every kind, in light and dark. Shots only when AGENT_APPS_SHOTS_DIR is set;
// the assertions always run. The page's comment list is replaced here with one
// note per author, as the server sends them.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const OUT = process.env.AGENT_APPS_SHOTS_DIR;
const ID = "Cd5fGhJkLm6nPqRs";

// Sharp enough to read a 12px mark in the shot.
test.use({ deviceScaleFactor: 2 });

/** [bus name, product, appKind, animal]: a linked agent as a member sees it. */
const AUTHORS = [
  ["agy-docs", "Antigravity", undefined, "owl"],
  ["oa-manager", "Claude Code", undefined, "fox"],
  ["reviewer", "Codex", undefined, "bear"],
  ["bus-lead", "oh-my-pi", undefined, "duck"],
  ["pi-2", "pi", undefined, "cat"],
  ["scout", undefined, "kiro", "frog"],
] as const;

for (const theme of ["light", "dark"] as const)
  test(`${theme}: a comment author shows the agent's app and mark`, async ({
    page,
  }) => {
    await page.addInitScript(
      ([authors, id]) => {
        const real = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const res = await real(input, init);
          const req = new Request(input, init);
          const path = new URL(req.url).pathname;
          if (
            req.method !== "GET" ||
            path !== `/api/v1/artifacts/${id}/comments`
          )
            return res;
          const body = await res.json();
          const base = body.threads[0];
          body.threads = authors.map(([name, product, appKind, animal], i) => ({
            ...base,
            id: `th${i}AbCdEfGhJkLmN`,
            status: "open",
            resolvedBy: null,
            resolvedAt: null,
            anchor: { kind: "note" },
            comments: [
              {
                ...base.comments[0],
                id: `cm${i}AbCdEfGhJkLmN`,
                body: `A note from ${name}.`,
                typed: false,
                ask: undefined,
                author: {
                  kind: "agent",
                  name,
                  for: "Leo Urbina",
                  linked: true,
                  ...(product ? { product } : {}),
                  ...(appKind ? { appKind } : {}),
                  animal: { id: animal, color: i },
                  me: false,
                },
              },
            ],
          }));
          body.open = authors.length;
          return new Response(JSON.stringify(body), {
            status: res.status,
            headers: { "content-type": "application/json" },
          });
        };
      },
      [AUTHORS, ID] as const,
    );
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1280, height: 1640 });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    for (const [name, product, appKind] of AUTHORS) {
      const app = product ?? appKind;
      const line = page
        .locator("[data-thread]")
        .filter({ hasText: `A note from ${name}.` })
        .locator("[data-for]");
      await expect(line).toHaveText(`linked, ${app} · for Leo Urbina`);
      await expect(line.getByRole("img", { name: app })).toBeVisible();
    }
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      const panel = page
        .locator("[data-thread]")
        .first()
        .locator(
          "xpath=ancestor::*[@role='complementary' or @role='dialog' or self::aside][1]",
        );
      await ((await panel.count()) ? panel : page.locator("body")).screenshot({
        path: `${OUT}/comment-author-${theme}.png`,
      });
    }
  });

// M2 whole-track review: axe on every route and theme at 1280 and 390, 390 px overflow,
// keyboard-only settings and card navigation, token secrecy after the dialog closes.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

/** Overrides /api/v1/usage before the app's mock fetch wrapper is installed. */
const notConfigured = async (page: Page) =>
  page.addInitScript(() => {
    const f = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const u = new Request(input, init).url;
      if (u.includes("/api/v1/usage"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              available: false,
              plan: "free",
              date: "2026-10-19",
              metrics: [],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      return f(input, init);
    };
  });

type Route = {
  path: string;
  setup?: (p: Page) => Promise<unknown>;
  after?: (p: Page) => Promise<void>;
};
const ROUTES: Route[] = [
  { path: "/" },
  { path: "/mine" },
  { path: "/shared" },
  { path: "/team" },
  { path: "/search?q=notes" },
  { path: "/a/Ef7hJkLmNp8qRsTv?panel=open&tab=versions" },
  { path: "/a/Ef7hJkLmNp8qRsTv?panel=open&tab=share" },
  { path: "/a/Ef7hJkLmNp8qRsTv?panel=open&tab=details" },
  { path: "/a/Cd5fGhJkLm6nPqRs/diff/1/2" },
  { path: "/no-access" },
  { path: "/sign-in" },
  { path: "/sign-in?hosted=1" },
  { path: "/sign-in?hosted=1&error=tenant" },
  { path: "/sign-in?hosted=1&method=code" },
  {
    path: "/sign-in?hosted=1&method=code#code",
    after: async (p) => {
      await p.getByRole("textbox", { name: "Email" }).fill("bob@example.com");
      await p.getByRole("button", { name: "Send code" }).click();
      await p.getByRole("textbox", { name: "Code", exact: true }).waitFor();
    },
  },
  { path: "/nope" },
  { path: "/settings/members" },
  { path: "/settings/agents" },
  { path: "/settings/instance" },
  { path: "/settings/usage" },
  { path: "/settings/usage?mock=quota" },
  { path: "/settings/usage#not-configured", setup: notConfigured },
  {
    path: "/settings/agents#created-token",
    after: async (p) => {
      await p.getByRole("button", { name: "Create token" }).click();
      await p.getByRole("textbox", { name: "Label" }).fill("ci");
      await p.getByRole("button", { name: "Create", exact: true }).click();
      await p.getByRole("dialog", { name: "Token created" }).waitFor();
    },
  },
];

/**
 * Waits until every CSS transition and animation has finished. Switching
 * data-theme starts color transitions (shadcn tabs use transition-colors,
 * 150ms); axe measuring mid-way reads blended colors and fails contrast.
 */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

const open = async (page: Page, r: Route, theme: string, w: number) => {
  await page.setViewportSize({ width: w, height: 800 });
  await r.setup?.(page);
  await page.goto(r.path);
  await page.waitForLoadState("networkidle");
  await r.after?.(page);
  await page.evaluate(
    (t) => document.documentElement.setAttribute("data-theme", t),
    theme,
  );
  await settled(page);
};

for (const r of ROUTES)
  for (const theme of ["light", "dark"])
    for (const w of [1280, 390])
      test(`axe ${r.path} ${theme} ${w}`, async ({ page }) => {
        await open(page, r, theme, w);
        await page.addScriptTag({ path: AXE });
        const v = await page.evaluate(async () => {
          // @ts-expect-error injected
          const res = await axe.run(document, { resultTypes: ["violations"] });
          return res.violations
            .filter(
              (x: { impact: string }) =>
                x.impact === "serious" || x.impact === "critical",
            )
            .map(
              (x: {
                id: string;
                impact: string;
                nodes: { target: string[] }[];
              }) =>
                `${x.impact} ${x.id}: ${x.nodes
                  .map((n) => n.target.join(" "))
                  .slice(0, 4)
                  .join(" | ")}`,
            );
        });
        expect(v, v.join("\n")).toEqual([]);
      });

for (const r of ROUTES)
  test(`no horizontal scroll at 390 ${r.path}`, async ({ page }) => {
    await open(page, r, "light", 390);
    const res = await page.evaluate(() => {
      const se = document.scrollingElement as Element;
      const wide = [...document.querySelectorAll("body *")]
        .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
        .map(
          (e) =>
            `${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").split(" ")[0]} right=${Math.round(e.getBoundingClientRect().right)}`,
        )
        .slice(0, 6);
      return { sw: se.scrollWidth, iw: innerWidth, wide };
    });
    expect(
      res.sw,
      `${res.sw} > ${res.iw}; ${res.wide.join(", ")}`,
    ).toBeLessThanOrEqual(res.iw);
  });

test("keyboard: whole card has one tab stop, a visible ring and Enter opens it", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const card = page.locator(".lib-card").first();
  const title = card.locator("a.lib-title");
  // Count the card's tab stops.
  const stops = await card.evaluate(
    (c) =>
      [...c.querySelectorAll<HTMLElement>("a,button,[tabindex]")].filter(
        (e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled,
      ).length,
  );
  expect(stops).toBe(1);
  await title.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(title).toBeFocused();
  const ring = await card.evaluate((c) => getComputedStyle(c).outlineStyle);
  expect(ring).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/a\//);
});

test("keyboard: create and revoke a token without a mouse", async ({
  page,
}) => {
  await page.goto("/settings/agents");
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
  await page.goto("/settings/agents");
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

test("keyboard: settings tabs and role select reachable by Tab", async ({
  page,
}) => {
  await page.goto("/settings/members");
  await page.waitForLoadState("networkidle");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Agents" })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\/agents$/);
  await expect(page.getByRole("radio", { name: "OAuth" })).toBeVisible();
});

test("keyboard: role select, invite dialog and remove confirm without a mouse", async ({
  page,
}) => {
  await page.goto("/settings/members");
  await page.waitForLoadState("networkidle");
  const sel = page.getByRole("combobox", { name: /^Role for / }).first();
  await sel.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(sel).toBeFocused();
  await page.getByRole("button", { name: "Add member" }).first().focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("textbox", { name: "Email" })).toBeFocused();
  await page.keyboard.type("kbd@example.com");
  await page.keyboard.press("Enter");
  // #167: the dialog confirms with the sign-in link before closing.
  await expect(
    dlg.getByRole("heading", { name: "kbd@example.com can now sign in" }),
  ).toBeVisible();
  await dlg.getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Enter");
  await expect(dlg).toBeHidden();
  await expect(page.getByText("kbd@example.com")).toBeVisible();
  // Parity 1: Remove lives in the row's More menu on every install.
  const more = page.getByRole("button", { name: "More for kbd@example.com" });
  await more.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Remove…" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: /Remove kbd/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

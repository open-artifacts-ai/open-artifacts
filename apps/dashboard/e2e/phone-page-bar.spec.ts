// #2622: the viewer page bar on a 360px phone is two rows in every state, and
// nothing wraps: row one is the back arrow and title, row two the buttons.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

/** BAR_SHOTS_DIR: write the light/dark phone shots here (off in CI otherwise). */
const SHOTS = process.env.BAR_SHOTS_DIR;

/** Every animation has stopped, so a screenshot cannot catch one mid-flight. */
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.use({ viewport: { width: 360, height: 740 } });

const STATES: [string, string][] = [
  ["owner", `/a/${ID}?mock=asks&asks=0`],
  ["asks waiting", `/a/${ID}?mock=asks`],
  ["older version", `/a/${ID}/v/1`],
  ["member", `/a/${ID}?role=member`],
  ["guest", `/a/${ID}?role=guest`],
  ["signed out", `/a/${ID}?mock=signed-out`],
];

for (const [name, url] of STATES) {
  test(`${name}: two rows, nothing wraps at 360px`, async ({ page }) => {
    await page.goto(url);
    const bar = page.locator(".oa-vt").first();
    await expect(bar.locator("h1, button").first()).toBeVisible();
    // The path row is gone on a phone.
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toBeHidden();
    const m = await bar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const rows = new Set<number>();
      for (const b of el.querySelectorAll("button, a")) {
        const t = b.getBoundingClientRect();
        if (t.width === 0 || t.height === 0) continue;
        rows.add(Math.round(t.top / 10));
      }
      return {
        height: r.height,
        overflow: el.scrollWidth - el.clientWidth,
        rows: rows.size,
        vw: document.documentElement.scrollWidth - window.innerWidth,
        doc: document.documentElement.scrollWidth,
      };
    });
    // Two rows of 32px controls plus padding: well under three rows.
    expect(m.height).toBeLessThan(100);
    expect(m.overflow).toBeLessThanOrEqual(0);
    expect(m.vw).toBeLessThanOrEqual(0);
    // No sideways scroll on a 360px phone (#2622, "Done when").
    expect(m.doc).toBeLessThanOrEqual(360);
    expect(m.rows).toBeLessThanOrEqual(2);
    // The approved spoken label on an older version, verbatim from the issue.
    if (name === "older version") {
      const chip = page.getByRole("button", {
        name: "Version 1, not the latest",
      });
      // The pill itself reads "v1"; the whole line is its spoken name.
      await expect(chip.locator("[aria-hidden=true]").first()).toHaveText("v1");
    }
  });
}

test("asks waiting: the Comments button is gold and counts the asks", async ({
  page,
}) => {
  await page.goto(`/a/${ID}?mock=asks`);
  const b = page.getByRole("button", { name: /^\d+ asks? for you$/ });
  await expect(b).toBeVisible();
  await expect(b).toHaveText(/^\d+ asks?\s*$/);
  await expect(page.getByText("No asks for you")).toHaveCount(0);
  // Gold, not the outlined default: the same amber the bell's badge uses.
  expect(await b.evaluate((el) => el.getAttribute("data-asks-for-you"))).toBe(
    "",
  );
  expect(
    await b.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
});

// The widest case: a long title, 12 asks waiting, v115 of 200, a Manager's
// access label (a guest: "Can comment"), Share, the menu and the bell. Nothing
// may clip: every button's right edge stays inside the viewport.
for (const [name, role] of [
  ["member (Manager, Share, bell)", "member"],
  ["guest (Can comment, bell)", "guest"],
] as const) {
  test(`widest case, ${name}: two rows, nothing clipped at 360px`, async ({
    page,
  }) => {
    // The For you mock turns the bell on; asks=1 keeps the page's asks.
    await page.goto(`/a/${ID}/v/115?mock=foryou&asks=1&widest=1&role=${role}`);
    const b = page.getByRole("button", { name: "12 asks for you" });
    await expect(b).toBeVisible();
    await expect(b).toHaveText(/^12 asks\s*$/);
    // The approved spoken label, verbatim: `Version {n}, not the latest`.
    const chip = page.getByRole("button", {
      name: "Version 115, not the latest",
    });
    await expect(chip).toBeVisible();
    await expect(chip.locator("[aria-hidden=true]").first()).toHaveText("v115");
    const bar = page.locator(".oa-vt").first();
    // The bell is in the bar, and measured with the rest.
    await expect(bar.locator("[data-for-you-bell]")).toBeVisible();
    const m = await bar.evaluate((el) => {
      const rows = new Set<number>();
      let maxRight = 0;
      let minLeft = 9999;
      for (const x of el.querySelectorAll("button, a")) {
        const t = x.getBoundingClientRect();
        if (t.width === 0 || t.height === 0) continue;
        rows.add(Math.round(t.top / 10));
        maxRight = Math.max(maxRight, t.right);
        minLeft = Math.min(minLeft, t.left);
      }
      return {
        height: el.getBoundingClientRect().height,
        rows: rows.size,
        maxRight,
        minLeft,
        vw: window.innerWidth,
        scroll: document.documentElement.scrollWidth - window.innerWidth,
        doc: document.documentElement.scrollWidth,
      };
    });
    expect(m.height).toBeLessThan(100);
    expect(m.rows).toBeLessThanOrEqual(2);
    expect(m.maxRight).toBeLessThanOrEqual(m.vw);
    expect(m.minLeft).toBeGreaterThanOrEqual(0);
    expect(m.scroll).toBeLessThanOrEqual(0);
    expect(m.doc).toBeLessThanOrEqual(360);
    // The title row's own buttons (the back arrow) are inside too.
    for (const btn of await bar.getByRole("button").all()) {
      const box = await btn.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(m.vw);
    }
  });
}

// The shots for OA Design (issue #2622, tab 4's states): 360 and 390 wide, light
// and dark, at phone height. They assert the same things the tests above do, so
// a shot cannot be of a broken bar; the files land in BAR_SHOTS_DIR.
const SHOT_STATES: [string, string][] = [
  ["current", `/a/${ID}?role=member`],
  ["older-version", `/a/${ID}/v/1`],
  ["asks-waiting", `/a/${ID}?mock=asks`],
  ["widest", `/a/${ID}/v/115?mock=foryou&asks=1&widest=1&role=member`],
  ["menu-open", `/a/${ID}?role=member`],
];

for (const width of [360, 390])
  for (const theme of ["light", "dark"] as const)
    test.describe(`${width} ${theme}: the bar's states`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 844 } });

      for (const [name, url] of SHOT_STATES)
        test(`${name}`, async ({ page }) => {
          await page.goto(url);
          const bar = page.locator(".oa-vt").first();
          await expect(bar.locator("h1").first()).toBeVisible();
          if (name === "older-version")
            await expect(
              page
                .getByRole("button", { name: "Version 1, not the latest" })
                .locator("[aria-hidden=true]")
                .first(),
            ).toHaveText("v1");
          if (name === "asks-waiting")
            await expect(
              page.getByRole("button", { name: /^\d+ asks? for you$/ }),
            ).toBeVisible();
          if (name === "current")
            await expect(
              page.getByRole("button", { name: /^v\d+, the latest version$/ }),
            ).toBeVisible();
          if (name === "widest")
            // The approved label, verbatim, at its tightest: 12 asks and v115.
            await expect(
              page
                .getByRole("button", { name: "Version 115, not the latest" })
                .locator("[aria-hidden=true]")
                .first(),
            ).toHaveText("v115");
          if (name === "menu-open") {
            await page.getByRole("button", { name: "More actions" }).click();
            await expect(
              page.getByRole("menuitem", { name: "Versions" }),
            ).toBeVisible();
          }
          const m = await bar.evaluate((el) => {
            const rows = new Set<number>();
            for (const b of el.querySelectorAll("button, a")) {
              const t = b.getBoundingClientRect();
              if (t.width === 0 || t.height === 0) continue;
              rows.add(Math.round(t.top / 10));
            }
            return {
              height: el.getBoundingClientRect().height,
              rows: rows.size,
              doc: document.documentElement.scrollWidth,
            };
          });
          // Two rows, and nothing wider than the phone it is on.
          expect(m.height).toBeLessThan(100);
          expect(m.rows).toBeLessThanOrEqual(2);
          expect(m.doc).toBeLessThanOrEqual(width);
          await shot(page, `bar-${width}-${theme}-${name}`);
        });
    });

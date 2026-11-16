// #2622: the page bar on a phone is two rows (Design's tab 2), in every state
// of tab 4, at 360, 390 and 600 wide, light and dark, with axe and no
// sideways scroll. PHONE_BAR_SHOTS_DIR picks where the PNGs go (360 and 390).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.PHONE_BAR_SHOTS_DIR;
const LANDING = "Cd5fGhJkLm6nPqRs";
const NOTES = "De6gHjKmNp7qRsTu"; // no threads

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
async function axe(page: Page) {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async () => {
    // @ts-expect-error injected
    const res = await axe.run(".oa-vt", { resultTypes: ["violations"] });
    return res.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; nodes: { html: string }[] }) =>
          `${x.id}: ${x.nodes.map((n) => n.html.slice(0, 100)).join(" | ")}`,
      );
  });
  expect(v).toEqual([]);
}

/** The bar is two rows, each one line: row two's controls share one top, nothing spills. */
async function twoRows(page: Page) {
  const r = await page.evaluate(() => {
    const bar = document.querySelector(".oa-vt") as HTMLElement;
    const [one, two] = Array.from(bar.children) as HTMLElement[];
    const tops = (el: HTMLElement | undefined) =>
      el
        ? Array.from(el.children)
            .filter((c) => (c as HTMLElement).offsetParent !== null)
            .map((c) => Math.round(c.getBoundingClientRect().top))
        : [];
    const h1 = bar.querySelector("h1") as HTMLElement;
    return {
      oneTops: tops(one),
      twoTops: tops(two),
      twoOver: two ? two.scrollWidth - two.clientWidth : 0,
      oneBottom: one?.getBoundingClientRect().bottom ?? 0,
      twoTop: two?.getBoundingClientRect().top ?? 0,
      h1Lines: Math.round(
        h1.getBoundingClientRect().height /
          Number.parseFloat(getComputedStyle(h1).lineHeight || "20"),
      ),
      sideways: (document.scrollingElement as Element).scrollWidth > innerWidth,
    };
  });
  // Row two's controls on one line, none clipped; row two under row one.
  expect(new Set(r.twoTops.map((t) => Math.round(t / 4))).size).toBe(1);
  expect(r.twoOver).toBeLessThanOrEqual(0);
  expect(r.twoTop).toBeGreaterThanOrEqual(r.oneBottom - 1);
  expect(r.h1Lines).toBeLessThanOrEqual(1);
  expect(r.sideways).toBe(false);
}

type State = {
  name: string;
  url: string;
  check?: (page: Page) => Promise<void>;
};
const STATES: State[] = [
  {
    name: "owner-no-comments",
    url: `/a/${NOTES}`,
    check: async (page) => {
      await expect(page.locator("[data-asks-gold]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
    },
  },
  {
    name: "owner-asks",
    url: `/a/${LANDING}?mock=asks`,
    check: async (page) => {
      const gold = page.locator("[data-asks-gold]");
      await expect(gold).toHaveText(/^\d+ asks?\s*$/);
      const n = Number((await gold.textContent())?.match(/\d+/)?.[0]);
      await expect(gold).toHaveAccessibleName(
        `${n} ask${n === 1 ? "" : "s"} for you`,
      );
    },
  },
  {
    name: "older-version",
    url: `/a/${LANDING}/v/1`,
    check: async (page) => {
      const pill = page.getByRole("button", {
        name: "Version 1, not the latest",
        exact: true,
      });
      await expect(pill.locator('[aria-hidden="true"]').first()).toHaveText(
        "v1",
      );
    },
  },
  {
    name: "member-no-share",
    url: `/a/${LANDING}?role=member`,
  },
  {
    name: "guest",
    url: `/a/${LANDING}?role=guest`,
    check: async (page) => {
      await expect(page.locator("[data-bar-back]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
    },
  },
  {
    name: "signed-out",
    url: `/a/${LANDING}?mock=signed-out`,
    check: async (page) => {
      await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
      await expect(page.locator("[data-bar-back]")).toHaveCount(0);
    },
  },
  {
    name: "widest",
    url: `/a/${LANDING}/v/1?mock=asks`,
    check: async (page) => {
      await expect(page.locator("[data-asks-gold]")).toBeVisible();
      await expect(page.locator("[data-version-old]")).toBeVisible();
    },
  },
];

for (const width of [360, 390, 600])
  for (const theme of ["light", "dark"] as const)
    test.describe(`${width} ${theme}`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 800 } });
      for (const s of STATES)
        test(s.name, async ({ page }) => {
          await page.goto(s.url);
          await expect(page.locator(".oa-vt h1")).toBeVisible();
          // No path row and no "No asks for you" on a phone.
          await expect(
            page.getByRole("navigation", { name: "Breadcrumb" }),
          ).toBeHidden();
          await expect(page.getByText("No asks for you")).toHaveCount(0);
          await s.check?.(page);
          await settled(page);
          await twoRows(page);
          await axe(page);
          if (OUT && width !== 600) {
            mkdirSync(OUT, { recursive: true });
            await page
              .locator(".oa-vt")
              .screenshot({ path: `${OUT}/${s.name}-${width}-${theme}.png` });
          }
        });
    });

test.describe("the back arrow", () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test("returns to where the person came from", async ({ page }) => {
    await page.goto("/mine");
    await page
      .locator("article.lib-card")
      .filter({ hasText: "Landing page" })
      .getByRole("link", { name: "Landing page" })
      .click();
    await expect(page.locator(".oa-vt h1")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(/\/mine$/);
  });
  test("goes to the Library with no history", async ({ page }) => {
    await page.goto(`/a/${LANDING}`);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
  test("is phone-only; a computer keeps the path row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/a/${LANDING}`);
    await expect(page.locator("[data-bar-back]")).toBeHidden();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toBeVisible();
  });
});

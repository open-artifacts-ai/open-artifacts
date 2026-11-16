// #2610 part 1: who published the version on screen, beside the title. At
// 1280, 900, 760 and 390, light and dark, with axe and no sideways scroll.
// PUBLISHER_SHOTS_DIR saves PNGs.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.PUBLISHER_SHOTS_DIR;
const DRAFT = "JkBnPqRsTu5vWxYz"; // Shared draft: Bob's agent published it
const LANDING = "Cd5fGhJkLm6nPqRs"; // public under ?mock=signed-out

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
async function axe(page: Page) {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; nodes: { target: string[] }[] }) =>
          `${x.id}: ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      );
  });
  expect(v, v.join("\n")).toEqual([]);
}
async function noSidewaysScroll(page: Page) {
  const r = await page.evaluate(() => ({
    sw: (document.scrollingElement as Element).scrollWidth,
    iw: innerWidth,
  }));
  expect(r.sw).toBeLessThanOrEqual(r.iw);
}
const shot = async (page: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await settled(page);
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: 0,
      y: 0,
      width: page.viewportSize()?.width ?? 1280,
      height: 420,
    },
  });
};
const line = (page: Page) => page.locator("[data-publisher]");
/** What carries the full line: the picture's button, or (signed out) the line itself. */
const named = (page: Page) =>
  page.locator("[data-publisher] button, span[data-publisher][role=img]");

for (const width of [1280, 900, 760, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the publisher beside the title at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${DRAFT}`);
      const p = line(page);
      // The full line is always the name and the tooltip.
      await expect(named(page)).toHaveAccessibleName(
        /^Published by Claude Code, Bob's agent, /,
      );
      if (width < 960) {
        await expect(p).toHaveAttribute("data-publisher-stage", "3");
        // Picture only: no words beside it, and no extra height.
        await expect(p).not.toContainText("Claude Code");
      } else {
        await expect(p).toContainText("Claude Code");
      }
      await axe(page);
      await noSidewaysScroll(page);
      await shot(page, `p1-bar-${width}-${theme}`);

      // One sheet: who can open it, who published it, See all versions.
      await named(page).click();
      const sheet = page.locator("[data-publisher-sheet]");
      await expect(sheet.locator("[data-published-by]")).toHaveText(
        "Published by Claude Code",
      );
      await expect(sheet).toContainText("Bob Builder's agent · ");
      await expect(sheet).toContainText("· version 1");
      await expect(
        sheet.getByRole("button", { name: "See all versions" }),
      ).toBeVisible();
      await axe(page);
      await shot(page, `p2-sheet-${width}-${theme}`);
      if (width === 390 || width === 1280) {
        await sheet.getByRole("button", { name: "See all versions" }).click();
        await expect(sheet).toHaveCount(0);
        await expect(
          page.getByRole("tab", { name: "Versions", selected: true }),
        ).toBeVisible();
      }
    });

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`a page a person published at ${width} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${DRAFT}?publisher=person`);
      const p = line(page);
      await expect(named(page)).toHaveAccessibleName(
        /^Published by Bob Builder, /,
      );
      if (width >= 960) await expect(p).toContainText("Bob Builder");
      await named(page).click();
      await expect(
        page.locator("[data-publisher-sheet] [data-published-by]"),
      ).toHaveText("Published by Bob Builder");
      await axe(page);
      await shot(page, `p3-person-${width}-${theme}`);
    });

    test(`a guest sees the person only at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${DRAFT}?role=guest`);
      const p = line(page);
      await expect(named(page)).toHaveAccessibleName(
        /^Published by Bob Builder, /,
      );
      await expect(page.getByText("Claude Code")).toHaveCount(0);
      await axe(page);
      await noSidewaysScroll(page);
      await shot(page, `p4-guest-${width}-${theme}`);
      // The sheet: the person, and no "See all versions" (a guest can't open Versions).
      await named(page).click();
      await expect(
        page.locator("[data-publisher-sheet] [data-published-by]"),
      ).toHaveText("Published by Bob Builder");
      await expect(
        page.getByRole("button", { name: "See all versions" }),
      ).toHaveCount(0);
      await shot(page, `p4-guest-sheet-${width}-${theme}`);
    });

    test(`a signed-out visitor sees the person only, not a button, at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${LANDING}?mock=signed-out`);
      const p = line(page);
      await expect(named(page)).toHaveAccessibleName(
        /^Published by Ada Lovelace, /,
      );
      await expect(
        page.getByRole("button", { name: /^Published by/ }),
      ).toHaveCount(0);
      await expect(page.getByText("Claude Code")).toHaveCount(0);
      await axe(page);
      await noSidewaysScroll(page);
      await shot(page, `p5-signed-out-${width}-${theme}`);
    });
  }

test("a signed-out visitor never gets an email: with no name the line is hidden", async ({
  page,
}) => {
  const versions = page.waitForResponse((r) =>
    /\/api\/v1\/artifacts\/[^/]+\/versions/.test(r.url()),
  );
  await page.goto(`/a/${LANDING}?mock=signed-out&publisher=noname`);
  await versions;
  await expect(
    page.getByRole("heading", { level: 1, name: "Landing page" }),
  ).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await expect(page.locator("[data-publisher-sheet]")).toHaveCount(0);
  await expect(page.getByText(/ada@example\.com|^ada\b/)).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("@example.com");
});

test("under 960px, the title and the access chip open the same sheet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/a/${DRAFT}`);
  await page.locator("[data-chip-opens-sheet]").click();
  await expect(page.locator("[data-publisher-sheet]")).toBeVisible();
});

test("from 960px the line gives way in steps as the title row tightens", async ({
  page,
}) => {
  // Ada's own page with the asks pill: at 1280 the line is whole; at 1100
  // and 1000 the row is tighter and the line drops parts; the name stays full.
  for (const [width, stages] of [
    [1280, ["0"]],
    [1100, ["1", "2"]],
    [1000, ["2", "3"]],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/a/Cd5fGhJkLm6nPqRs?mock=deciders");
    const p = line(page);
    await expect(named(page)).toHaveAccessibleName(
      /^Published by Claude Code, your agent, /,
    );
    await expect
      .poll(async () => p.getAttribute("data-publisher-stage"))
      .toMatch(new RegExp(`^(${stages.join("|")})$`));
    await noSidewaysScroll(page);
    await shot(page, `p6-tight-${width}`);
  }
});

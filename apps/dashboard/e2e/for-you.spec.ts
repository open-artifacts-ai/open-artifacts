// #2512 slice 1: the bell and "For you" on mocks (?mock=foryou, PROVISIONAL contract),
// at 1280 light: axe, no sideways scroll, Later once, an ask answered in the panel.
// The rest moved to test/for-you.test.tsx (#2711). FOR_YOU_SHOTS_DIR picks where the PNGs go (none when unset).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.FOR_YOU_SHOTS_DIR;

/** Every transition and animation has finished (axe reads blended colors mid-way). */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

async function axe(page: Page) {
  // Not a hover state: the pointer rests off the panel.
  await page.mouse.move(0, 0);
  await settled(page);
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
          nodes: { target: string[]; failureSummary?: string }[];
        }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => `${n.target.join(" ")} (${n.failureSummary ?? ""})`)
            .slice(0, 4)
            .join(" | ")}`,
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

const bell = (page: Page) => page.locator("[data-for-you-bell]");
const panel = (page: Page) =>
  page
    .getByRole("dialog", { name: "For you" })
    .or(page.locator("[data-for-you]"));

async function start(
  page: Page,
  width: number,
  theme: "light" | "dark",
  variant?: string,
) {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/?mock=foryou${variant ? `&foryou=${variant}` : ""}`);
  await expect(bell(page)).toBeVisible();
  if (OUT) mkdirSync(OUT, { recursive: true });
  return async (name: string) => {
    if (!OUT) return;
    await settled(page);
    await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png` });
  };
}

const width = 1280;
const theme = "light";
test("mixed, Later and an answered ask at 1280 light", {
  tag: "@smoke",
}, async ({ page }) => {
  const shot = await start(page, width, theme);
  await expect(bell(page)).toHaveAccessibleName("For you, 2 need you");
  await expect(page.locator("[data-bell-count]")).toHaveText("2");
  await expect(page.locator("[data-bell-dot]")).toHaveCount(0);
  await shot("1-bell-2");
  await bell(page).click();
  const p = panel(page).first();
  await expect(
    p.getByText("Ship the landing with the waitlist?"),
  ).toBeVisible();
  // The server's order: the waiting ask, then the mention.
  const rows = p.locator("[data-for-you-item][data-level=needs_you]");
  await expect(rows.first()).toContainText("waiting 4 min");
  await expect(rows.nth(1)).toContainText("Sam Rivera mentioned you");
  // #2570: the comment's quote on the mention row.
  await expect(rows.nth(1)).toContainText(
    '"Can you check the yearly numbers?" · on "Pricing table"',
  );
  await expect(bell(page)).toHaveAttribute("data-state", "open");
  await axe(page);
  await noSidewaysScroll(page);
  await shot("2-open-mixed");

  // Later, once: the mention folds into "Later (1)" and the bell drops to 1.
  await rows.nth(1).getByRole("button", { name: "Later" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "In an hour" }),
  ).toBeVisible();
  await shot("3-later-menu");
  await menu.getByRole("menuitem", { name: "Tomorrow morning" }).click();
  await expect(p.getByText("Later (1)")).toBeVisible();
  await expect(p.getByText("Back tomorrow at 8:00")).toBeVisible();
  await expect(bell(page)).toHaveAttribute(
    "aria-label",
    "For you, 1 needs you",
  );
  await shot("4-after-later");

  // The ask opens as its full card; answering removes the row.
  await p
    .getByRole("button", { name: "Ship the landing with the waitlist?" })
    .click();
  await expect(
    p.getByRole("button", { name: "For you", exact: true }),
  ).toBeFocused();
  await expect(p.getByRole("link", { name: "Open the page" })).toHaveAttribute(
    "href",
    /\/a\/Cd5fGhJkLm6nPqRs\?thread=fyAskThread1$/,
  );
  await expect(p.getByText("OA Manager agent asks you")).toBeVisible();
  await expect(
    p.getByText("It goes live today; the bus section follows."),
  ).toBeVisible();
  await axe(page);
  await noSidewaysScroll(page);
  await shot("5-opened-ask");
  await p.getByRole("button", { name: /Yes, ship it/ }).click();
  await expect(p.getByText("Nothing is waiting on you.")).toBeVisible();
  await expect(
    p.locator('[data-for-you-item="ask:fyAskComment1"]'),
  ).toHaveCount(0);
  // Focus moves to the next row, never <body>.
  await expect(page.locator(":focus")).toHaveAccessibleName(
    /^OA Design replied\s*, unread$/,
  );
  // Nothing needs you now: the unread update lights the dot instead.
  await expect(bell(page)).toHaveAttribute(
    "aria-label",
    "For you, new updates",
  );
  await expect(page.locator("[data-bell-dot]")).toBeVisible();
});

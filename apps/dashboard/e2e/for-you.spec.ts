// #2512 slice 1: the bell and "For you" on mocks (?mock=foryou, PROVISIONAL contract),
// at 1280 and 390, light and dark: axe, no sideways scroll, Later once, an ask answered
// in the panel. FOR_YOU_SHOTS_DIR picks where the PNGs go (none when unset).
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

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`mixed, Later and an answered ask at ${width} ${theme}`, async ({
      page,
    }) => {
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
      // Longest wait first: the waiting ask, then the machine.
      const rows = p.locator("[data-for-you-item][data-level=needs_you]");
      await expect(rows.first()).toContainText("waiting 4 min");
      await expect(rows.nth(1)).toContainText("Approve this machine");
      if (width === 390) {
        // A full screen, rows at least 56px tall.
        const box = await p.boundingBox();
        expect(box?.width).toBe(390);
        expect(box?.height).toBe(900);
        for (const h of await page
          .locator("[data-for-you-item]")
          .evaluateAll((els) =>
            els.map((e) => e.getBoundingClientRect().height),
          ))
          expect(h).toBeGreaterThanOrEqual(56);
        await expect(p.getByRole("button", { name: "Close" })).toBeVisible();
      }
      await expect(bell(page)).toHaveAttribute("data-state", "open");
      await axe(page);
      await noSidewaysScroll(page);
      await shot("2-open-mixed");

      // Later, once: the machine folds into "Later (1)" and the bell drops to 1.
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
      await expect(
        p.getByRole("link", { name: "Open the page" }),
      ).toHaveAttribute("href", /\/a\/Cd5fGhJkLm6nPqRs\?thread=fyAskThread1$/);
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
      // Nothing needs you now: the unread update lights the dot instead.
      await expect(bell(page)).toHaveAttribute(
        "aria-label",
        "For you, new updates",
      );
      await expect(page.locator("[data-bell-dot]")).toBeVisible();
    });

    test(`nothing needs you, and first time at ${width} ${theme}`, async ({
      page,
    }) => {
      const shot = await start(page, width, theme, "calm");
      await expect(bell(page)).toHaveAccessibleName("For you, new updates");
      await expect(page.locator("[data-bell-count]")).toHaveCount(0);
      await shot("6-bell-dot");
      await bell(page).click();
      const p = panel(page).first();
      await expect(p.getByText("Nothing is waiting on you.")).toBeVisible();
      await expect(p.getByText(/^6 updates since 22:00/)).toBeVisible();
      await axe(page);
      await noSidewaysScroll(page);
      await shot("7-open-nothing-needs-you");
      await p.getByRole("button", { name: "Show them" }).click();
      // The contract can't fold rows: Show them marks the summary read, and it goes.
      await expect(p.getByText("While you were away")).toHaveCount(0);

      await page.goto("/?mock=foryou&foryou=empty");
      await expect(bell(page)).toHaveAccessibleName("For you");
      await expect(
        page.locator("[data-bell-count], [data-bell-dot]"),
      ).toHaveCount(0);
      await shot("8-bell-quiet");
      await bell(page).click();
      await expect(
        panel(page).first().getByText("You're all caught up."),
      ).toBeVisible();
      await axe(page);
      await shot("9-open-first-time");
    });

    test(`back from later at ${width} ${theme}`, async ({ page }) => {
      const shot = await start(page, width, theme, "back");
      await expect(bell(page)).toHaveAccessibleName("For you, 1 needs you");
      await bell(page).click();
      const row = panel(page)
        .first()
        .locator('[data-for-you-item="itm:machine1"]');
      await expect(row.getByText("Back from later")).toBeVisible();
      await expect(row.getByRole("link", { name: "Review" })).toBeVisible();
      // Put off once: no Later this time.
      await expect(row.getByRole("button", { name: "Later" })).toHaveCount(0);
      await axe(page);
      await noSidewaysScroll(page);
      await shot("10-back-from-later");
    });
  }

test("an update's menu: mark as read, stop following, mute", async ({
  page,
}) => {
  await start(page, 1280, "light");
  await bell(page).click();
  const p = panel(page).first();
  const row = p.locator('[data-for-you-item="itm:reply1"]');
  await expect(row.locator("[data-unread-dot]")).toBeVisible();
  await row.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Mark as read",
    "Stop following this page",
    "Mute OA Design",
  ]);
  await menu.getByRole("menuitem", { name: "Mark as read" }).click();
  await expect(row.locator("[data-unread-dot]")).toHaveCount(0);
  // Nothing unread is left: the Updates header shows its count.
  await expect(p.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
  // A mute stops push only: the row stays, with a quiet confirmation.
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mute OA Design" }).click();
  await expect(page.getByText("Muted OA Design.")).toBeVisible();
  await expect(row).toBeVisible();
});

test("Settings goes to Settings › Notifications; a page row opens its page", async ({
  page,
}) => {
  await start(page, 1280, "light");
  await bell(page).click();
  await panel(page).first().getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await expect(page.locator("[data-for-you]")).toHaveCount(0);
  await bell(page).click();
  await panel(page)
    .first()
    .getByRole("link", { name: /Sam decided: Yearly first/ })
    .click();
  await expect(page).toHaveURL(/\/a\/De6gHjKmNp7qRsTu$/);
});

test("no bell on a server without For you", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
  await expect(bell(page)).toHaveCount(0);
});

// Design drew the bell on every screen: the viewer's title bar has it too.
for (const width of [1280, 760, 390])
  for (const theme of ["light", "dark"] as const)
    test(`the viewer's bar at ${width} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/a/De6gHjKmNp7qRsTu?mock=foryou");
      await expect(bell(page)).toHaveAccessibleName("For you, 2 need you");
      const bar = page.locator(".oa-vt");
      // The bell sits in the bar's last row, inside it.
      const [b, r] = await Promise.all([
        bell(page).boundingBox(),
        bar.boundingBox(),
      ]);
      expect(b && r && b.x + b.width <= r.x + r.width).toBe(true);
      if (width > 600) {
        // One row over 600px: the bell sits on the title's line, once the bar
        // has its final contents (the version label and fonts load after it shows).
        const centre = async (sel: string) => {
          const x = await page.locator(sel).boundingBox();
          return (x?.y ?? 0) + (x?.height ?? 0) / 2;
        };
        await expect
          .poll(async () =>
            Math.abs(
              (await centre("[data-for-you-bell]")) -
                (await centre(".oa-vt h1")),
            ),
          )
          .toBeLessThan(4);
      }
      await noSidewaysScroll(page);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await settled(page);
        await page.screenshot({
          path: `${OUT}/11-viewer-bar-${width}-${theme}.png`,
          clip: { x: 0, y: 0, width, height: 160 },
        });
      }
      await bell(page).click();
      await expect(
        panel(page).first().getByText("Ship the landing with the waitlist?"),
      ).toBeVisible();
      await axe(page);
      await noSidewaysScroll(page);
      if (OUT)
        await page.screenshot({
          path: `${OUT}/12-viewer-open-${width}-${theme}.png`,
        });
    });

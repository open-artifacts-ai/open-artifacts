// #2512 slice 2: Settings › Notifications for For you on mocks (?mock=foryou), at 1280
// and 390, light and dark: axe, no sideways scroll, saves, unmute, the browser stub.
// FOR_YOU_SHOTS_DIR picks where the PNGs go (none when unset).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.FOR_YOU_SHOTS_DIR;

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

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`notification settings at ${width} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/settings/notifications?mock=foryou");
      const levels = page.locator("[data-notification-levels]");
      await expect(levels).toBeVisible();
      await expect(levels.getByRole("columnheader")).toHaveText([
        "In the app",
        "This browser",
      ]);
      await expect(
        page.getByRole("switch", { name: "Needs you in this browser" }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(page.getByText(/^On for \w+ on this \w+$/)).toBeVisible();
      await expect(
        page.getByRole("switch", { name: "Updates in this browser" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("combobox", { name: "Quiet hours start" }),
      ).toHaveText("22:00");
      await expect(
        page.getByRole("combobox", { name: "Quiet hours end" }),
      ).toHaveText("07:30");
      await expect(
        page.getByRole("combobox", { name: "Interrupt me for" }),
      ).toHaveText("Waiting asks and approvals");
      await expect(
        page.getByRole("combobox", { name: "On lock screens" }),
      ).toHaveText("Hide details");
      const muted = page.getByRole("region", { name: "Muted" });
      await expect(muted.getByRole("listitem")).toHaveCount(2);
      // Today's email switch stays.
      await expect(
        page.getByRole("region", { name: "Notifications", exact: true }),
      ).toBeVisible();
      await axe(page);
      await noSidewaysScroll(page);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await settled(page);
        await page.screenshot({
          path: `${OUT}/s1-settings-${width}-${theme}.png`,
          fullPage: true,
        });
      }

      // A save: Every ask put to me.
      const put = page.waitForRequest(
        (r) =>
          r.method() === "PUT" && r.url().includes("/me/notification-prefs"),
      );
      await page.getByRole("combobox", { name: "Interrupt me for" }).click();
      await page.getByRole("option", { name: "Every ask put to me" }).click();
      const body = (await put).postDataJSON();
      expect(body.browserAllAsks).toBe(true);
      expect(body.timeZone).toBe(
        await page.evaluate(
          () => Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      );

      // Quiet hours off: the times can't change.
      await page.getByRole("switch", { name: "Quiet hours" }).click();
      await expect(
        page.getByRole("combobox", { name: "Quiet hours start" }),
      ).toBeDisabled();

      // Unmute.
      await muted.getByRole("button", { name: "Unmute OA Polish" }).click();
      await expect(muted.getByRole("listitem")).toHaveCount(1);

      // The browser switch is slice 3: it says so and stays as it was.
      await page
        .getByRole("switch", { name: "Needs you in this browser" })
        .click();
      await expect(
        page.getByText("Browser notifications are coming soon."),
      ).toBeVisible();
      await expect(
        page.getByRole("switch", { name: "Needs you in this browser" }),
      ).toHaveAttribute("aria-checked", "true");
      if (OUT) {
        await settled(page);
        await page.screenshot({
          path: `${OUT}/s2-settings-changed-${width}-${theme}.png`,
          fullPage: true,
        });
      }
    });

test("no For you settings on a server without it", async ({ page }) => {
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("region", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-notification-levels]")).toHaveCount(0);
});

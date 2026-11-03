// #1187: axe over every admin page on the mock, at 1280 and 390, light and
// dark. Same setup and rules as the dashboard's m1-a11y.spec.ts: axe-core
// from @oa/ui, default rules, serious and critical violations fail.
import { createRequire } from "node:module";
import { FIXTURE_IDS } from "@oa/shared/provisioning/fixtures";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const ROUTES = [
  "/installs",
  `/installs/${FIXTURE_IDS.leo}`,
  `/jobs/${FIXTURE_IDS.jobLeo}`,
  "/installs/new",
  "/installs/new?mock=test-admin",
  "/audit",
  "/audit?mock=test-admin",
  "/tokens",
  "/no-access",
  "/sign-in",
  "/sign-in?error=expired",
];

/**
 * Waits until every CSS transition and animation has finished: switching
 * data-theme starts color transitions, and axe measuring mid-way reads
 * blended colors and fails contrast.
 */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

const open = async (page: Page, path: string, theme: string, w: number) => {
  await page.setViewportSize({ width: w, height: 800 });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    (t) => document.documentElement.setAttribute("data-theme", t),
    theme,
  );
  await settled(page);
};

/** Serious and critical axe violations on the current page. */
export const axeViolations = async (page: Page) => {
  await page.addScriptTag({ path: AXE });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: { id: string; impact: string; nodes: { target: string[] }[] }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => n.target.join(" "))
            .slice(0, 4)
            .join(" | ")}`,
      );
  });
};

for (const path of ROUTES)
  for (const theme of ["light", "dark"])
    for (const w of [1280, 390])
      test(`axe ${path} ${theme} ${w}`, async ({ page }) => {
        await open(page, path, theme, w);
        const v = await axeViolations(page);
        expect(v, v.join("\n")).toEqual([]);
      });

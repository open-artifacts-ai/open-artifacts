import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

// One compact sweep: list, welcome, viewer, sharing panel, and the settings
// Login and Directory pages, light, 1280 wide. Serious and critical only.
const SCREENS = [
  "/",
  "/?mock=welcome",
  "/a/Cd5fGhJkLm6nPqRs",
  "/a/Ef7hJkLmNp8qRsTv?panel=open&tab=share",
  "/settings/login?hosted=1",
  "/settings/directory?hosted=1",
];

test("axe smoke: the main screens have no serious violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const found: string[] = [];
  for (const path of SCREENS) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== "running"),
    );
    await page.addScriptTag({ path: AXE });
    const v = await page.evaluate(async () => {
      // @ts-expect-error injected
      const r = await axe.run(document, { resultTypes: ["violations"] });
      return r.violations
        .filter(
          (x: { impact: string }) =>
            x.impact === "serious" || x.impact === "critical",
        )
        .map(
          (x: { id: string; nodes: { target: string[] }[] }) =>
            `${x.id}: ${x.nodes
              .map((n) => n.target.join(" "))
              .slice(0, 4)
              .join(" | ")}`,
        );
    });
    for (const m of v) found.push(`${path} ${m}`);
  }
  expect(found, found.join("\n")).toEqual([]);
});

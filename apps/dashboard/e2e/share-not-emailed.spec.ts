// #2590 / #2620: a share over today's limit for new outside
// addresses is saved, and the notice says so in OA Product's words. Mocked
// with ?notEmailed=. At 1280 and 390, light and dark, with axe and no
// sideways scroll. Writes PNGs to SHOTS_DIR when set.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
async function axe(page: Page) {
  await page.mouse.move(0, 0);
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    // @ts-expect-error injected
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map((x: { id: string }) => x.id);
  });
  expect(v).toEqual([]);
}

const LINES = {
  member_limit:
    /We didn't email them: you've reached today's limit of 20 new people outside .+\. Copy the link and send it yourself\./,
  instance_limit:
    /We didn't email them: .+ has reached today's limit for new people outside\. Copy the link and send it yourself\./,
} as const;

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      for (const reason of ["member_limit", "instance_limit"] as const)
        test(`${reason}: saved, and the notice says why no email went`, async ({
          page,
        }, info) => {
          await page.goto(
            `/a/${LANDING}?hosted=1&panel=open&tab=share&notEmailed=${reason}`,
          );
          const box = page.getByRole("textbox", { name: "Email" });
          await box.fill("sam@gmail.com");
          await page.getByRole("button", { name: "Add" }).click();
          const sent = page.locator("[data-share-sent]");
          await expect(sent).toHaveText(LINES[reason]);
          await expect(page.getByLabel("Artifact link")).toBeVisible();
          await axe(page);
          const r = await page.evaluate(() => ({
            sw: (document.scrollingElement as Element).scrollWidth,
            iw: innerWidth,
          }));
          expect(r.sw).toBeLessThanOrEqual(r.iw);
          await settle(page);
          const name = `n-${reason}-${width}-${scheme}.png`;
          await page.screenshot({
            path: DIR ? `${DIR}/${name}` : info.outputPath(name),
          });
        });
    });

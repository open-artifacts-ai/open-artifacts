// #2590: a share that opens only for a Google account (workspace_only,
// PROVISIONAL, mocked with &share=workspace-only): a note with the link,
// the saved row keeps its picker. The owner also sees where to turn on
// codes. At 1280 and 390, light and dark, with axe. PNGs to SHOTS_DIR.
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

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      test("the note, the Settings line, the link, and the saved row", async ({
        page,
      }, info) => {
        await page.goto(
          `/a/${LANDING}?hosted=1&share=workspace-only&panel=open&tab=share`,
        );
        await page
          .getByRole("textbox", { name: "Email" })
          .fill("sam@partner.org");
        await page.getByRole("button", { name: "Add" }).click();
        await expect(
          page.getByText(
            "sam@partner.org can open this only if that address is a Google account. If it isn't, share with their Gmail or Google Workspace address.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Settings, Login" }),
        ).toBeVisible();
        await expect(
          page.getByRole("combobox", { name: "Role for sam@partner.org" }),
        ).toHaveText("Can comment");
        await settle(page);
        const name = `share-workspace-only-${scheme}-${width}.png`;
        await page.screenshot({
          path: DIR ? `${DIR}/${name}` : info.outputPath(name),
        });
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
      });
    });

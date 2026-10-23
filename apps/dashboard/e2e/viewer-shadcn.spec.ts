// #184: the viewer and upload on shadcn Button, Dialog (Modal), Input, Select
// and Avatar. 1280 and 390, light and dark: title bar, Details, Share, the
// Restore and Delete dialogs, the upload buttons and dialog; axe, and each
// dialog traps focus, closes on Escape and gives focus back.
import { createRequire } from "node:module";
import { expect, type Locator, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
/** Landing page: owned, two versions, shared with Bob. */
const ID = "Cd5fGhJkLm6nPqRs";

const axeRun = async (page: Page): Promise<string[]> => {
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
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
const clean = async (page: Page) => {
  await settle(page);
  const v = await axeRun(page);
  expect(v, v.join("\n")).toEqual([]);
};

/** Tab and Shift+Tab stay inside the dialog; Escape closes it and focus goes back. */
const trapped = async (page: Page, name: string, opener: () => Locator) => {
  const d = page.getByRole("dialog", { name });
  await expect(d).toBeVisible();
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(
      await d.evaluate((el) => el.contains(document.activeElement)),
      `${key} left the dialog`,
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(opener()).toBeFocused();
};

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`shadcn ${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });
      const shot = (page: Page, name: string, path: (n: string) => string) =>
        page.screenshot({
          path: path(`shadcn-${name}-${scheme}-${width}.png`),
        });

      test("Details: form, Move, Delete and its dialog", async ({
        page,
      }, info) => {
        await page.goto(`/a/${ID}?panel=open&tab=details`);
        const title = page.getByRole("textbox", { name: "Title" });
        await expect(title).toBeVisible();
        await title.fill("Landing page, renamed");
        await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
        await clean(page);
        await shot(page, "details", (n) => info.outputPath(n));
        const del = page.getByRole("button", { name: "Delete artifact" });
        await del.click();
        await expect(
          page.getByRole("dialog", { name: "Delete artifact?" }),
        ).toContainText("will be recoverable for 30 days.");
        await clean(page);
        await shot(page, "details-delete", (n) => info.outputPath(n));
        await trapped(page, "Delete artifact?", () => del);
      });

      test("title bar Delete, Share avatars, Restore dialog", async ({
        page,
      }, info) => {
        await page.goto(`/a/${ID}?panel=open&tab=share`);
        await expect(
          page.getByRole("img", { name: "bob@example.com" }),
        ).toHaveText("BO");
        await clean(page);
        await shot(page, "share", (n) => info.outputPath(n));

        await page.goto(`/a/${ID}/v/1?panel=open&tab=versions`);
        const restore = page.getByRole("button", { name: "Restore" });
        await restore.click();
        await expect(
          page.getByRole("dialog", { name: "Restore v1?" }),
        ).toBeVisible();
        await clean(page);
        await shot(page, "restore", (n) => info.outputPath(n));
        await trapped(page, "Restore v1?", () => restore);

        await page.goto(`/a/${ID}`);
        const more = page.getByRole("button", { name: "More actions" });
        await more.click();
        await page.getByRole("menuitem", { name: "Delete" }).click();
        await expect(
          page.getByRole("dialog", { name: "Delete artifact?" }),
        ).toBeVisible();
        await clean(page);
        await shot(page, "titlebar-delete", (n) => info.outputPath(n));
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      });

      test("upload buttons and the Create artifact dialog", async ({
        page,
      }, info) => {
        await page.goto("/");
        const files = page.getByRole("button", { name: "Upload files" });
        await expect(files).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Upload folder" }),
        ).toBeVisible();
        await shot(page, "upload-buttons", (n) => info.outputPath(n));
        await page.getByTestId("upload-files").setInputFiles([
          {
            name: "a.html",
            mimeType: "text/html",
            buffer: Buffer.from("<h1>a"),
          },
          {
            name: "b.html",
            mimeType: "text/html",
            buffer: Buffer.from("<h1>b"),
          },
        ]);
        const d = page.getByRole("dialog", { name: "Create artifact" });
        await expect(d).toContainText("2 files selected");
        const entry = d.getByRole("combobox", { name: "Entry file" });
        await expect(entry).toHaveText("Choose the file to open first");
        await expect(d.getByRole("button", { name: "Create" })).toBeDisabled();
        await entry.click();
        await page.getByRole("option", { name: "b.html" }).click();
        await expect(entry).toHaveText("b.html");
        await expect(d.getByRole("textbox", { name: "Title" })).toBeVisible();
        await expect(d.getByRole("button", { name: "Create" })).toBeEnabled();
        await clean(page);
        await shot(page, "upload-dialog", (n) => info.outputPath(n));
        await page.keyboard.press("Escape");
        await expect(d).toHaveCount(0);
      });
    });

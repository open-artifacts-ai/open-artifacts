// #1100: a doc's versions. Save version (a named save), the automatic
// versions' labels, an agent's face on its rows and restore through the room
// (PROVISIONAL routes, mocked), at 1280 and 390, light and dark, with axe.
// Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { expect, type Page, type Request, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (x) =>
          x.playState !== "running" ||
          x.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
const shot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await settle(page);
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
  });
};
async function axe(page: Page) {
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

const open = async (
  page: Page,
  info: Parameters<typeof startRoom>[0],
  mock = "doc",
) => {
  room = await startRoom(info, page, ["--fakes"]);
  // The mock content host: an older version as the room rendered it.
  await page.context().route("https://content.example.com/**", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta name="color-scheme" content="light dark"><body style="font:16px/1.6 system-ui;max-width:640px;margin:32px auto;padding:0 16px"><h1>Landing page</h1><h2>Launch plan</h2><p>We ship the new landing page on <b>Thursday</b>. The plan has two parts: copy and design.</p></body>`,
    }),
  );
  await page.goto(
    `/a/${LANDING}?mock=${mock}&versions=doc&panel=open&tab=versions`,
  );
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.getByRole("list", { name: "Versions" })).toBeVisible();
};
const rows = (page: Page) =>
  page.getByRole("list", { name: "Versions" }).locator("li");
const row = (page: Page, v: number) => page.locator(`[data-version="${v}"]`);

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      test("the doc's versions: labels, agent faces, Save version", async ({
        page,
      }, info) => {
        await open(page, info);
        await expect(rows(page)).toHaveCount(6);
        // How each was saved: a restore, automatic ones, names.
        await expect(row(page, 6)).toContainText("Restored v2");
        await expect(row(page, 5)).toContainText("Saved automatically");
        await expect(row(page, 4)).toContainText("Saved automatically");
        await expect(row(page, 3)).toContainText("After review");
        await expect(row(page, 2)).toContainText("Saved automatically");
        await expect(row(page, 1)).toContainText("First draft");
        // An agent's version shows the agent's face (AuthorFace's tile).
        for (const v of [5, 1])
          await expect(
            row(page, v).locator('[data-avatar="agent"][data-animal="duck"]'),
          ).toBeVisible();
        await expect(row(page, 3).locator('[data-avatar="agent"]')).toHaveCount(
          0,
        );
        // The box: the mockup's words.
        const name = page.getByRole("textbox", { name: "Version name" });
        await expect(name).toHaveAttribute(
          "placeholder",
          "Name this version, for example: Before launch",
        );
        await expect(
          page.getByText("Keeps the doc as it is now."),
        ).toBeVisible();
        await shot(page, info, `doc-versions-${scheme}-${width}.png`);
        await axe(page);
        // A named save.
        const saved = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" &&
            r.url().endsWith(`/api/v1/artifacts/${LANDING}/doc/versions`),
        );
        await name.fill("Before launch");
        await page.getByRole("button", { name: "Save version" }).click();
        expect((await saved).postDataJSON()).toEqual({ name: "Before launch" });
        await expect(
          page.getByText('Saved "Before launch" as v7.'),
        ).toBeVisible();
        await expect(row(page, 7)).toContainText("Before launch");
        await expect(name).toHaveValue("");
        // No name: the server's "Version n".
        const unnamed = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" && r.url().endsWith("/doc/versions"),
        );
        await page.getByRole("button", { name: "Save version" }).click();
        expect((await unnamed).postDataJSON()).toEqual({});
        await expect(page.getByText('Saved "Version 8" as v8.')).toBeVisible();
        await expect(row(page, 8)).toContainText("Version 8");
      });

      test("restore goes through the room, then back to the live doc", async ({
        page,
      }, info) => {
        await open(page, info);
        await row(page, 3).click();
        // The older version shows what was saved, not the live editor.
        await expect(page).toHaveURL(new RegExp(`/a/${LANDING}/v/3`));
        await expect(page.locator(".ProseMirror")).toHaveCount(0);
        await shot(page, info, `doc-versions-old-${scheme}-${width}.png`);
        const restore = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" &&
            r
              .url()
              .endsWith(`/api/v1/artifacts/${LANDING}/doc/versions/3/restore`),
        );
        await page
          .getByRole("button", { name: "Restore", exact: true })
          .click();
        await restore;
        await expect(
          page.getByText(
            "Restored v3. Nothing is lost: the doc as it was is kept as v6.",
          ),
        ).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/a/${LANDING}(\\?|$)`));
        await expect(page.locator(".ProseMirror")).toBeVisible();
        await expect(row(page, 7)).toContainText("Restored v3");
        await shot(page, info, `doc-versions-restored-${scheme}-${width}.png`);
        await axe(page);
      });

      test("a reader: no Save version, no Restore", async ({ page }, info) => {
        await open(page, info, "doc-readonly");
        await expect(
          page.getByRole("button", { name: "Save version" }),
        ).toHaveCount(0);
        await row(page, 3).click();
        await expect(page).toHaveURL(new RegExp(`/a/${LANDING}/v/3`));
        await expect(
          page.getByRole("button", { name: "Restore", exact: true }),
        ).toHaveCount(0);
      });
    });

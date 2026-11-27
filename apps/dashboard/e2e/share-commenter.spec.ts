// The hosted mocks list example.com as the login domain, so a Gmail address
// is outside. At 1280 and 390, light and dark, with axe. Writes PNGs to
// SHOTS_DIR when set.
import { createRequire } from "node:module";
import { expect, type Page, type Request, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
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

const open = async (page: Page) => {
  await page.goto(`/a/${LANDING}?hosted=1&panel=open&tab=share`);
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
};
const inviteRole = (page: Page) =>
  page.getByRole("combobox", { name: "Invite role" });

for (const [scheme, width] of [["light", 1280]] as const) {
  test.describe(`${scheme} ${width}`, () => {
    test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

    test("member and outside addresses get the same roles, defaulting to Editor", async ({
      page,
    }, info) => {
      await open(page);
      await page
        .getByRole("textbox", { name: "Email" })
        .fill("maya@example.com");
      await expect(inviteRole(page)).toHaveText("Editor");
      await inviteRole(page).click();
      await expect(page.getByRole("option")).toHaveText([
        "Viewer",
        "Commenter",
        "Editor",
      ]);
      await page.keyboard.press("Escape");
      await page.getByRole("textbox", { name: "Email" }).fill("sam@gmail.com");
      await expect(inviteRole(page)).toHaveText("Editor");
      // OA Product's line under an outside address. Email is off here, so
      // codes are too: the Google-only line, beside "We won't email them".
      await expect(
        page.getByText(
          "Outside your team. sam@gmail.com opens this page with their Google account. They see only what you share. Free.",
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "We won't email them about this share. Copy the link and send it yourself.",
        ),
      ).toBeVisible();
      await expect(page.getByText(/a code we email them/)).toHaveCount(0);
      await inviteRole(page).click();
      await expect(page.getByRole("option")).toHaveText([
        "Viewer",
        "Commenter",
        "Editor",
      ]);
      await shot(page, info, `share-commenter-picker-${scheme}-${width}.png`);
      await page.keyboard.press("Escape");
      await shot(page, info, `share-commenter-line-${scheme}-${width}.png`);
      const put = page.waitForRequest(
        (r: Request) => r.method() === "PUT" && r.url().endsWith("/shares"),
      );
      await page.getByRole("button", { name: "Add" }).click();
      expect((await put).postDataJSON()).toEqual({
        email: "sam@gmail.com",
        role: "editor",
      });
      const row = page.getByRole("combobox", {
        name: "Role for sam@gmail.com",
      });
      await expect(row).toHaveText("Editor");
      await row.click();
      await expect(page.getByRole("option")).toHaveText([
        "Viewer",
        "Commenter",
        "Editor",
        "Remove access",
      ]);
      await shot(
        page,
        info,
        `share-commenter-row-picker-${scheme}-${width}.png`,
      );
      // Changing the saved grant sends its corresponding API value.
      const put2 = page.waitForRequest(
        (r: Request) => r.method() === "PUT" && r.url().endsWith("/shares"),
      );
      await page.getByRole("option", { name: "Viewer" }).click();
      expect((await put2).postDataJSON()).toEqual({
        email: "sam@gmail.com",
        role: "viewer",
      });
      await expect(row).toHaveText("Viewer");
      await page
        .getByRole("combobox", { name: "Role for sam@gmail.com" })
        .click();
      await page.getByRole("option", { name: "Commenter" }).click();
      await expect(row).toHaveText("Commenter");
      await shot(page, info, `share-commenter-saved-${scheme}-${width}.png`);
      await axe(page);
    });
  });
}

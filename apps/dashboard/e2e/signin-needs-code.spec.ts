// #2590 G2: after Google turns a guest away, /sign-in?error=needs_code&
// link=1 shows the masked address the server holds (GET /auth/code/link)
// and asks for a code with { link: true }, same-origin; no address ever in
// the URL. A gone link starts over. At 1280 and 390, light and dark, with
// axe. PNGs to SHOTS_DIR when set. PROVISIONAL routes (codeLink.ts).
import { createRequire } from "node:module";
import { expect, type Page, type Request, test } from "@playwright/test";

const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
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

const shoot = async (
  page: Page,
  info: { outputPath(n: string): string },
  name: string,
) => {
  await settle(page);
  await page.screenshot({
    path: DIR ? `${DIR}/${name}` : info.outputPath(name),
  });
};

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 860 } });

      test("(a) needs_code with link=1: the masked address in the note, and a code on request", async ({
        page,
      }, info) => {
        // glink=1 is the mock's stand-in for the oa_glink cookie.
        await page.goto(
          "/sign-in?hosted=1&error=needs_code&link=1&glink=1&next=%2F",
        );
        await expect(
          page.getByText(
            "Google couldn't confirm s***@partner.org. We'll email a code to that address. After that, Google works.",
          ),
        ).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Email" })).toHaveCount(
          0,
        );
        expect(page.url()).not.toContain("partner");
        await shoot(page, info, `signin-needs-code-${scheme}-${width}.png`);
        await axe(page);
        const sent = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" && r.url().endsWith("/auth/code/request"),
        );
        await page.getByRole("button", { name: "Email me a code" }).click();
        const req = await sent;
        // Same-origin, so the cookie goes along; no address in the body.
        expect(new URL(req.url()).origin).toBe(new URL(page.url()).origin);
        expect(req.postDataJSON()).toEqual({ link: true, next: "/" });
        await expect(page.getByRole("textbox", { name: "Code" })).toBeVisible();
      });

      test("(a) with codes off: only what to ask for", async ({
        page,
      }, info) => {
        await page.goto(
          "/sign-in?hosted=google-only&error=needs_code&link=1&glink=1",
        );
        await expect(
          page.getByText(
            "Google couldn't confirm s***@partner.org. Ask the person who shared this page to use your Gmail or Google Workspace address.",
          ),
        ).toBeVisible();
        await expect(page.getByRole("button")).toHaveCount(0);
        await shoot(page, info, `signin-needs-code-off-${scheme}-${width}.png`);
        await axe(page);
      });

      test("(b) no_access from Google: try another account, or a code", async ({
        page,
      }, info) => {
        await page.goto(
          "/sign-in?hosted=1&error=no_access&via=google&next=%2F",
        );
        await expect(
          page.getByText(
            "That Google account doesn't have access. Log in with the account for the address this page was shared with, or get a code at that address.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Try another account" }),
        ).toBeVisible();
        await shoot(page, info, `signin-wrong-account-${scheme}-${width}.png`);
        await axe(page);
        await page.getByRole("button", { name: "Email me a code" }).click();
        await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(
          "",
        );
      });

      test("a link that's gone starts over at sign-in", async ({ page }) => {
        await page.goto("/sign-in?hosted=1&error=needs_code&link=1&next=%2F");
        await expect
          .poll(() => page.evaluate(() => location.search))
          .not.toContain("needs_code");
        await expect(
          page.getByRole("link", { name: "Continue with Google" }),
        ).toBeVisible();
      });
    });

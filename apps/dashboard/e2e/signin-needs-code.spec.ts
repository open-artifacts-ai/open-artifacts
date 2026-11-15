// #2590 G2: after Google turns a guest away, /sign-in?error=needs_code&
// email=<addr> prefills the code form, takes the address out of the URL and
// sends the code same-origin. At 1280 and 390, light and dark, with axe.
// PNGs to SHOTS_DIR when set.
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

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 860 } });
      test("needs_code: the address prefilled, off the URL, and a code on request", async ({
        page,
      }, info) => {
        await page.goto(
          "/sign-in?hosted=1&error=needs_code&email=sam%40partner.org&next=%2F",
        );
        const field = page.getByRole("textbox", { name: "Email" });
        await expect(field).toHaveValue("sam@partner.org");
        await expect(
          page.getByText(
            "We couldn't log you in with Google for this address. We'll email you a code instead.",
          ),
        ).toBeVisible();
        // The address left the URL (and history: replaced, not pushed).
        await expect
          .poll(() => page.evaluate(() => location.search))
          .not.toContain("email");
        expect(page.url()).not.toContain("partner.org");
        await settle(page);
        const name = `signin-needs-code-${scheme}-${width}.png`;
        await page.screenshot({
          path: DIR ? `${DIR}/${name}` : info.outputPath(name),
        });
        await axe(page);
        const sent = page.waitForRequest(
          (r: Request) =>
            r.method() === "POST" && r.url().endsWith("/auth/code/request"),
        );
        await page.getByRole("button", { name: "Email me a code" }).click();
        const req = await sent;
        // Same-origin, so the server's cookie goes along.
        expect(new URL(req.url()).origin).toBe(new URL(page.url()).origin);
        expect(req.postDataJSON()).toMatchObject({ email: "sam@partner.org" });
        await expect(page.getByRole("textbox", { name: "Code" })).toBeVisible();
      });
    });

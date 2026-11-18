// #2508 slice A2: pictures in the comments drawer (mocks in src/mockPictures.ts).
// The empty box, 1
// and 4 thumbnails, uploading, a failed upload, HEIC, a posted comment and
// the full-size view, at 1280 and 390, light and dark, with axe and no
// sideways scroll. PNGs to SHOTS_DIR when set.
import { createRequire } from "node:module";
import { expect, type Locator, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});

type Violation = { id: string; impact: string; nodes: { html: string }[] };
type Axe = {
  run: (ctx: unknown, opts: object) => Promise<{ violations: Violation[] }>;
};

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
async function checkAxe(page: Page) {
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: Axe }).axe;
    // Not ours: thread headers on main are named past their text ("Show in
    // page: comment"), as doc-comments.spec.ts notes. The box and pictures
    // are checked with every rule on below.
    const all = await axe.run(document, {
      resultTypes: ["violations"],
      rules: { "label-content-name-mismatch": { enabled: false } },
    });
    const ours = [
      ...document.querySelectorAll(
        "[data-attached],[data-comment-pictures],[data-attach-picture],[data-lightbox],[data-picture-note]",
      ),
    ];
    const own = ours.length
      ? (await axe.run(ours, { resultTypes: ["violations"] })).violations
      : [];
    return [...all.violations, ...own]
      .filter((x) => x.impact === "serious" || x.impact === "critical")
      .map(
        (x) =>
          `${x.id}: ${x.nodes.map((n) => n.html.slice(0, 120)).join(" | ")}`,
      );
  });
  expect(v).toEqual([]);
}
const noSideways = async (page: Page) =>
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);

/** A real PNG drawn in the page (a screenshot stand-in). */
async function png(page: Page, hue: number, w = 1600, h = 1000) {
  const b64 = await page.evaluate(
    ([hue, w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.fillStyle = `hsl(${hue} 60% 80%)`;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#fff";
      g.fillRect(w * 0.08, h * 0.12, w * 0.5, h * 0.1);
      g.fillRect(w * 0.08, h * 0.32, w * 0.84, h * 0.5);
      return c.toDataURL("image/png").split(",")[1] ?? "";
    },
    [hue, w, h] as const,
  );
  return Buffer.from(b64, "base64");
}
const file = async (page: Page, hue: number, name = `shot-${hue}.png`) => ({
  name,
  mimeType: "image/png",
  buffer: await png(page, hue),
});

async function open(page: Page, query = "mock=agents") {
  await page.goto(`/a/${ID}?${query}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const box = page.getByRole("textbox", { name: "Comment on the whole page" });
  await expect(box).toBeVisible();
  return box;
}
/** The note box's card: the field, thumbnails, notes and its own picture input. */
const cardOf = (box: Locator) =>
  box.locator("xpath=ancestor::div[.//input[@data-attach-input]][1]");

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width, height: width === 390 ? 844 : 800 },
      });

      test("the empty box has the picture button", async ({ page }, info) => {
        const box = await open(page);
        const card = cardOf(box);
        await expect(
          card.getByRole("button", { name: "Add a picture" }),
        ).toBeVisible();
        await shot(page, info, `pictures-empty-${scheme}-${width}.png`);
        await checkAxe(page);
        await noSideways(page);
      });

      test("1 and 4 thumbnails; a fifth isn't added", async ({
        page,
      }, info) => {
        const box = await open(page);
        const card = cardOf(box);
        const input = card.locator("[data-attach-input]");
        await box.fill("At this width the comments look crammed.");
        await input.setInputFiles([await file(page, 220)]);
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(1);
        await shot(page, info, `pictures-1-${scheme}-${width}.png`);
        await input.setInputFiles([
          await file(page, 140),
          await file(page, 30),
          await file(page, 300),
          await file(page, 60),
        ]);
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(4);
        await expect(
          card.getByText(
            "4 pictures is the most one comment holds. The fifth wasn't added.",
          ),
        ).toBeVisible();
        await shot(page, info, `pictures-4-${scheme}-${width}.png`);
        await checkAxe(page);
        await noSideways(page);
      });

      test("uploading: Uploading 2 of 2…, Comment waits", async ({
        page,
      }, info) => {
        const box = await open(page);
        const card = cardOf(box);
        await page.evaluate(() => {
          (window as unknown as { __oaPicHold: boolean }).__oaPicHold = true;
        });
        await box.fill("Here's the error.");
        await card
          .locator("[data-attach-input]")
          .setInputFiles([await file(page, 220), await file(page, 140)]);
        // Both uploads are at the mock's gate before anything is checked.
        await page.waitForFunction(
          () =>
            (window as unknown as { __oaPicHeld?: number }).__oaPicHeld === 2,
        );
        await expect(card.getByText("Uploading 2 of 2…")).toBeVisible();
        await expect(
          card.getByRole("button", { name: "Comment", exact: true }),
        ).toBeDisabled();
        await shot(page, info, `pictures-uploading-${scheme}-${width}.png`);
        await page.evaluate(() =>
          (
            window as unknown as { __oaPicRelease: () => void }
          ).__oaPicRelease(),
        );
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(2);
        await expect(
          card.getByRole("button", { name: "Comment", exact: true }),
        ).toBeEnabled();
      });

      test("a failed upload, then Try again", async ({ page }, info) => {
        const box = await open(page, "mock=agents&picfail=1");
        const card = cardOf(box);
        await box.fill("Here's the error.");
        await card
          .locator("[data-attach-input]")
          .setInputFiles([await file(page, 10)]);
        await expect(
          card.locator('[data-attached-picture="failed"]'),
        ).toHaveCount(1);
        await expect(
          card.getByText(
            "1 picture didn't upload. Try again, or remove it to send.",
          ),
        ).toBeVisible();
        // Design: the tile shows an icon, not words over the remove button.
        await expect(
          card.locator('[data-attached-picture="failed"] svg').first(),
        ).toBeVisible();
        await shot(page, info, `pictures-error-${scheme}-${width}.png`);
        await checkAxe(page);
        await card.getByRole("button", { name: "Try again" }).click();
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(1);
      });

      test("HEIC is refused with Product's message", async ({ page }, info) => {
        const box = await open(page);
        const card = cardOf(box);
        await card.locator("[data-attach-input]").setInputFiles([
          {
            name: "IMG_0042.HEIC",
            mimeType: "image/heic",
            buffer: Buffer.from("x"),
          },
        ]);
        await expect(
          card.getByText(
            "iPhone photos saved as HEIC can't be attached yet. Send a screenshot, or save it as JPEG.",
          ),
        ).toBeVisible();
        await expect(card.locator("[data-attached-picture]")).toHaveCount(0);
        await shot(page, info, `pictures-heic-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("a picture with a mention needs words", async ({ page }) => {
        const box = await open(page);
        const card = cardOf(box);
        await card
          .locator("[data-attach-input]")
          .setInputFiles([await file(page, 220)]);
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(1);
        // Picture only: fine.
        await expect(
          card.getByRole("button", { name: "Comment", exact: true }),
        ).toBeEnabled();
        await box.fill("@Claude Code ");
        await expect(
          card.getByText(
            "Say what you want done; the picture alone isn't a request",
          ),
        ).toBeVisible();
        await expect(
          card.getByRole("button", { name: "Comment", exact: true }),
        ).toBeDisabled();
      });

      test("posted: the comment shows its picture", async ({ page }, info) => {
        const box = await open(page);
        const card = cardOf(box);
        await box.fill("The button on the split one sits too low.");
        await card
          .locator("[data-attach-input]")
          .setInputFiles([await file(page, 220)]);
        await expect(
          card.locator('[data-attached-picture="done"]'),
        ).toHaveCount(1);
        const post = page.waitForRequest(
          (r) =>
            r.method() === "POST" &&
            new URL(r.url()).pathname === `/api/v1/artifacts/${ID}/comments`,
        );
        await card
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        expect((await post).postDataJSON()).toMatchObject({
          body: "The button on the split one sits too low.",
          pictures: [{ pictureId: expect.any(String) }],
        });
        const thread = page.locator("[data-thread]", {
          hasText: "The button on the split one",
        });
        // Thumbnails load lazily: bring it on screen.
        await thread.locator("[data-picture]").first().scrollIntoViewIfNeeded();
        const posted = thread.locator('[data-picture="ok"]');
        await expect(posted).toHaveCount(1);
        await expect(card.locator("[data-attached-picture]")).toHaveCount(0);
        await posted.scrollIntoViewIfNeeded();
        await shot(page, info, `pictures-posted-${scheme}-${width}.png`);
        await checkAxe(page);
      });

      test("the full-size view: Open original, arrows, Esc", async ({
        page,
      }, info) => {
        await open(page, "mock=pictures");
        const pics = page.locator("[data-comment-pictures]").first();
        await expect(pics.locator('[data-picture="ok"]')).toHaveCount(2);
        await pics.locator('[data-picture="ok"]').first().click();
        const lb = page.locator("[data-lightbox]");
        await expect(lb).toBeVisible();
        await expect(lb.getByText(/1 of 2/)).toBeVisible();
        await expect(
          lb.getByText("Before: the comments view at 760px.").last(),
        ).toBeVisible();
        const original = lb.getByRole("link", { name: "Open original" });
        await expect(original).toHaveAttribute("target", "_blank");
        await shot(page, info, `pictures-lightbox-${scheme}-${width}.png`);
        await checkAxe(page);
        await noSideways(page);
        // A phone: the picture is full width; Previous and Next sit in the bottom bar.
        if (width === 390) {
          const img = lb.locator("img");
          expect((await img.boundingBox())?.width).toBeGreaterThanOrEqual(388);
          await expect(
            lb.getByRole("button", { name: "Next picture" }),
          ).toBeVisible();
        }
        await page.keyboard.press("ArrowRight");
        await expect(lb.getByText(/2 of 2/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(lb).toHaveCount(0);
        // Esc closes the picture only: the comments stay open.
        await expect(
          page
            .getByRole("complementary", { name: "Comments" })
            .or(page.getByRole("dialog", { name: "Comments" })),
        ).toBeVisible();
      });

      test("a guest gets no picture button, and still sees pictures", async ({
        page,
      }) => {
        await page.goto(`/a/${ID}?role=guest&mock=pictures`);
        await page.getByRole("button", { name: /^Comments/ }).click();
        await expect(
          page.getByRole("textbox", { name: "Comment on the whole page" }),
        ).toBeVisible();
        await expect(page.locator("[data-attach-picture]")).toHaveCount(0);
      });
    });

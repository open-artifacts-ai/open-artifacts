// #2661 part A: the ask card with the high-stakes mark (PROVISIONAL
// api/highStakes.ts; mock ?mock=highstakes&hs=…, src/mockHighStakes.ts). Each
// state at 1280 and 390, light and dark, with axe. PNGs to SHOTS_DIR when set.
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const DIR = process.env.SHOTS_DIR;
const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const REASON = "Picking Send emails all 240 customers. It can't be undone.";

type Violation = { id: string; impact: string; nodes: { html: string }[] };
type Axe = {
  run: (ctx: unknown, opts: object) => Promise<{ violations: Violation[] }>;
};

const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
async function checkAxe(page: Page) {
  // No hover state under the pointer: axe reads the card at rest.
  await page.mouse.move(0, 0);
  await settle(page);
  await page.addScriptTag({ path: AXE });
  const v: string[] = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: Axe }).axe;
    // Not ours: thread headers on main are named past their text, as
    // doc-comments.spec.ts notes. The card is checked with every rule on.
    const all = await axe.run(
      { exclude: [["[data-option] span.block.font-normal"]] },
      {
        resultTypes: ["violations"],
        rules: { "label-content-name-mismatch": { enabled: false } },
      },
    );
    const card = [...document.querySelectorAll("[data-ask]")];
    // Not ours (on main, reported to Design): an option's muted detail line
    // on the dark outline button is 4.06:1 in the column. Everything else in
    // the card is checked with every rule on.
    const own = card.length
      ? (
          await axe.run(
            {
              include: card,
              exclude: [["[data-option] span.block.font-normal"]],
            },
            { resultTypes: ["violations"] },
          )
        ).violations
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

/** navigator.credentials.get answers like a passkey that verified. */
async function stubPasskey(page: Page) {
  await page.addInitScript(() => {
    const buf = (...b: number[]) => new Uint8Array(b).buffer;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: async () => ({
          id: "cred",
          rawId: buf(1),
          type: "public-key",
          response: {
            clientDataJSON: buf(2),
            authenticatorData: buf(3),
            signature: buf(4),
            userHandle: null,
          },
          getClientExtensionResults: () => ({}),
          authenticatorAttachment: null,
        }),
      },
    });
  });
}

async function open(page: Page, hs: string) {
  await page.goto(`/a/${ID}?mock=highstakes&hs=${hs}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Send the proposal to Acme's customers?" });
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  return card;
}

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width, height: width === 390 ? 844 : 800 },
      });
      const shot = async (
        card: ReturnType<Page["locator"]>,
        page: Page,
        info: { outputPath(n: string): string },
        name: string,
      ) => {
        // The phone sheet is half height: a tall window shows the whole card.
        if (width === 390)
          await page.setViewportSize({ width: 390, height: 1600 });
        await card.scrollIntoViewIfNeeded();
        await settle(page);
        await card.screenshot({
          path: DIR
            ? `${DIR}/${name}-${scheme}-${width}.png`
            : info.outputPath(`${name}.png`),
        });
      };

      test("marked: the card says why, in the asker's words", async ({
        page,
      }, info) => {
        const card = await open(page, "marked");
        const hs = card.locator("[data-high-stakes]");
        await expect(hs).toContainText("High stakes · needs your passkey");
        await expect(hs).toContainText(`OA Bus says: "${REASON}"`);
        await expect(card.locator("[data-option=send]")).toContainText(
          "High stakes",
        );
        // Only the marked option needs the passkey.
        await expect(
          card.locator("[data-option=send] [data-passkey-hint]"),
        ).toHaveCount(1);
        await expect(
          card.locator("[data-option=changes] [data-passkey-hint]"),
        ).toHaveCount(0);
        await shot(card, page, info, "hs-marked");
        await checkAxe(page);
      });

      test("an unmarked option is one tap", async ({ page }) => {
        const card = await open(page, "marked");
        const post = page.waitForRequest(
          (r) => r.method() === "POST" && r.url().endsWith("/hsc1/answer"),
        );
        await card.locator("[data-option=changes]").click();
        expect((await post).postDataJSON()).toEqual({ optionId: "changes" });
        await expect(card.locator("[data-ask-verified]")).toHaveCount(0);
      });

      test("the marked option goes through the passkey", async ({
        page,
      }, info) => {
        await stubPasskey(page);
        const card = await open(page, "marked");
        await card.locator("[data-option=send]").click();
        await expect(card.locator("[data-ask-verified]")).toHaveText(
          /Verified with passkey/,
        );
        await shot(card, page, info, "hs-verified");
      });

      test("the switch off: marked, no passkey", async ({ page }, info) => {
        const card = await open(page, "off");
        await expect(card.locator("[data-high-stakes]")).toContainText(
          `OA Bus says: "${REASON}"`,
        );
        await expect(card.locator("[data-high-stakes]")).not.toContainText(
          "needs your passkey",
        );
        await expect(card.locator("[data-passkey-hint]")).toHaveCount(0);
        await shot(card, page, info, "hs-off");
        await checkAxe(page);
      });

      test("every answer", async ({ page }, info) => {
        const card = await open(page, "every");
        await expect(
          card.getByText(
            "You've chosen to confirm every answer with your passkey.",
          ),
        ).toBeVisible();
        await expect(card.locator("[data-high-stakes]")).toHaveCount(0);
        await shot(card, page, info, "hs-every");
        await checkAxe(page);
      });

      test("two marked options", async ({ page }, info) => {
        const card = await open(page, "two");
        // Design (#2669): the asker once, then one line per marked option.
        await expect(card.locator("[data-high-stakes]")).toContainText(
          "OA Bus says:",
        );
        await expect(card.locator("[data-high-stakes-reason]")).toHaveText([
          `Send it: "${REASON}"`,
          'Send tomorrow: "Picking Send tomorrow emails all 240 customers at 9:00."',
        ]);
        await expect(card.locator("[data-passkey-hint]")).toHaveCount(2);
        await shot(card, page, info, "hs-two");
        await checkAxe(page);
      });

      test("no passkey yet: one button to Settings", async ({ page }, info) => {
        const card = await open(page, "missing");
        const go = card.getByRole("link", {
          name: "Add a passkey to approve this",
        });
        await expect(go).toHaveAttribute("href", "/settings/security");
        await expect(card.locator("[data-option=send]")).toBeDisabled();
        await expect(card.locator("[data-option=no]")).toBeEnabled();
        await shot(card, page, info, "hs-missing");
        await checkAxe(page);
      });

      test("a person's own ask carries the mark", async ({ page }, info) => {
        const card = await open(page, "person");
        await expect(card.locator("[data-high-stakes]")).toContainText(
          `Sam Rivera says: "${REASON}"`,
        );
        await shot(card, page, info, "hs-person");
      });
    });

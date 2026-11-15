// #2590 slice 2: a guest on a shared page (?role=guest; `sharedBy` is PROVISIONAL)
// sees the guest bar, "Get your own" in its menu and, once after their first
// comment, the offer; a guest's home is "Shared with you". At 1280 and 390,
// light and dark, with axe and no sideways scroll. GUEST_SHOTS_DIR saves PNGs.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";

const AXE = createRequire(import.meta.url).resolve("axe-core/axe.min.js", {
  paths: [new URL("../../../packages/ui", import.meta.url).pathname],
});
const OUT = process.env.GUEST_SHOTS_DIR;
const NOTES = "De6gHjKmNp7qRsTu"; // Meeting notes: no comments yet

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

/** `only`: selectors to check (the rest of the page is left out). */
async function axe(page: Page, only?: string[]) {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async (only) => {
    // @ts-expect-error injected
    const res = await axe.run(only ? { include: only } : document, {
      resultTypes: ["violations"],
    });
    return res.violations
      .filter(
        (x: { impact: string }) =>
          x.impact === "serious" || x.impact === "critical",
      )
      .map(
        (x: {
          id: string;
          impact: string;
          nodes: { target: string[]; failureSummary?: string }[];
        }) =>
          `${x.impact} ${x.id}: ${x.nodes
            .map((n) => `${n.target.join(" ")} (${n.failureSummary ?? ""})`)
            .slice(0, 4)
            .join(" | ")}`,
      );
  }, only);
  expect(v, v.join("\n")).toEqual([]);
}

async function noSidewaysScroll(page: Page) {
  const r = await page.evaluate(() => ({
    sw: (document.scrollingElement as Element).scrollWidth,
    iw: innerWidth,
  }));
  expect(r.sw).toBeLessThanOrEqual(r.iw);
}

const shooter =
  (page: Page, width: number, theme: string) => async (name: string) => {
    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    await settled(page);
    await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png` });
  };

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`the guest bar and its menu at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const shot = shooter(page, width, theme);
      await page.goto(`/a/${NOTES}?role=guest`);
      const bar = page.locator("[data-guest-bar]");
      await expect(bar).toContainText(
        "Shared by Ada Lovelace · You're a guest",
      );
      await expect(
        bar.getByRole("link", { name: "Open Artifacts" }),
      ).toHaveAttribute("href", "/");
      // A guest gets the bar, not the breadcrumbs, and no second offer strip.
      await expect(
        page.getByRole("navigation", { name: "Breadcrumb" }),
      ).toHaveCount(0);
      await axe(page);
      await noSidewaysScroll(page);
      await shot("g1-bar");
      await bar.getByRole("button", { name: "Guest menu" }).click();
      const item = page.getByRole("menuitem", { name: "Get your own" });
      await expect(item).toHaveAttribute("href", "https://open-artifacts.com");
      await shot("g2-bar-menu");
    });

    test(`the offer, once after the first comment, at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const shot = shooter(page, width, theme);
      await page.goto(`/a/${NOTES}?role=guest`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const box = page.getByRole("textbox", { name: /Comment on/ }).first();
      await box.fill("Looks good to me.");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      // On a phone the comments are a sheet over the page: the offer sits
      // under the title bar, in view once the sheet closes.
      if (width === 390)
        await page.getByRole("button", { name: "Close comments" }).click();
      const offer = page.getByRole("region", {
        name: "Pages like this, made by your own AI agent",
      });
      await expect(offer).toContainText(
        "Open Artifacts is where people and agents share their work. Free for 30 days.",
      );
      // Self-hosted (no ?hosted): the public site.
      await expect(
        offer.getByRole("link", { name: "Get your own" }),
      ).toHaveAttribute("href", "https://open-artifacts.com");
      // The offer and the bar; the comments panel's own label mismatch
      // (the thread's "Show in page" and faces buttons) predates #2590.
      await axe(page, ["[data-guest-offer]", "[data-guest-bar]"]);
      await noSidewaysScroll(page);
      await shot("g3-offer");
      await offer.getByRole("button", { name: "Not now" }).click();
      await expect(offer).toHaveCount(0);
      // Once: a second comment never brings it back.
      if (width === 390)
        await page.getByRole("button", { name: /^Comments/ }).click();
      await box.fill("One more thing.");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(
        page.locator("[data-comment]").filter({ hasText: "One more thing." }),
      ).toBeVisible();
      await expect(page.locator("[data-guest-offer]")).toHaveCount(0);
    });

    test(`a guest's home is Shared with you at ${width} ${theme}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      const shot = shooter(page, width, theme);
      await page.goto("/?role=guest");
      await expect(page).toHaveURL(/\/shared/);
      await expect(
        page.getByRole("heading", { level: 1, name: "Shared with you" }),
      ).toBeVisible();
      await expect(page.getByRole("tablist")).toHaveCount(0);
      await axe(page);
      await noSidewaysScroll(page);
      await shot("g4-home");
    });
  }

test("no offer for a guest who had commented before", async ({ page }) => {
  // The Landing page already holds a comment of theirs.
  await page.goto("/a/Cd5fGhJkLm6nPqRs?role=guest");
  await page.getByRole("button", { name: /^Comments/ }).click();
  const box = page.getByRole("textbox", { name: /Comment on/ }).first();
  await box.fill("Another note.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(
    page.locator("[data-comment]").filter({ hasText: "Another note." }),
  ).toBeVisible();
  await expect(page.locator("[data-guest-offer]")).toHaveCount(0);
});

test("members keep the breadcrumbs, with no guest bar", async ({ page }) => {
  await page.goto(`/a/${NOTES}`);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toBeVisible();
  await expect(page.locator("[data-guest-bar]")).toHaveCount(0);
});

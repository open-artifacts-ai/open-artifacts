// #2381: the ask card in each decider state. Shots only when DECIDER_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.DECIDER_SHOTS_DIR;

const STATES = [
  ["weigh", "Which pricing table goes on the landing page?"],
  ["decide", "Which hero image goes on the launch post?"],
  ["decided", "Which plan card is shown first?"],
  ["bars", "What do we call the weekly email?"],
  ["takeback", "Monthly or yearly shown first?"],
] as const;

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: decider card states`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      await page.goto(`/a/${ID}?mock=deciders`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const card = (q: string) => page.locator("[data-ask]", { hasText: q });
      // A decided, closed ask is one line until opened.
      await page
        .locator("[data-ask-decided]", { hasText: STATES[2][1] })
        .click();
      for (const [name, q] of STATES) {
        const c = card(q);
        await expect(c).toBeVisible();
        if (OUT) {
          mkdirSync(OUT, { recursive: true });
          await c.screenshot({ path: `${OUT}/${w}-${theme}-${name}.png` });
        }
      }
      // Weigh in: the pick is kept, the card says who decides.
      const weigh = card(STATES[0][1]);
      await expect(weigh.locator("[data-ask-decider]")).toContainText(
        "Maya Chen decides",
      );
      await weigh.getByRole("button", { name: /A: three columns/ }).click();
      await expect(weigh.locator("[data-ask-answer]")).toContainText(
        "Your view is in. Maya Chen decides.",
      );
      await expect(weigh.locator("[data-view-by]")).toHaveCount(2);
      if (OUT)
        await weigh.screenshot({ path: `${OUT}/${w}-${theme}-weighed-in.png` });
      // Decide: becomes the decision with a tick.
      const decide = card(STATES[1][1]);
      await expect(decide.locator("[data-ask-decider]")).toContainText(
        "You decide",
      );
      await decide.getByRole("button", { name: /B: two columns/ }).click();
      await expect(decide.locator("[data-ask-answer]")).toContainText(
        "decided",
      );
      // Take it back.
      const tb = card(STATES[4][1]);
      await expect(tb.locator("[data-ask-decider]")).toContainText(
        "asked Sam Rivera to decide",
      );
      await tb.getByRole("button", { name: "I'll decide this" }).click();
      await expect(tb.locator("[data-ask-decider]")).toContainText(
        "You decide",
      );
      await expect(
        tb.getByRole("button", { name: "I'll decide this" }),
      ).toHaveCount(0);
      // Bars at four or more.
      await expect(card(STATES[3][1]).locator("[data-option-bar]")).toHaveCount(
        3,
      );
      await expect(
        card(STATES[3][1]).locator("[data-ask-tally]"),
      ).toContainText("4 of 5 weighed in");
    });
  }
}

// #2263 shots for Design. Only when PASSKEY_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const OUT = process.env.PASSKEY_SHOTS_DIR;

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: passkey states`, async ({ page }) => {
      test.skip(!OUT, "set PASSKEY_SHOTS_DIR");
      const dir = OUT as string;
      mkdirSync(dir, { recursive: true });
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: 900 });
      let mode = "ok";
      let hang = false;
      await page.addInitScript(() => {
        const w = window as unknown as { __hang?: boolean; __cancel?: boolean };
        const b = (...x: number[]) => new Uint8Array(x).buffer;
        Object.defineProperty(navigator, "credentials", {
          configurable: true,
          value: {
            get: () =>
              w.__hang
                ? new Promise(() => {})
                : w.__cancel
                  ? Promise.reject(new DOMException("x", "NotAllowedError"))
                  : Promise.resolve({
                      id: "c",
                      rawId: b(1),
                      type: "public-key",
                      response: {
                        clientDataJSON: b(2),
                        authenticatorData: b(3),
                        signature: b(4),
                        userHandle: null,
                      },
                      getClientExtensionResults: () => ({}),
                    }),
          },
        });
      });
      const open = async () => {
        await page.goto(`/a/${ID}?mock=asks&passkey=${mode}`);
        await page.getByRole("button", { name: /^Comments/ }).click();
        const card = page
          .locator("[data-ask]")
          .filter({ hasText: "Merge the release PR?" });
        await expect(card).toBeVisible();
        return card;
      };
      const snap = async (
        card: ReturnType<typeof page.locator>,
        name: string,
      ) => card.screenshot({ path: `${dir}/${w}-${theme}-${name}.png` });

      let card = await open();
      await snap(card, "idle");
      hang = true;
      await page.evaluate(() => {
        (window as unknown as { __hang: boolean }).__hang = true;
      });
      await card.locator("[data-option=merge]").click();
      await expect(card.locator("[data-passkey-verifying]")).toBeVisible();
      await snap(card, "verifying");
      void hang;

      card = await open();
      await page.evaluate(() => {
        (window as unknown as { __cancel: boolean }).__cancel = true;
      });
      await card.locator("[data-option=merge]").click();
      await expect(
        card.locator("[data-passkey-error=cancelled]"),
      ).toBeVisible();
      await snap(card, "cancelled");
      await page.evaluate(() => {
        (window as unknown as { __cancel: boolean }).__cancel = false;
      });
      await card.locator("[data-option=merge]").click();
      await expect(card.locator("[data-ask-verified]")).toBeVisible();
      await snap(card, "verified");
      await snap(
        page.locator("[data-ask]").filter({ hasText: "Delete the old build?" }),
        "answered-no-pill",
      );

      mode = "expired";
      card = await open();
      await card.locator("[data-option=merge]").click();
      await expect(card.locator("[data-passkey-error=expired]")).toBeVisible();
      await snap(card, "failed");

      for (const m of ["none", "cooling"]) {
        mode = m;
        card = await open();
        await card.locator("[data-option=merge]").click();
        await expect(
          card.locator(
            `[data-passkey-error=${m === "none" ? "no_passkey" : "cooling"}]`,
          ),
        ).toBeVisible();
        await snap(card, m === "none" ? "no-passkey" : "cooling");
      }
    });
  }
}

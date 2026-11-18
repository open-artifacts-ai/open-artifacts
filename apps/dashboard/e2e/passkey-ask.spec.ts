// #2263: passkey approval on dangerous ask cards, on the mock API.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

/** navigator.credentials.get stub: the first `cancels` calls reject like a dismissed prompt. */
async function stubPasskey(page: Page, cancels = 0) {
  await page.addInitScript((n) => {
    let left = n;
    const buf = (...b: number[]) => new Uint8Array(b).buffer;
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: async () => {
          if (left-- > 0)
            throw new DOMException("dismissed", "NotAllowedError");
          return {
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
          };
        },
      },
    });
  }, cancels);
}

async function open(page: Page, mode: string) {
  await page.goto(`/a/${ID}?mock=asks&passkey=${mode}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Merge the release PR?" });
  await expect(card).toBeVisible();
  return card;
}

test("idle shows the passkey hint, then verified", async ({ page }) => {
  await stubPasskey(page);
  const card = await open(page, "ok");
  await expect(card.locator("[data-passkey-hint]").first()).toBeVisible();
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-ask-verified]")).toHaveText(
    /Verified with passkey/,
  );
});

test("an ordinary ask is unchanged", { tag: "@smoke" }, async ({ page }) => {
  let called = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: async () => {
          (window as unknown as { __pk: boolean }).__pk = true;
          return null;
        },
      },
    });
  });
  await open(page, "ok");
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Which layout do we ship?" });
  await expect(card.locator("[data-passkey-hint]")).toHaveCount(0);
  await card.locator("[data-option=wide]").click();
  await expect(card.locator("[data-ask-answer]")).toContainText("picked");
  await expect(card.locator("[data-ask-verified]")).toHaveCount(0);
  called = await page.evaluate(
    () => (window as unknown as { __pk?: boolean }).__pk === true,
  );
  expect(called).toBe(false);
});

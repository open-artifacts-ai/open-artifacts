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

test("cancel returns to idle, picking again verifies", async ({ page }) => {
  await stubPasskey(page, 1);
  const card = await open(page, "ok");
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-passkey-error=cancelled]")).toHaveText(
    "Nothing was approved.",
  );
  await expect(card.locator("[data-ask-answer]")).toHaveCount(0);
  await expect(card.locator("[data-option=merge]")).toBeFocused();
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-ask-verified]")).toBeVisible();
});

test("no passkey", async ({ page }) => {
  await stubPasskey(page);
  const card = await open(page, "none");
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-passkey-error=no_passkey]")).toContainText(
    "Add a passkey to approve this here",
  );
  await expect(card.locator("[data-option=merge]")).toBeDisabled();
  await expect(card.locator("[data-ask-answer]")).toHaveCount(0);
});

test("new passkey is cooling", async ({ page }) => {
  await stubPasskey(page);
  const card = await open(page, "cooling");
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-passkey-error=cooling]")).toContainText(
    "Your new passkey can approve from",
  );
});

test("too many tries", async ({ page }) => {
  await stubPasskey(page);
  const card = await open(page, "many");
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-passkey-error=too_many]")).toHaveText(
    "Too many tries. Wait a moment.",
  );
});

test("verified pill shows only when the server marks it", async ({ page }) => {
  await stubPasskey(page);
  await open(page, "ok");
  const pill = page
    .locator("[data-ask]")
    .filter({ hasText: "Deploy to production?" })
    .locator("[data-ask-verified]");
  await expect(pill).toHaveText("Verified with passkey");
  await expect(
    page
      .locator("[data-ask]")
      .filter({ hasText: "Delete the old build?" })
      .locator("[data-ask-verified]"),
  ).toHaveCount(0);
});

test("expired challenge offers another try", async ({ page }) => {
  await stubPasskey(page);
  const card = await open(page, "expired");
  await card.locator("[data-option=merge]").click();
  await expect(card.locator("[data-passkey-error=expired]")).toBeVisible();
  await expect(card.locator("[data-option=merge]")).toBeEnabled();
});

test("an ordinary ask is unchanged", async ({ page }) => {
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

test("Change on a verified answer asks for the passkey again and drops the pill", async ({
  page,
}) => {
  await stubPasskey(page, 0);
  await page.goto(`/a/${ID}?mock=asks&passkey=ok`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Deploy to production?" });
  await expect(card.locator("[data-ask-verified]")).toBeVisible();
  await card.getByRole("button", { name: "Change" }).click();
  // The current option can't be picked again (the server would answer 409 already_answered).
  await expect(card.locator("[data-option=go]")).toBeDisabled();
  await expect(card.locator("[data-option=stop]")).toBeEnabled();
  await page.evaluate(() => {
    (navigator.credentials as unknown as { get: () => Promise<never> }).get =
      () => new Promise(() => {});
  });
  await card.locator("[data-option=stop]").click();
  await expect(card.locator("[data-passkey-verifying]")).toBeVisible();
  // Nothing is shown as answered to "Stop" while the prompt is open.
  await expect(card.locator("[data-ask-answer]")).toHaveCount(0);
  await expect(card.locator("[data-ask-verified]")).toHaveCount(0);
});

test("cancelling a Change brings the old verified answer back", async ({
  page,
}) => {
  await stubPasskey(page, 1);
  await page.goto(`/a/${ID}?mock=asks&passkey=ok`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Deploy to production?" });
  await expect(card.locator("[data-ask-verified]")).toBeVisible();
  await card.getByRole("button", { name: "Change" }).click();
  await card.locator("[data-option=stop]").click();
  await expect(card.locator("[data-passkey-error=cancelled]")).toBeVisible();
  // Never optimistic: the old answer and its pill are still the server's.
  await expect(card.locator("[data-ask-answer]")).toContainText("picked Go");
  await expect(card.locator("[data-ask-verified]")).toBeVisible();
});

test("an ask with no mark whose decider's switches ask for a passkey: the pick runs the passkey flow (#2381)", async ({
  page,
}) => {
  await stubPasskey(page);
  await page.goto(`/a/${ID}?mock=asks&passkey=ok`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Ship the changelog?" });
  await expect(card).toBeVisible();
  await card.locator("[data-option=ship]").click();
  await expect(card.locator("[data-passkey-slot]")).toContainText(
    "This now needs your passkey. Pick again.",
  );
  await expect(card.locator("[data-ask-verified]")).toHaveCount(0);
  await card.locator("[data-option=ship]").click();
  await expect(card.locator("[data-ask-verified]")).toHaveText(
    /Verified with passkey/,
  );
  await expect(card.getByRole("alert")).toHaveCount(0);
});

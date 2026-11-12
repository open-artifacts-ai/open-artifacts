// #2263: Settings › Security at 1280 and 390, light and dark, in the three
// passkey states of the mock API. Shots only when SECURITY_SHOTS_DIR is set.
// A virtual authenticator (CDP) stands in for the device, in these tests only.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const OUT = process.env.SECURITY_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  // The device already holds the member's passkey (the mock's "usable" one
  // answers for it), so it can approve adding another.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from("existing-passkey").toString("base64"),
      isResidentCredential: true,
      rpId: "localhost",
      privateKey: privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
      userHandle: Buffer.from("member").toString("base64"),
      signCount: 1,
    },
  });
}

const STATES = [
  { mock: "passkey-none", n: "no-passkey" },
  { mock: "passkey-cooling", n: "cooling" },
  { mock: "passkey-usable", n: "usable" },
  { mock: "passkey-pending", n: "pending" },
] as const;

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test.describe(`${scheme} ${width}`, () => {
      test.use({ colorScheme: scheme, viewport: { width, height: 900 } });

      for (const s of STATES)
        test(`${s.n}`, async ({ page }) => {
          await page.goto(`/settings/security?mock=${s.mock}`);
          await expect(
            page.getByRole("heading", { name: "Ask for a passkey to approve" }),
          ).toBeVisible();
          const merge = page.getByRole("switch", { name: "Merge" });
          if (s.n === "no-passkey") {
            await expect(merge).toBeDisabled();
            await expect(
              page.getByText("Add a passkey to use these."),
            ).toBeVisible();
          } else {
            await expect(merge).toBeEnabled();
          }
          await expect(
            page.getByRole("switch", { name: "Run a command" }),
          ).toBeDisabled();
          await expect(
            page.getByText("Always on: this runs code on your computer."),
          ).toBeVisible();
          if (s.n === "cooling")
            await expect(page.getByText(/Can approve from /)).toBeVisible();
          if (s.n === "pending")
            await expect(page.getByText(/Will be removed /)).toBeVisible();
          await shot(page, `${s.n}-${scheme}-${width}`);
        });

      test("back from the sign-in Add asked for", async ({ page }) => {
        await page.addInitScript(() =>
          sessionStorage.setItem(
            "oa.passkey.addAfterReauth",
            String(Date.now()),
          ),
        );
        await page.goto("/settings/security?mock=passkey-none");
        await expect(
          page.getByText(
            "You're signed in again. Add your passkey within 10 minutes.",
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Add a passkey" }),
        ).toBeFocused();
        await shot(page, `reauth-return-${scheme}-${width}`);
      });

      test("add a passkey, then turn a switch off with it", async ({
        page,
      }) => {
        await authenticator(page);
        await page.goto("/settings/security?mock=passkey-usable");
        await expect(page.getByText("MacBook")).toBeVisible();
        await page.getByRole("button", { name: "Add a passkey" }).click();
        // Approved by the existing passkey; creating takes a second click.
        const create = page.getByRole("button", { name: "Create passkey" });
        await expect(create).toBeFocused();
        await shot(page, `add-approved-${scheme}-${width}`);
        await create.click();
        await expect(page.getByText("Passkey", { exact: true })).toBeVisible();
        await shot(page, `added-${scheme}-${width}`);

        const deploy = page.getByRole("switch", { name: "Deploy" });
        await expect(deploy).toBeEnabled();
        await deploy.click();
        await expect(deploy).toHaveAttribute("aria-checked", "false");
        await expect(deploy).toBeFocused();
        await shot(page, `switch-off-${scheme}-${width}`);
        await deploy.click(); // on again: no passkey needed
        await expect(deploy).toHaveAttribute("aria-checked", "true");
      });

      test("remove a passkey with its confirm", async ({ page }) => {
        await authenticator(page);
        await page.goto("/settings/security?mock=passkey-usable");
        await page.getByRole("button", { name: "Add a passkey" }).click();
        await page.getByRole("button", { name: "Create passkey" }).click();
        await expect(page.getByText("Passkey", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Remove MacBook" }).click();
        await expect(page.getByRole("alertdialog")).toBeVisible();
        await shot(page, `remove-confirm-${scheme}-${width}`);
        await page
          .getByRole("alertdialog")
          .getByRole("button", { name: "Remove" })
          .click();
        await expect(page.getByText("MacBook", { exact: true })).toBeHidden();
      });

      test("remove confirm on the re-auth path (no usable passkey)", async ({
        page,
      }) => {
        await page.goto("/settings/security?mock=passkey-cooling");
        await page.getByRole("button", { name: "Remove This laptop" }).click();
        await expect(
          page.getByRole("alertdialog").getByText(/removed after 24 hours/),
        ).toBeVisible();
        await shot(page, `remove-confirm-reauth-${scheme}-${width}`);
      });

      if (width === 390) {
        // The prompt never answers, or is dismissed (a stand-in for the device).
        const stub = (page: Page, how: "hang" | "cancel") =>
          page.addInitScript((h) => {
            navigator.credentials.get = () =>
              h === "hang"
                ? new Promise(() => {})
                : Promise.reject(new DOMException("no", "NotAllowedError"));
          }, how);

        test("switch verifying: the line sits under the switch", async ({
          page,
        }) => {
          await stub(page, "hang");
          await page.goto("/settings/security?mock=passkey-usable");
          const deploy = page.getByRole("switch", { name: "Deploy" });
          await expect(deploy).toBeEnabled();
          await deploy.click();
          await expect(
            page.getByText("Waiting for your passkey…"),
          ).toBeVisible();
          await shot(page, `switch-verifying-${scheme}-390`);
        });

        test("switch error: the line sits under the switch", async ({
          page,
        }) => {
          await stub(page, "cancel");
          await page.goto("/settings/security?mock=passkey-usable");
          const deploy = page.getByRole("switch", { name: "Deploy" });
          await expect(deploy).toBeEnabled();
          await deploy.click();
          await expect(page.getByText("Nothing was changed.")).toBeVisible();
          await shot(page, `switch-error-${scheme}-390`);
        });

        test("remove error: the line sits under the passkey", async ({
          page,
        }) => {
          await stub(page, "cancel");
          await page.goto("/settings/security?mock=passkey-usable");
          await page.getByRole("button", { name: "Remove MacBook" }).click();
          await page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Remove" })
            .click();
          await expect(page.getByText("Nothing was removed.")).toBeVisible();
          await shot(page, `remove-error-${scheme}-390`);
        });
      }
    });

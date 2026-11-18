// #2263: Settings › Security, adding a passkey and turning a switch off with
// it. A virtual authenticator (CDP) stands in for the device, in this test
// only. The other states and flows live in test/settings-security.test.tsx.
import { generateKeyPairSync } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

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

test("add a passkey, then turn a switch off with it", async ({ page }) => {
  await authenticator(page);
  await page.goto("/settings/security?mock=passkey-usable");
  await expect(page.getByText("MacBook")).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  // Approved by the existing passkey; creating takes a second click.
  const create = page.getByRole("button", { name: "Add passkey" });
  await expect(create).toBeFocused();
  await create.click();
  await expect(page.getByText("Passkey", { exact: true })).toBeVisible();

  const deploy = page.getByRole("switch", { name: "Deploy" });
  await expect(deploy).toBeEnabled();
  await deploy.click();
  await expect(deploy).toHaveAttribute("aria-checked", "false");
  await expect(deploy).toBeFocused();
  await deploy.click(); // on again: no passkey needed
  await expect(deploy).toHaveAttribute("aria-checked", "true");
});

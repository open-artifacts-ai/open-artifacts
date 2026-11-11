// #2112: shots of the full-screen strip. SHOTS_DIR gets the PNGs.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const PORT = process.env.OA_E2E_PORT ?? "5199";
const APP = `http://localhost:${PORT}`;
const ATTACKER = `http://127.0.0.1:${PORT}/__attacker`;
const LANDING = "Cd5fGhJkLm6nPqRs";
const POLL = "Gh9kLmNpQrAsTuVx"; // public

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

const ARTIFACT = `<!doctype html><style>body{font:16px system-ui;margin:0;padding:24px}
.tools{position:absolute;top:8px;right:8px;display:flex;gap:6px}
button{font:inherit;padding:4px 10px}</style>
<script>
  const nonce = new URLSearchParams(location.hash.slice(1)).get("oa");
  parent.postMessage({ oa: 1, type: "hello", protocol: 1, kind: "html", nonce }, "*");
</script><div class="tools"><button>Filter</button><button>Export</button></div>
<h1>Q3 pipeline</h1><p>The artifact's own controls sit at its top right corner.</p>`;

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400);
  const body = await page.screenshot();
  await test.info().attach(name, { body, contentType: "image/png" });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}.png`, body);
  }
};

test.beforeEach(async ({ context }) => {
  await context.route("https://content.example.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: ARTIFACT }),
  );
});

const cases = [
  ["1280-light", 1280, 800, "light"],
  ["1280-dark", 1280, 800, "dark"],
  ["390-light", 390, 800, "light"],
  ["390-dark", 390, 800, "dark"],
] as const;

for (const [name, width, height, theme] of cases)
  test(`strip ${name}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height });
    await page.goto(`/a/${LANDING}/full`);
    await expect(page.locator(".oa-fsbar")).toBeVisible();
    await expect(
      page.frameLocator("iframe.oa-vframe").getByText("Q3 pipeline"),
    ).toBeVisible();
    await shot(page, `strip-${name}`);
  });

test("strip, public artifact signed out", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/a/${POLL}/full?mock=signed-out`);
  await expect(page.locator(".oa-fsbar")).toBeVisible();
  await expect(
    page.frameLocator("iframe.oa-vframe").getByText("Q3 pipeline"),
  ).toBeVisible();
  await shot(page, "strip-signed-out");
});

for (const theme of ["light", "dark"] as const)
  test(`strip, embedded in another site (${theme})`, async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await context.route(
      (u) => u.href.startsWith(ATTACKER),
      (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>other site</title><body style="margin:0;background:#eef"><p style="margin:12px">Another site</p><iframe src="${APP}/a/${POLL}/full" style="width:800px;height:500px;border:1px solid #888"></iframe>`,
        }),
    );
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.goto(ATTACKER);
    const app = page.frameLocator("iframe");
    await expect(app.locator(".oa-fsbar")).toBeVisible();
    await expect(
      app.frameLocator("iframe.oa-vframe").getByText("Q3 pipeline"),
    ).toBeVisible();
    await shot(page, `strip-embedded-${theme}`);
  });

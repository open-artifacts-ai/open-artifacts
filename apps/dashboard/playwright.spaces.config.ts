// The dashboard against a real server with hosted spaces on (FEATURES=spaces):
// Members, Departed and Transfer, Spaces settings, Move and Directory, as an
// org admin, a space manager and a space viewer. Its own server (OA_E2E_PORT,
// OA_E2E_FEATURES from the test:e2e:spaces script), so the main real suite
// keeps testing a self-hosted install.
import { defineConfig, devices } from "@playwright/test";
import { APP } from "./e2e/real/fixtures";

if (process.env.OA_E2E_FEATURES !== "spaces")
  throw new Error(
    "playwright.spaces.config.ts: run it with OA_E2E_FEATURES=spaces (pnpm test:e2e:spaces)",
  );

export default defineConfig({
  testDir: "e2e/spaces",
  globalSetup: "./e2e/real/global-setup.ts",
  timeout: 60_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: APP, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

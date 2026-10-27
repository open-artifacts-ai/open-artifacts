// The dashboard against the real server (`wrangler dev`, see e2e/real/fixtures.ts).
// The mocked suite is playwright.config.ts.
import { defineConfig, devices } from "@playwright/test";
import { quarantineOptions } from "./e2e/quarantine";
import { APP } from "./e2e/real/fixtures";

export default defineConfig({
  testDir: "e2e/real",
  globalSetup: "./e2e/real/global-setup.ts",
  timeout: 60_000,
  globalTimeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  // One retry in CI: a test that passes on it is reported flaky (an annotation
  // and the run summary), not failed. Quarantined tests run separately.
  retries: process.env.CI ? 1 : 0,
  ...quarantineOptions("real"),
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: APP, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/staging/happy-path",
  timeout: 60_000,
  globalTimeout: 5 * 60_000,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  use: { trace: "off" },
});

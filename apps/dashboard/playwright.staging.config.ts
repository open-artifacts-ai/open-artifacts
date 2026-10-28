// T19: the dashboard against real staging installs (the T19 plan). rl-a runs
// the flows through its test hooks; leo, the user's install, gets anonymous
// read-only checks only. Needs REDLINE_TARGETS for rl-a (pnpm test:e2e:staging).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/staging",
  timeout: 60_000,
  globalTimeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  // A gate: a flaky pass must not hide a real failure.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // CI uploads the report: a trace holds the test sessions' cookies, so CI
    // keeps a screenshot instead.
    trace: process.env.CI ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [
    { name: "rl-a guard", testMatch: "rl-a/guard.setup.ts" },
    {
      name: "rl-a",
      testMatch: "rl-a/*.spec.ts",
      dependencies: ["rl-a guard"],
    },
    { name: "leo", testMatch: "leo/*.spec.ts" },
  ],
});

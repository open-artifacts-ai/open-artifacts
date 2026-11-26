// T19: the dashboard against real staging installs (the T19 plan). rl-a runs
// the flows through its test hooks; leo, the user's install, gets anonymous
// read-only checks only. Needs REDLINE_TARGETS for rl-a (pnpm test:e2e:staging).
import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// One T19 run id for every worker and the purge teardown (rl-a/fixtures.ts
// RUN): set here, in the main process, before any worker starts.
process.env.T19_RUN ??= randomBytes(3).toString("hex");

// The release gate runs only the cases tagged { tag: "@gate" } (the short happy
// path: sign in, a page, a comment, sharing, a guest or second member, plus the
// guard and the purge that bracket them). The nightly runs every case. Change
// the gate set by editing the tags, here beside the tests; the workflow in
// open-artifacts-cloud (redline-staging.yml) selects with --grep @gate and
// fails a selection that matches nothing.
export default defineConfig({
  testDir: "e2e/staging",
  timeout: 60_000,
  globalTimeout: 25 * 60_000,
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
    {
      name: "rl-a guard",
      testMatch: "rl-a/guard.setup.ts",
      teardown: "rl-a purge",
    },
    // After every rl-a case (#2680): erases this run's people and old runs'.
    { name: "rl-a purge", testMatch: "rl-a/purge.teardown.ts" },
    {
      name: "rl-a",
      testMatch: "rl-a/*.spec.ts",
      // push.spec.ts runs in its own project: it waits on a cron tick.
      testIgnore: "rl-a/push.spec.ts",
      dependencies: ["rl-a guard"],
    },
    // #3024: a real push reaches official Chrome (waits for the 2-minute cron
    // tick, so it has its own timeout). Needs Google Chrome on the runner.
    {
      name: "rl-a push",
      testMatch: "rl-a/push.spec.ts",
      dependencies: ["rl-a guard"],
    },
    { name: "leo", testMatch: "leo/*.spec.ts" },
  ],
});

import { defineConfig } from "@playwright/test";
import { quarantineOptions } from "./e2e/quarantine";

// OA_E2E_PORT: another free port when 5199 is taken (parallel worktrees).
const port = Number(process.env.OA_E2E_PORT) || 5199;

export default defineConfig({
  testDir: "e2e",
  // e2e/real runs against wrangler dev: playwright.real.config.ts.
  testIgnore: "real/**",
  // One retry in CI: a test that passes on it is reported flaky (an annotation
  // and the run summary), not failed. Quarantined tests run separately.
  retries: process.env.CI ? 1 : 0,
  ...quarantineOptions("mock"),
  use: { baseURL: `http://localhost:${port}`, browserName: "chromium" },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_MOCK: "1" },
    reuseExistingServer: false,
  },
});

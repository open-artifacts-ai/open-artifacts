import { defineConfig } from "@playwright/test";

// OA_E2E_PORT: another free port when 5199 is taken (parallel worktrees).
const port = Number(process.env.OA_E2E_PORT) || 5199;

export default defineConfig({
  testDir: "e2e",
  // e2e/real and e2e/spaces run against wrangler dev:
  // playwright.real.config.ts and playwright.spaces.config.ts.
  testIgnore: ["real/**", "spaces/**"],
  // Tests, not files, are the unit of parallelism and of CI's --shard split:
  // by file, the two a11y specs (a quarter of the suite's time) landed in one
  // shard. Safe here: no mock spec shares state across its tests (no serial
  // describes, no beforeAll).
  fullyParallel: true,
  use: { baseURL: `http://localhost:${port}`, browserName: "chromium" },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_MOCK: "1" },
    reuseExistingServer: false,
  },
});

import { defineConfig } from "@playwright/test";

// OA_E2E_PORT: another free port when 5198 is taken (parallel worktrees).
const port = Number(process.env.OA_E2E_PORT) || 5198;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  use: { baseURL: `http://localhost:${port}`, browserName: "chromium" },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_MOCK: "1" },
    reuseExistingServer: false,
  },
});

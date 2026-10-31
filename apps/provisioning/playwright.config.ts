import { defineConfig } from "@playwright/test";

// Browser checks the workerd tests cannot make (design v7 9A.3.2 step 3,
// 14.4): the specs start the Worker themselves (e2e/worker.ts, Miniflare)
// with a cross-site origin beside it.
export default defineConfig({
  testDir: "e2e",
  use: { browserName: "chromium" },
});

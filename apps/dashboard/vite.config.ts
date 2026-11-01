import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./test/timeouts";

const target = "http://app.localhost:8787";

export default defineConfig({
  plugins: [
    react(),
    // Tailwind for the @oa/ui/shadcn components (src/shadcn.css).
    tailwindcss(),
    {
      // The MSW worker lives in public/ for dev; keep it out of production output.
      name: "oa-drop-mock-worker",
      apply: "build",
      closeBundle() {
        rmSync(new URL("./dist/mockServiceWorker.js", import.meta.url), {
          force: true,
        });
      },
    },
  ],
  resolve: {
    // Resolve the workspace contract from source so no prior shared build is needed.
    alias: [
      {
        find: /^@oa\/shared$/,
        replacement: fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@oa\/shared\/(.*)$/,
        replacement: `${fileURLToPath(new URL("../../packages/shared/src", import.meta.url))}/$1`,
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/auth": target,
      "/mcp": target,
      "/oauth": target,
      "/healthz": target,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    // Dates render the same on every machine and CI runner.
    env: { TZ: "UTC" },
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["test/**/*.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["test/**/*.test.tsx"],
          setupFiles: ["test/setup.ts"],
          // Above test/setup.ts's 5 s asyncUtilTimeout, so a stuck wait reports its own failure.
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});

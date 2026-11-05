import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// TODO(C1): the Provisioning API origin for dev; the Worker that serves this build is decided later.
const target = "http://api.localhost:8787";
// apps/provisioning serves the build as its ASSETS (wrangler `./dist-assets`).
const outDir = fileURLToPath(
  new URL("../provisioning/dist-assets", import.meta.url),
);

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
        rmSync(`${outDir}/mockServiceWorker.js`, { force: true });
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
      // Release version order (no Node imports), also from source.
      {
        find: /^@oa\/provision\/versions$/,
        replacement: fileURLToPath(
          new URL("../../packages/provision/src/versions.ts", import.meta.url),
        ),
      },
      // The hosted Provisioning API contract, also from source.
      {
        find: /^@oa\/provisioning-contract$/,
        replacement: fileURLToPath(
          new URL(
            "../../packages/provisioning-contract/src/index.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: /^@oa\/provisioning-contract\/(.*)$/,
        replacement: `${fileURLToPath(new URL("../../packages/provisioning-contract/src", import.meta.url))}/$1`,
      },
    ],
  },
  server: { port: 5174, proxy: { "/api": target, "/auth": target } },
  build: { outDir, emptyOutDir: true },
  test: {
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
          testTimeout: 15_000,
        },
      },
    ],
  },
});

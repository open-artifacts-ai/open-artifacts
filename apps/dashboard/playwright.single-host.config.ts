import { defineConfig, devices } from "@playwright/test";
import real from "./playwright.real.config";

// An opt-in cross-engine slice; does not expand the default CI/browser matrix.
export default defineConfig({
  ...real,
  testMatch: ["single-host.spec.ts", "bridge-nonce.spec.ts", "viewer.spec.ts"],
  projects: [
    ...(real.projects ?? []),
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});

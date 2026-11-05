import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Review item 45: render-dist.integration.test.ts (B11) and
// runtime-dist.integration.test.ts (B13) skip when their dist isn't built.
// In CI that skip must fail loudly: ci.yml builds both before `pnpm test`.
const root = new URL("../../../../", import.meta.url);
const MANIFESTS = [
  "packages/render/dist/manifest.json",
  "packages/runtime/dist/runtime.manifest.json",
];

describe.runIf(process.env.CI === "true")(
  "dist builds for the B11/B13 integration tests",
  () => {
    it.each(MANIFESTS)("%s exists, so its integration test runs", (p) => {
      expect(existsSync(new URL(p, root))).toBe(true);
    });
  },
);

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P3 T17: the session hook's space seeding is test-build only. The release
// bundle (define __OA_TEST_HOOKS_ALLOWED__ false) holds none of its SQL; the
// redline bundle (define true) does, so the check can't pass vacuously.
// Needs `pnpm --filter @oa/provision build` and apps/server/dist-assets
// (as scripts/ci/build-release-bundle.ts); skipped when they are missing.
const root = join(import.meta.dirname, "../../../..");
const ready =
  existsSync(join(root, "packages/provision/dist/index.js")) &&
  existsSync(join(root, "apps/server/dist-assets"));
const MARKERS = [
  "(kind <> 'shared' or deleted_at is not null)",
  "where exists (select 1 from spaces where id = ?1 and kind = 'shared' and deleted_at is null)",
];

function bundle(variant: "release" | "redline"): string {
  const out = mkdtempSync(join(tmpdir(), `oa-${variant}-`));
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      join(root, "scripts/ci/build-release-bundle.ts"),
      out,
      "--variant",
      variant,
    ],
    { cwd: root, stdio: "pipe" },
  );
  return readFileSync(join(out, "index.js"), "utf8");
}

describe.skipIf(!ready)("test session hook spaces (built bundles)", () => {
  it("release holds none of the space seeding; redline does", () => {
    const rel = bundle("release");
    const red = bundle("redline");
    for (const m of MARKERS) {
      expect(rel.includes(m), m).toBe(false);
      expect(red.includes(m), m).toBe(true);
    }
  }, 120_000);
});

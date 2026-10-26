import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// P3 T17: the session hook's space seeding (and the audit hook's read) is
// test-build only. The release
// bundle (define __OA_TEST_HOOKS_ALLOWED__ false) holds none of its SQL; the
// redline bundle (define true) does, so the check can't pass vacuously.
// Needs `pnpm --filter @oa/provision build` and apps/server/dist-assets
// (as scripts/ci/build-release-bundle.ts); skipped locally when missing.
const root = join(import.meta.dirname, "../../../..");
const ready =
  existsSync(join(root, "packages/provision/dist/index.js")) &&
  existsSync(join(root, "apps/server/dist-assets"));
const MARKERS = [
  "substr(fu.email, length(fu.email) - length(?5)) <> '@' || ?5",
  "where substr(?1, 1, 5) = 'test-'",
  "and exists (select 1 from spaces where id = ?1 and kind = 'shared' and deleted_at is null)",
  // The audit hook's read (test_hook rows only).
  "where actor_kind = 'test_hook' and substr(action, 1, 10) = 'test_hook.' and at >= ?1",
  // The Turnstile test-key acceptance (turnstileTestKeyPass).
  'out.hostname === "localhost"',
];
// Cloudflare's always-pass Turnstile TEST secret: never in a release bundle.
const TURNSTILE_TEST_SECRET = "1x0000000000000000000000000000000AA";

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

// OA_REQUIRE_REAL_BUILD=1 (the no-test-hooks CI job) never skips: a missing
// build then fails (as release-t3b).
describe.skipIf(!ready && process.env.OA_REQUIRE_REAL_BUILD !== "1")(
  "test session hook spaces (built bundles)",
  () => {
    it("release holds none of the space seeding; redline does", () => {
      const rel = bundle("release");
      const red = bundle("redline");
      for (const m of MARKERS) {
        expect(rel.includes(m), m).toBe(false);
        expect(red.includes(m), m).toBe(true);
      }
      expect(rel.includes(TURNSTILE_TEST_SECRET), "test secret").toBe(false);
      expect(red.includes(TURNSTILE_TEST_SECRET), "test secret").toBe(true);
    }, 120_000);
  },
);

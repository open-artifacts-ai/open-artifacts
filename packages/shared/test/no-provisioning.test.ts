import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @oa/shared is public. The hosted Provisioning API contract lives in
// @oa/provisioning-contract (packages/provisioning-contract), which moves to
// the private hosted repo (#1056). Nothing provisioning may come back here.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "src");

describe("@oa/shared holds no provisioning code (#1056)", () => {
  it("has no src/provisioning/ dir", () => {
    expect(existsSync(resolve(SRC, "provisioning"))).toBe(false);
  });

  it("has no provisioning file under src/mocks/", () => {
    const hits = readdirSync(resolve(SRC, "mocks")).filter((f) =>
      /^provisioning(\.|$)/.test(f),
    );
    expect(hits).toEqual([]);
  });

  it("exports no provisioning subpath", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(
      Object.keys(pkg.exports).filter((k) => /provisioning/.test(k)),
    ).toEqual([]);
  });
});

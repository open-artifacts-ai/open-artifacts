import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R28's sealTo is a hosted-only copy of the provisioner's (#1053, #1056):
// below its header the two files must stay byte-identical.

const root = join(import.meta.dirname, "../../../..");
const body = (p: string) => {
  const s = readFileSync(join(root, p), "utf8");
  return s.slice(s.indexOf("// Sealed delivery of redline_creds"));
};

describe("seal.ts copy", () => {
  it("matches apps/provisioner/src/seal.ts below its header", () => {
    expect(body("apps/provisioning/src/auth/seal.ts")).toBe(
      body("apps/provisioner/src/seal.ts"),
    );
    expect(body("apps/provisioner/src/seal.ts").length).toBeGreaterThan(1000);
  });
});

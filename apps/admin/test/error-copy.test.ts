import { describe, expect, it } from "vitest";
import { codeCopy } from "../src/api/errorCopy";

describe("codeCopy: the code sign-in refusals (#1088)", () => {
  it("say what is missing on the job page", () => {
    expect(codeCopy("domain_codes_refused")).toMatch(/Google off/);
    expect(codeCopy("turnstile_missing")).toMatch(/Turnstile widget/);
    expect(codeCopy("migration_held")).toMatch(/tick the restore point/);
  });
});

describe("codeCopy: forward only (#1106)", () => {
  it("never tells an admin to roll back", () => {
    for (const c of [
      "downgrade_refused",
      "upgrade_rolled_back",
      "upgrade_incomplete",
    ]) {
      expect(codeCopy(c), c).toMatch(/new release/);
      expect(codeCopy(c), c).not.toMatch(/rollback|roll back|go back/i);
    }
  });
  it("upgrade_rolled_back is about older jobs; upgrade_incomplete stays on the new version", () => {
    expect(codeCopy("upgrade_rolled_back")).toMatch(/older job/);
    expect(codeCopy("upgrade_incomplete")).toMatch(/stays on the new version/);
  });
  it("copy_key_left says what to delete", () => {
    expect(codeCopy("copy_key_left")).toMatch(/OAUTH_COPY_KEY/);
  });
});

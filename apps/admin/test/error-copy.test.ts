import { describe, expect, it } from "vitest";
import { codeCopy } from "../src/api/errorCopy";

describe("codeCopy: the code sign-in refusals (#1088)", () => {
  it("say what is missing on the job page", () => {
    expect(codeCopy("domain_codes_refused")).toMatch(/Google off/);
    expect(codeCopy("turnstile_missing")).toMatch(/Turnstile widget/);
  });
});

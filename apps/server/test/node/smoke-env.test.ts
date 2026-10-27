import { describe, expect, it } from "vitest";
import { missingSmokeEnv } from "../smoke-setup/warmup.ts";

// Review item 25: in CI an empty STAGING_OWNER_PAT (or STAGING_URL) must fail
// the smoke run, not skip seven suites and pass.
describe("smoke env in CI", () => {
  it("CI with both set: nothing missing", () => {
    expect(
      missingSmokeEnv({
        CI: "true",
        STAGING_URL: "https://s",
        STAGING_OWNER_PAT: "p",
      }),
    ).toEqual([]);
  });

  it("CI with an empty or blank PAT or URL names what is missing", () => {
    expect(
      missingSmokeEnv({
        CI: "true",
        STAGING_URL: "https://s",
        STAGING_OWNER_PAT: "",
      }),
    ).toEqual(["STAGING_OWNER_PAT"]);
    expect(
      missingSmokeEnv({ CI: "true", STAGING_URL: " ", STAGING_OWNER_PAT: "p" }),
    ).toEqual(["STAGING_URL"]);
    expect(missingSmokeEnv({ CI: "true" })).toEqual([
      "STAGING_URL",
      "STAGING_OWNER_PAT",
    ]);
  });

  it("outside CI both stay optional (local runs skip as before)", () => {
    expect(missingSmokeEnv({})).toEqual([]);
    expect(missingSmokeEnv({ CI: "false", STAGING_URL: "https://s" })).toEqual(
      [],
    );
  });
});

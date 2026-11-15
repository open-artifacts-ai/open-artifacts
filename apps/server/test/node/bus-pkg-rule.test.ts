// #2543: the release pin is read from the environment, all or nothing.
import { describe, expect, it } from "vitest";
import { busPkgFromEnv } from "../../scripts/bus-pkg-rule.ts";

const SHA = `sha512-${"A".repeat(86)}==`;

describe("busPkgFromEnv", () => {
  it("none: null (a dev or self-built server)", () => {
    expect(busPkgFromEnv({})).toBeNull();
    expect(
      busPkgFromEnv({ BUS_PKG_VERSION: "", BUS_PKG_SHA512: "" }),
    ).toBeNull();
  });
  it("both, valid: the pin", () => {
    expect(
      busPkgFromEnv({ BUS_PKG_VERSION: "1.2.3", BUS_PKG_SHA512: SHA }),
    ).toEqual({ version: "1.2.3", integrity: SHA });
  });
  it("half a pin or a bad one fails the build, never a quiet unpinned release", () => {
    for (const env of [
      { BUS_PKG_VERSION: "1.2.3" },
      { BUS_PKG_SHA512: SHA },
      { BUS_PKG_VERSION: "1.2", BUS_PKG_SHA512: SHA },
      { BUS_PKG_VERSION: "v1.2.3", BUS_PKG_SHA512: SHA },
      { BUS_PKG_VERSION: "1.2.3", BUS_PKG_SHA512: "sha256-abc" },
      { BUS_PKG_VERSION: "1.2.3", BUS_PKG_SHA512: SHA.slice(0, -1) },
      { BUS_PKG_VERSION: "1.2.3; rm -rf /", BUS_PKG_SHA512: SHA },
      { BUS_PKG_VERSION: "1.2.3", BUS_PKG_SHA512: `${SHA}' ; echo '` },
    ])
      expect(() => busPkgFromEnv(env), JSON.stringify(env)).toThrow();
  });
});

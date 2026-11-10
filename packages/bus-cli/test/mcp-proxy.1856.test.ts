import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";

describe("oa-bus mcp-proxy (#1856)", () => {
  it("takes the instance and the token file", () => {
    expect(
      parse([
        "mcp-proxy",
        "--instance",
        "https://oa.example.com",
        "--token-file",
        "~/.open-artifacts/x-pat-token",
      ]),
    ).toMatchObject({
      cmd: "mcp-proxy",
      hub: "https://oa.example.com",
      tokenFile: "~/.open-artifacts/x-pat-token",
    });
  });

  it("works without a token file, and needs an instance", () => {
    expect(parse(["mcp-proxy", "--instance", "https://h"])).toMatchObject({
      cmd: "mcp-proxy",
      hub: "https://h",
    });
    expect(() => parse(["mcp-proxy"])).toThrow(/--instance/);
    expect(() => parse(["mcp-proxy", "--instance", "https://h", "x"])).toThrow(
      /unexpected argument/,
    );
  });

  it("refuses flags it does not use", () => {
    expect(() =>
      parse(["mcp-proxy", "--instance", "https://h", "--yes"]),
    ).toThrow(/does not apply/);
  });
});

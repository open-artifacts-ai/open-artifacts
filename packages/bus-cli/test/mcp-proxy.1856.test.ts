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

describe("oa-bus mcp-proxy --for codex (#1856)", () => {
  it("takes the harness and the name of the token's variable", () => {
    expect(
      parse([
        "mcp-proxy",
        "--instance",
        "https://oa.example.com",
        "--for",
        "codex",
        "--token-env",
        "OA_TOKEN",
      ]),
    ).toMatchObject({
      cmd: "mcp-proxy",
      hub: "https://oa.example.com",
      for: "codex",
      tokenEnv: "OA_TOKEN",
    });
  });

  it("refuses an unknown harness, and a variable name for OpenCode or beside a file", () => {
    const base = ["mcp-proxy", "--instance", "https://h"];
    expect(() => parse([...base, "--for", "vim"])).toThrow(/opencode or codex/);
    expect(() => parse([...base, "--token-env", "X"])).toThrow(
      /needs --for codex/,
    );
    expect(() =>
      parse([
        ...base,
        "--for",
        "codex",
        "--token-env",
        "X",
        "--token-file",
        "f",
      ]),
    ).toThrow(/not both/);
  });
});

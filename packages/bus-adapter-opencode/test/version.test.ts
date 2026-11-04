import { describe, expect, it } from "vitest";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  parseOpencodeVersion,
  supportsPromptId,
} from "../src/version.ts";

const exec =
  (r: { code: number; stdout?: string; stderr?: string } | Error) =>
  async (cmd: string, args: string[]) => {
    expect([cmd, ...args]).toEqual(["opencode", "--version"]);
    if (r instanceof Error) throw r;
    return { stdout: "", stderr: "", ...r };
  };

describe("parseOpencodeVersion", () => {
  it.each([
    ["opencode v2.0.32\n", "2.0.32"],
    ["2.1.3", "2.1.3"],
    ["1.19.4\n", "1.19.4"],
    ["\u001b[1mopencode\u001b[0m v2.0.0-beta.2", "2.0.0-beta.2"],
    ["0.0.0-dev-202610221304", "0.0.0-dev-202610221304"],
    ["v2.0.32\nopencode 2.0.40 is available", "2.0.32"],
    ["1.4.0\nopencode 2.0.5 is available, run `opencode upgrade`\n", "1.4.0"],
    ["v2.0.32\n", "2.0.32"],
  ])("%j -> %s", (out, v) => {
    expect(parseOpencodeVersion(out)).toBe(v);
  });

  it.each([
    "",
    "opencode",
    "v2",
    "2.0",
    "bun 1.2.19\n",
    "error: node v22.1.0 too old",
    "warning: x\n2.0.7",
    "warning: x\nopencode 2.0.7 (darwin-arm64)",
    "bun 1.2.19\nopencode v2.0.32\n",
    "opencode 2.0.5 is available",
    "opencoder 2.0.7",
  ])("%j -> undefined", (out) => {
    expect(parseOpencodeVersion(out)).toBeUndefined();
  });
});

describe("opencodeVersion", () => {
  it("reads stdout", async () => {
    expect(
      await opencodeVersion(exec({ code: 0, stdout: "opencode v2.0.32\n" })),
    ).toBe("2.0.32");
  });
  it("falls back to stderr", async () => {
    expect(await opencodeVersion(exec({ code: 0, stderr: "2.1.0" }))).toBe(
      "2.1.0",
    );
  });
  it("is undefined on failure or a thrown exec", async () => {
    expect(
      await opencodeVersion(exec({ code: 127, stderr: "not found" })),
    ).toBeUndefined();
    expect(await opencodeVersion(exec(new Error("ENOENT")))).toBeUndefined();
  });
});

describe("supportsPromptId", () => {
  it("floors at the first v2 release", () => {
    expect(MIN_PROMPT_ID_VERSION).toBe("2.0.0");
  });
  it.each([
    ["2.0.0", true],
    ["2.0.32", true],
    ["2.1.3", true],
    ["10.0.0", true],
    ["1.19.4", false],
    ["1.99.99", false],
    ["2.0.0-beta.2", false],
    ["2.0.1-beta.1", true],
    ["0.0.0-dev-202610221304", false],
    [undefined, false],
    ["garbage", false],
  ])("%s -> %s", (v, ok) => {
    expect(supportsPromptId(v)).toBe(ok);
  });
});

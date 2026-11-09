import { describe, expect, it } from "vitest";
import { isFallbackName } from "../src/meta.ts";

describe("isFallbackName (#1860)", () => {
  it.each([
    ["claude-1262814", "claude-code"],
    ["CLAUDE-7", "claude-code"],
    ["omp-3", "omp"],
    ["pi-6", "pi"],
    ["pi", "pi"],
    ["agent", "pi"],
    ["Agent", "codex"],
    ["hermes-myproject", "hermes"],
  ])("%s (%s) is a harness fallback", (name, kind) => {
    expect(isFallbackName(name, kind)).toBe(true);
  });

  it.each([
    ["alpha", "pi"],
    ["agent-4", "pi"],
    ["claude-abc", "claude-code"],
    ["pilot", "pi"],
    ["omp-3", "pi"],
    ["Backend lead", "claude-code"],
  ])("%s (%s) is a chosen name", (name, kind) => {
    expect(isFallbackName(name, kind)).toBe(false);
  });
});

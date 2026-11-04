import { describe, expect, it } from "vitest";
import { BusConfigSchema, CONFIG_FILE, mergeConfigs } from "../src/config.js";

describe(".oa-bus.json", () => {
  it("is named exactly that", () => expect(CONFIG_FILE).toBe(".oa-bus.json"));
  it("accepts both keys and neither", () => {
    expect(BusConfigSchema.parse({})).toEqual({});
    expect(
      BusConfigSchema.parse({ namespace: "github.com/a/b", global: true }),
    ).toEqual({ namespace: "github.com/a/b", global: true });
  });
  it("still accepts `global`, so an old repo's file keeps its namespace (C19)", () => {
    // Parsed, never granted: global comes only from the user's allowlist.
    expect(
      BusConfigSchema.safeParse({ namespace: "team", global: true }),
    ).toMatchObject({ success: true, data: { namespace: "team" } });
    expect(BusConfigSchema.safeParse({ global: false }).success).toBe(true);
  });
  it("rejects unknown keys and bad values", () => {
    expect(BusConfigSchema.safeParse({ global: "yes" }).success).toBe(false);
    expect(BusConfigSchema.safeParse({ namespace: "" }).success).toBe(false);
    expect(BusConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("mergeConfigs (nearest first)", () => {
  it("combines keys from near and far files", () => {
    expect(mergeConfigs([{ namespace: "near" }, { global: true }])).toEqual({
      namespace: "near",
      global: true,
    });
  });
  it("the nearer file wins per key", () => {
    expect(
      mergeConfigs([
        { namespace: "near", global: false },
        { namespace: "far", global: true },
      ]),
    ).toEqual({ namespace: "near", global: false });
  });
  it("is empty for no configs", () => expect(mergeConfigs([])).toEqual({}));
});

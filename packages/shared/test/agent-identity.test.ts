import { describe, expect, it } from "vitest";
import {
  AgentLabelSchema,
  OAuthClientPatchSchema,
  OAuthClientSchema,
  stripNameControls,
  TokenPatchSchema,
  TokenSchema,
} from "../src/index.js";

describe("agent identity cards", () => {
  it("AgentLabelSchema strips controls and bidi, trims, 1-60 code points", () => {
    expect(AgentLabelSchema.parse(" \u202eWork\u200b laptop\u0007 ")).toBe(
      "Work laptop",
    );
    expect(AgentLabelSchema.parse("é".repeat(60))).toBe("é".repeat(60));
    expect(AgentLabelSchema.parse("😀".repeat(60))).toBe("😀".repeat(60));
    for (const bad of ["", "   ", "\u202e\u2066", "x".repeat(61)])
      expect(AgentLabelSchema.safeParse(bad).success, bad).toBe(false);
  });
  it("stripNameControls is still exported for space names", () => {
    expect(stripNameControls("a\u0000b\u2066c")).toBe("abc");
  });
  it("OAuthClientPatchSchema: label or null, strict", () => {
    expect(OAuthClientPatchSchema.parse({ label: null })).toEqual({
      label: null,
    });
    expect(OAuthClientPatchSchema.parse({ label: " a " })).toEqual({
      label: "a",
    });
    expect(OAuthClientPatchSchema.safeParse({}).success).toBe(false);
    expect(
      OAuthClientPatchSchema.safeParse({ label: "a", clientName: "x" }).success,
    ).toBe(false);
  });
  it("TokenPatchSchema: label required 1-80 (as on create), null is 400", () => {
    expect(TokenPatchSchema.parse({ label: " ci\u202e " })).toEqual({
      label: "ci",
    });
    expect(
      TokenPatchSchema.parse({ label: "x".repeat(80) }).label,
    ).toHaveLength(80);
    expect(TokenPatchSchema.safeParse({ label: "x".repeat(81) }).success).toBe(
      false,
    );
    expect(TokenPatchSchema.safeParse({ label: null }).success).toBe(false);
  });
  it("old grants and tokens parse without the new fields", () => {
    const grant = { grantId: "g", clientName: "c", createdAt: "t" };
    expect(OAuthClientSchema.parse(grant)).toEqual(grant);
    const token = { id: "i", label: "l", createdAt: "t", lastUsedAt: null };
    expect(TokenSchema.parse(token)).toEqual(token);
  });
  it("a new grant carries approval and usage fields", () => {
    const full = {
      grantId: "g",
      clientName: "c",
      createdAt: "t",
      label: "mine",
      redirectKind: "hosted",
      redirectHost: "claude.ai",
      approvedFrom: { browser: "safari", os: "ios" },
      lastUsedAt: "t2",
      clientVersion: "1.0.0",
      versionsPublished: 2,
    };
    expect(OAuthClientSchema.parse(full)).toEqual(full);
    expect(
      OAuthClientSchema.safeParse({ ...full, redirectKind: "desktop" }).success,
    ).toBe(false);
    expect(
      OAuthClientSchema.safeParse({
        ...full,
        approvedFrom: { browser: "opera", os: "ios" },
      }).success,
    ).toBe(false);
    expect(
      OAuthClientSchema.safeParse({ ...full, versionsPublished: -1 }).success,
    ).toBe(false);
  });
});

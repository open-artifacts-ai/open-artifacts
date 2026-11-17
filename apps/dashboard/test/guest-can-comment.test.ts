import type { ArtifactSummary } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { canComment } from "../src/viewer/comments/useComments";

const art = (can?: { comment: boolean }) =>
  ({
    visibility: "private",
    ...(can ? { can } : {}),
  }) as unknown as ArtifactSummary;

describe("canComment for a capped account", () => {
  it("a guest with a Can comment share comments when the server says so", () => {
    expect(canComment(art({ comment: true }), true, true)).toBe(true);
  });
  it("a capped account the server refuses stays read-only", () => {
    expect(canComment(art({ comment: false }), true, true)).toBe(false);
  });
  it("with no answer from the server, a capped account stays read-only", () => {
    expect(canComment(art(), true, true)).toBe(false);
    expect(canComment(art(), true, false)).toBe(true);
  });
});

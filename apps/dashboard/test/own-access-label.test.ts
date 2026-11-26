import { describe, expect, it } from "vitest";
import { ownAccessLabel } from "../src/auth/permissions";

describe("ownAccessLabel", () => {
  it("a guest with a Can comment share reads Can comment", () => {
    expect(
      ownAccessLabel({ access: "viewer", can: { comment: true } }, true),
    ).toBe("Can comment");
  });
  it("a guest who can't comment reads Can view", () => {
    expect(
      ownAccessLabel({ access: "viewer", can: { comment: false } }, true),
    ).toBe("Can view");
    expect(ownAccessLabel({ access: "viewer" }, true)).toBe("Can view");
  });
  it("a member sees the effective page access", () => {
    expect(
      ownAccessLabel({ access: "viewer", can: { comment: true } }, false),
    ).toBe("Can comment");
    expect(ownAccessLabel({ access: "viewer", comments: false }, false)).toBe(
      "Can view",
    );
    expect(ownAccessLabel({ access: "editor" }, false)).toBe("Can edit");
  });
});

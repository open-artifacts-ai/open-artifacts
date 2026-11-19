// #2932: a guest with a Can comment share reads "Can comment" in the title
// bar, not "Viewer"; members keep their role.
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
  it("a member keeps the role, comments or not", () => {
    expect(
      ownAccessLabel({ access: "viewer", can: { comment: true } }, false),
    ).toBe("Viewer");
    expect(ownAccessLabel({ access: "editor" }, false)).toBe("Editor");
  });
});

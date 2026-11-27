import { describe, expect, it } from "vitest";
import { ownAccessLabel } from "../src/auth/permissions";

describe("ownAccessLabel", () => {
  it("uses the assigned commenter role even with comments turned off", () => {
    expect(ownAccessLabel({ access: "viewer", shareRole: "commenter" })).toBe(
      "Commenter",
    );
  });
  it("uses effective access for editors, guest editors and owners", () => {
    expect(ownAccessLabel({ access: "editor" })).toBe("Editor");
    expect(ownAccessLabel({ access: "viewer", shareRole: "editor" })).toBe(
      "Viewer",
    );
    expect(ownAccessLabel({ access: "owner", shareRole: "viewer" })).toBe(
      "Owner",
    );
  });
});

import { expect, it } from "vitest";
import { kindLabel } from "../src/copy.ts";

it("labels the antigravity kind Antigravity; an unknown kind shows by its token", () => {
  expect(kindLabel("antigravity")).toBe("Antigravity");
  expect(kindLabel("zeta")).toBe("zeta");
});

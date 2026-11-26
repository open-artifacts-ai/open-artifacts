import { expect, it } from "vitest";
import { knownProduct, linkedFields } from "../src/services/agent-display.ts";

it("an antigravity bus identity shows its product as Antigravity (agy S1a)", () => {
  expect(
    linkedFields({ identityId: "id-1", kind: "antigravity" }, false),
  ).toMatchObject({ linked: true, product: "Antigravity" });
  expect(knownProduct("antigravity")).toBe("Antigravity");
});

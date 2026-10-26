import { it } from "vitest";
import { type ProofMeta, proof } from "../../src/report.ts";

// Driven by report.test.ts: FIXTURE_LEVEL picks the second case's level.
it("fixture: a passing case", () => {});

it("fixture: the case under test", (ctx) => {
  const level = process.env.FIXTURE_LEVEL ?? "pass";
  if (level === "fail") throw new Error("fixture failure");
  if (level !== "pass") proof(ctx, level as ProofMeta["level"], "fixture");
});

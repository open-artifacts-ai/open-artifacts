import { beforeAll, it } from "vitest";
import { type ProofMeta, proof } from "../../src/report.ts";

// Driven by report.test.ts: FIXTURE_LEVEL picks the second case's level
// ("setup-fail" fails beforeAll instead).
beforeAll(() => {
  if (process.env.FIXTURE_LEVEL === "setup-fail")
    throw new Error("fixture setup");
});

it("fixture: a passing case", () => {});

it("fixture: the case under test", (ctx) => {
  const level = process.env.FIXTURE_LEVEL ?? "pass";
  if (level === "fail") throw new Error("fixture failure");
  if (level !== "pass") proof(ctx, level as ProofMeta["level"], "fixture");
});

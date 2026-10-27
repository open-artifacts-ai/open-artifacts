import { beforeAll, beforeEach, describe, it } from "vitest";
import { InfraError, setupTimeout } from "../../src/fetch-timeout.ts";
import { label, type ProofMeta, proof } from "../../src/report.ts";

// Driven by report.test.ts: FIXTURE_LEVEL picks the second case's level
// ("setup-fail" fails the top beforeAll; "nested-setup-fail" fails the
// beforeAll of an outer suite around a nested one; "labeled" labels the
// nested case from a beforeEach, as live/signin.test.ts does; "infra" and
// "setup-infra" throw a setup-publish timeout from the case or the top
// beforeAll).
const LEVEL = process.env.FIXTURE_LEVEL ?? "pass";

beforeAll(() => {
  if (LEVEL === "setup-fail") throw new Error("fixture setup");
  if (LEVEL === "setup-infra")
    throw new InfraError(setupTimeout("rl-b", 60_000));
});

it("fixture: a passing case", () => {});

it("fixture: the case under test", (ctx) => {
  if (LEVEL === "fail") throw new Error("fixture failure");
  if (LEVEL === "infra") throw new InfraError(setupTimeout("rl-b", 60_000));
  if (["staging-only", "not-applicable", "unproven-live"].includes(LEVEL))
    proof(ctx, LEVEL as ProofMeta["level"], "fixture");
});

describe("outer", () => {
  beforeAll(() => {
    if (LEVEL === "nested-setup-fail") throw new Error("fixture outer setup");
  });
  describe("inner", () => {
    beforeEach((ctx) => {
      if (LEVEL === "labeled") label(ctx, "Turnstile test key");
    });
    it("fixture: a nested case", () => {});
  });
});

import { AuthMethodSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { INTERACTIVE } from "../src/auth/authz.js";

// #3087: a person who signs in with any provider is an interactive session
// (typed comments, push writes); only bearer tokens are not.
describe("interactive session methods", () => {
  it("every person sign-in method is interactive; bearers, dev and test are not", () => {
    // dev and test are local and hook sessions, never interactive (as before).
    const bearer = new Set(["pat", "oauth", "dev", "test"]);
    for (const m of AuthMethodSchema.options)
      expect([m, INTERACTIVE.has(m)]).toEqual([m, !bearer.has(m)]);
  });
});

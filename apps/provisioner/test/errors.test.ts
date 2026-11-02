import { NonRetryableError } from "cloudflare:workflows";
import {
  CfError,
  PROVISION_ERROR_CODES,
  ProvisionRefused,
  ProvisionRetry,
} from "@oa/provision";
import { describe, expect, it } from "vitest";
import {
  classify,
  codeOf,
  detailOf,
  ERROR_MESSAGE_MAX,
  JOB_ERROR_TEXT,
  redactEmail,
  StepRefusal,
  stepError,
} from "../src/errors.js";
import { refused } from "../src/recheck.js";

// A step's error says a job code (design v7 3.5), read from the thrown
// error's own code, never its message; a refusal adds the code's fixed
// text.

const EMAIL = "Owner+Tag@Example.COM";

describe("classify", () => {
  it("a refusal's own code: terminal, unless it is a ProvisionRetry", () => {
    expect(
      classify(new ProvisionRefused("x is busy: another", "prod_dirty")),
    ).toEqual({ retryable: false, code: "prod_dirty" });
    expect(classify(new ProvisionRefused("any text", "slug_taken"))).toEqual({
      retryable: false,
      code: "slug_taken",
    });
    for (const c of ["lease_held", "revoke_pending", "token_invalid"] as const)
      expect(classify(new ProvisionRetry("m", c))).toEqual({
        retryable: true,
        code: c,
      });
  });

  it("the message never decides: an old #859 lease text with another code stays that code", () => {
    expect(
      classify(
        new ProvisionRefused(
          "install i1 is busy: another operation holds it",
          "invalid_state",
        ),
      ),
    ).toEqual({ retryable: false, code: "invalid_state" });
  });

  it("a Cloudflare error retries as cf_error; anything else retries as internal", () => {
    expect(classify(new CfError("GET", "/x", 500, "boom"))).toEqual({
      retryable: true,
      code: "cf_error",
    });
    for (const e of [new Error("healthz timeout"), "x", null])
      expect(classify(e)).toEqual({ retryable: true, code: "internal" });
  });
});

describe("redactEmail", () => {
  it("removes the address in any case, raw or URL-encoded", () => {
    const t = `a ${EMAIL} b ${EMAIL.toLowerCase()} c ${encodeURIComponent(EMAIL)}`;
    expect(redactEmail(t, EMAIL)).toBe("a [email] b [email] c [email]");
    expect(redactEmail("x", "  ")).toBe("x");
  });
});

describe("stepError", () => {
  it("a terminal refusal: NonRetryableError '<code>: <fixed text>', never its own message", () => {
    const e = stepError(
      new ProvisionRefused(
        `owner ${EMAIL} slug acme key FOO refused`,
        "invalid_state",
      ),
    );
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.message).toBe(`invalid_state: ${JOB_ERROR_TEXT.invalid_state}`);
    const long = stepError(
      new ProvisionRefused("y".repeat(1000), "prod_dirty"),
    );
    expect(long.message).toBe(`prod_dirty: ${JOB_ERROR_TEXT.prod_dirty}`);
  });

  it("anything retryable: a plain Error with the code alone", () => {
    for (const [x, code] of [
      [new ProvisionRetry(`held ${EMAIL}`, "lease_held"), "lease_held"],
      [new CfError("GET", "/x", 500, EMAIL), "cf_error"],
      [new Error(`D1_ERROR ${EMAIL}`), "internal"],
    ] as const) {
      const e = stepError(x);
      expect(e).not.toBeInstanceOf(NonRetryableError);
      expect(e.message).toBe(code);
    }
  });
});

describe("refused (recheck)", () => {
  it("a NonRetryableError of exactly '<code>: <fixed text>'; the detail only via detailOf", () => {
    const e = refused("var LEAK_KEY is not allowed");
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e).toBeInstanceOf(StepRefusal);
    expect(e.message).toBe(`invalid_state: ${JOB_ERROR_TEXT.invalid_state}`);
    expect(e.message).not.toContain("LEAK_KEY");
    expect(detailOf(e)).toBe("var LEAK_KEY is not allowed");
    expect(codeOf(e)).toBe("invalid_state");
  });
});

describe("JOB_ERROR_TEXT", () => {
  it("one short fixed sentence per job code, no placeholder", () => {
    expect(Object.keys(JOB_ERROR_TEXT).sort()).toEqual(
      [...PROVISION_ERROR_CODES].sort(),
    );
    for (const t of Object.values(JOB_ERROR_TEXT)) {
      expect(t.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
      expect(t).toMatch(/^[A-Z][^${}]*\.$/);
    }
  });
});

describe("codeOf", () => {
  it("reads the code a step error carries; anything else is internal", () => {
    for (const c of PROVISION_ERROR_CODES) {
      expect(codeOf(new Error(c))).toBe(c);
      expect(codeOf(new Error(`${c}: detail`))).toBe(c);
    }
    for (const x of [new Error("refused: x"), new Error(""), null, "boom"])
      expect(codeOf(x)).toBe("internal");
  });
});

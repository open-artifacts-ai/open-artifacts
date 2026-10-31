import { NonRetryableError } from "cloudflare:workflows";
import {
  CfError,
  PROVISION_ERROR_CODES,
  ProvisionRefused,
  ProvisionRetry,
} from "@oa/provision";
import { describe, expect, it } from "vitest";
import { classify, codeOf, redactEmail, stepError } from "../src/errors.js";

// A step's error says a job code (design v7 3.5), read from the thrown
// error's own code, never its message; only a refusal adds its (redacted)
// message.

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
  it("a terminal refusal: NonRetryableError '<code>: <redacted message>', at most 300 characters", () => {
    const e = stepError(
      new ProvisionRefused(`owner ${EMAIL} refused`, "invalid_state"),
      EMAIL,
    );
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.message).toBe("invalid_state: owner [email] refused");
    const long = stepError(
      new ProvisionRefused("y".repeat(1000), "prod_dirty"),
      null,
    );
    expect(long.message.length).toBeLessThanOrEqual(300);
    expect(long.message.startsWith("prod_dirty: yyy")).toBe(true);
  });

  it("anything retryable: a plain Error with the code alone", () => {
    for (const [x, code] of [
      [new ProvisionRetry(`held ${EMAIL}`, "lease_held"), "lease_held"],
      [new CfError("GET", "/x", 500, EMAIL), "cf_error"],
      [new Error(`D1_ERROR ${EMAIL}`), "internal"],
    ] as const) {
      const e = stepError(x, EMAIL);
      expect(e).not.toBeInstanceOf(NonRetryableError);
      expect(e.message).toBe(code);
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

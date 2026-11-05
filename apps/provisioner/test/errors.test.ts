import { NonRetryableError } from "cloudflare:workflows";
import {
  CfError,
  DoStepRequired,
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
  errorTextOf,
  JOB_ERROR_TEXT,
  jobErrorText,
  redactDetail,
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

describe("redactDetail (#1088)", () => {
  // What requestValues gathers for a create with domain codes on: vars' keys
  // and values, the slug, the owner.
  const VALUES = [
    "acme",
    "AUTH_PROVIDERS",
    "email",
    "AUTH_DOMAINS",
    "acme.test",
    "EMAIL_CODE_DOMAIN",
    "on",
    "TIER",
    "business",
    EMAIL,
  ];

  it("a domain-codes refusal stays readable", () => {
    for (const t of [
      "EMAIL_CODE_DOMAIN=on needs email in AUTH_PROVIDERS",
      "EMAIL_CODE_DOMAIN=on needs google out of AUTH_PROVIDERS",
      "EMAIL_CODE_DOMAIN=on needs AUTH_DOMAINS",
      "EMAIL_CODE_DOMAIN is not allowed here",
    ])
      expect(redactDetail(t, VALUES)).toBe(t);
  });

  it("a value under the minimum length never eats into words", () => {
    expect(
      redactDetail("codes are on, conditions noted", ["on", "x", "12"]),
    ).toBe("codes are on, conditions noted");
  });

  it("a value at the minimum length is still redacted", () => {
    expect(redactDetail("slug ibm refused", ["ibm"])).toBe(
      "slug [value] refused",
    );
  });

  it("tokens, secrets and other request values stay redacted", () => {
    const token = "oa_pat_0123456789abcdefghij";
    const secret = "0x4AAAAAAAts-secret";
    expect(
      redactDetail(`bad ${token} and ${encodeURIComponent(secret)} on acme`, [
        token,
        secret,
        "acme",
      ]),
    ).toBe("bad [value] and [value] on [value]");
    // A value only looks like a plain word when it is exactly that word.
    expect(redactDetail("got email-secret-1", ["email-secret-1"])).toBe(
      "got [value]",
    );
  });

  it("emails, URLs and IPs go whatever the values list says", () => {
    expect(
      redactDetail("o@ab.io https://x.test/a?k=1 10.0.0.1 user%40ab.io", [
        "on",
      ]),
    ).toBe("[email] [url] [ip] [email]");
    // Listed, and short: the email pattern still applies.
    expect(redactDetail("a@b from on", ["a@b", "on"])).toBe("[value] from on");
  });

  it("a request value equal to a plain word in another case is redacted", () => {
    expect(redactDetail("slug Google-X", ["Google-X"])).toBe("slug [value]");
    expect(redactDetail("slug GOOGLE", ["GOOGLE"])).toBe("slug [value]");
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

describe("the code-sign-in refusals (#1088)", () => {
  it("are terminal, and say what is missing in fixed text", () => {
    for (const [code, re] of [
      ["domain_codes_refused", /email.*Google.*domain/],
      ["turnstile_missing", /Turnstile/],
    ] as const) {
      const e = stepError(new ProvisionRefused(`leak ${EMAIL}`, code));
      expect(e).toBeInstanceOf(NonRetryableError);
      expect(e.message).toBe(`${code}: ${JOB_ERROR_TEXT[code]}`);
      expect(e.message).toMatch(re);
      expect(e.message).not.toContain("leak");
    }
  });
});

describe("do_step_required (#1343): the one structured value", () => {
  const STEPPED = (v: string) =>
    `Upgrade this install to ${v} first: the target adds Durable Object classes it can't jump to.`;

  it("a release version step is named, in the error and the stored text; never the refusal's own message", () => {
    const e = stepError(
      new DoStepRequired(
        `install i1 owner ${EMAIL}: upgrade it to 0.115.0 first`,
        "0.115.0",
      ),
    );
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(e.message).toBe(`do_step_required: ${STEPPED("0.115.0")}`);
    expect(errorTextOf(e)).toBe(STEPPED("0.115.0"));
    expect(e.message).not.toContain(EMAIL);
    expect(
      errorTextOf(stepError(new DoStepRequired("x", "0.115.0-rc.1"))),
    ).toBe(STEPPED("0.115.0-rc.1"));
    expect(STEPPED("9".repeat(40)).length).toBeLessThanOrEqual(
      ERROR_MESSAGE_MAX,
    );
  });

  it("no step, or one that isn't a release version, is the fixed text alone", () => {
    for (const step of [
      null,
      "",
      "v0.115.0",
      `0.115.0-${"a".repeat(40)}`,
      `0.115.0 ${EMAIL}`,
      "1.2",
    ]) {
      const e = stepError(new DoStepRequired("x", step));
      expect(e.message).toBe(
        `do_step_required: ${JOB_ERROR_TEXT.do_step_required}`,
      );
      expect(errorTextOf(e)).toBe(JOB_ERROR_TEXT.do_step_required);
      expect(jobErrorText("do_step_required", step)).toBe(
        JOB_ERROR_TEXT.do_step_required,
      );
    }
  });

  it("only do_step_required takes a step: any other code keeps its fixed text", () => {
    expect(jobErrorText("invalid_state", "0.115.0")).toBe(
      JOB_ERROR_TEXT.invalid_state,
    );
    const other = stepError(new ProvisionRefused("x", "invalid_state"));
    expect(errorTextOf(other)).toBe(JOB_ERROR_TEXT.invalid_state);
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

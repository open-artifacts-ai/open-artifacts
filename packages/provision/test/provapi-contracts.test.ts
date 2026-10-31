// The Provisioning API contracts provision exports (design v7, C3): error
// codes on refusals, the near-expiry mode per job kind, the verify_clean
// spec's pure parts, the onStep step names, and the pause/unpause and
// registryDisabled surface W2 builds on.
import { describe, expect, it } from "vitest";
import { CfError } from "../src/cf.js";
import * as INDEX from "../src/index.js";
import {
  CREATE_SECRETS,
  expectedSecretNames,
  LostLease,
  NEAR_EXPIRY_MODE,
  PROVISION_ERROR_CODES,
  PROVISION_JOB_KINDS,
  PROVISION_RETRY_CODES,
  PROVISIONER_TOKEN_LABEL_RE,
  ProdLocked,
  ProvisionRefused,
  ProvisionRetry,
  provisionErrorCode,
  type SettleDb,
  type SettleFailed,
  settleFailed,
  VERIFY_CLEAN_REFUSED_BINDING_TYPES,
  WFP_STEPS,
} from "../src/wfp.js";

describe("ProvisionRefused.code and ProvisionRetry (3.5)", () => {
  it("the codes are the job error table, in order", () => {
    expect([...PROVISION_ERROR_CODES]).toEqual([
      "release_not_published",
      "release_unverified",
      "downgrade_refused",
      "prod_dirty",
      "invalid_state",
      "slug_taken",
      "lease_held",
      "revoke_pending",
      "token_invalid",
      "upgrade_rolled_back",
      "upgrade_incomplete",
      "canceled",
      "cf_error",
      "internal",
    ]);
    expect([...PROVISION_RETRY_CODES]).toEqual([
      "lease_held",
      "revoke_pending",
      "token_invalid",
    ]);
    for (const c of PROVISION_RETRY_CODES)
      expect(PROVISION_ERROR_CODES).toContain(c);
  });

  it("a refusal carries its code as a property, and none when not given", () => {
    const e = new ProvisionRefused("slug acme is taken", "slug_taken");
    expect(e.code).toBe("slug_taken");
    expect(e.message).toBe("slug acme is taken");
    expect(e.name).toBe("ProvisionRefused");
    expect(new ProvisionRefused("plain").code).toBeUndefined();
  });

  it("an unknown code is refused at construction, never stored", () => {
    expect(
      () => new ProvisionRefused("x", "slug_takn" as unknown as "slug_taken"),
    ).toThrow(/unknown provision error code/);
  });

  it("ProvisionRetry is a ProvisionRefused with a retry code", () => {
    for (const code of PROVISION_RETRY_CODES) {
      const e = new ProvisionRetry("rerun once the revoke settles", code);
      expect(e).toBeInstanceOf(ProvisionRefused);
      expect(e).toBeInstanceOf(ProvisionRetry);
      expect(e.code).toBe(code);
      expect(e.name).toBe("ProvisionRetry");
    }
    expect(
      () => new ProvisionRetry("x", "prod_dirty" as unknown as "lease_held"),
    ).toThrow(/not a retry code/);
  });

  it("classification reads the property, not the message", () => {
    const e = new ProvisionRefused("lease_held: looks retryable", "prod_dirty");
    expect(e instanceof ProvisionRetry).toBe(false);
    expect(e.code).toBe("prod_dirty");
  });

  it("the existing subclasses still construct from a message", () => {
    expect(new ProdLocked("locked").code).toBeUndefined();
    expect(new LostLease("lost")).toBeInstanceOf(ProvisionRefused);
  });

  it("is exported from @oa/provision", () => {
    expect(INDEX.ProvisionRetry).toBe(ProvisionRetry);
    expect(INDEX.NEAR_EXPIRY_MODE).toBe(NEAR_EXPIRY_MODE);
  });
});

describe("near-expiry mode per job kind (5.7)", () => {
  it("covers every job kind, warn for recovery and refuse for forward", () => {
    expect(Object.keys(NEAR_EXPIRY_MODE).sort()).toEqual(
      [...PROVISION_JOB_KINDS].sort(),
    );
    const warn = [
      "suspend",
      "delete",
      "purge",
      "discard",
      "release_lease",
      "rollback",
      "cleanup",
    ];
    const refuse = [
      "create",
      "retry",
      "upgrade",
      "resume",
      "restore",
      "redline_creds",
    ];
    for (const k of warn) expect(NEAR_EXPIRY_MODE[k as never]).toBe("warn");
    for (const k of refuse) expect(NEAR_EXPIRY_MODE[k as never]).toBe("refuse");
    expect(warn.length + refuse.length).toBe(PROVISION_JOB_KINDS.length);
    expect(Object.isFrozen(NEAR_EXPIRY_MODE)).toBe(true);
  });
});

describe("onStep step names (5.2, 5.4)", () => {
  it("are the JOB_STEPS names provision reports, in create order", () => {
    expect([...WFP_STEPS]).toEqual([
      "upload",
      "verify_clean",
      "health",
      "route",
      "enable_signin",
      "active",
    ]);
  });
});

describe("verify_clean spec (5.2)", () => {
  it("refuses secrets_store_secret, service and dispatch_namespace bindings", () => {
    expect([...VERIFY_CLEAN_REFUSED_BINDING_TYPES]).toEqual([
      "secrets_store_secret",
      "service",
      "dispatch_namespace",
    ]);
  });

  it("the secret names are CREATE_SECRETS plus each option's own secret, sorted", () => {
    const base = [...CREATE_SECRETS].sort();
    expect(
      expectedSecretNames({ broker: false, codes: false, testHooks: false }),
    ).toEqual(base);
    expect(
      expectedSecretNames({ broker: true, codes: true, testHooks: true }),
    ).toEqual(
      [
        ...CREATE_SECRETS,
        "BROKER_SIGNING_KEY",
        "TURNSTILE_SECRET",
        "TEST_HOOK_KEY",
      ].sort(),
    );
    expect(
      expectedSecretNames({ broker: false, codes: false, testHooks: true }),
    ).toContain("TEST_HOOK_KEY");
    expect(
      expectedSecretNames({ broker: true, codes: false, testHooks: false }),
    ).not.toContain("TEST_HOOK_KEY");
  });

  it("no option adds a name twice", () => {
    const all = expectedSecretNames({
      broker: true,
      codes: true,
      testHooks: true,
    });
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("provisionErrorCode (3.5)", () => {
  it("reads the property: a refusal's code, cf_error, else internal", () => {
    expect(provisionErrorCode(new ProvisionRefused("x", "slug_taken"))).toBe(
      "slug_taken",
    );
    expect(provisionErrorCode(new ProvisionRetry("x", "token_invalid"))).toBe(
      "token_invalid",
    );
    expect(provisionErrorCode(new ProvisionRefused("x"))).toBe("internal");
    expect(provisionErrorCode(new CfError("GET", "/x", 500, "boom"))).toBe(
      "cf_error",
    );
    expect(provisionErrorCode(new Error("slug_taken: no"))).toBe("internal");
    expect(provisionErrorCode("slug_taken")).toBe("internal");
  });

  it("is exported from @oa/provision", () => {
    expect(INDEX.provisionErrorCode).toBe(provisionErrorCode);
  });
});

describe("settleFailed (3.6)", () => {
  const db: SettleDb = {
    prepare: () => ({ bind: () => ({}) }),
    batch: async () => [],
  };
  it("takes (db, jobId, code) and is not built yet (W3)", async () => {
    const f: SettleFailed = settleFailed;
    expect(f.length).toBe(3);
    await expect(
      f(db, "01JBQ4ZKXW5V9R3M2N8P6T7Y0A", "canceled"),
    ).rejects.toThrow(/not built yet \(W3\)/);
    await expect(
      f(db, "01JBQ4ZKXW5V9R3M2N8P6T7Y0A", "nope" as never),
    ).rejects.toThrow(/unknown provision error code/);
    expect(INDEX.settleFailed).toBe(settleFailed);
  });
});

describe("PROVISIONER_TOKEN_LABEL_RE (3.1 ULID)", () => {
  it("accepts ss-<ULID> and refuses a first character above 7", () => {
    expect(
      PROVISIONER_TOKEN_LABEL_RE.test("ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0A"),
    ).toBe(true);
    expect(
      PROVISIONER_TOKEN_LABEL_RE.test("ss-7ZZZZZZZZZZZZZZZZZZZZZZZZZ"),
    ).toBe(true);
    for (const bad of [
      "ss-81JBQ4ZKXW5V9R3M2N8P6T7Y0A",
      "ss-Z1JBQ4ZKXW5V9R3M2N8P6T7Y0A",
      "ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0",
    ])
      expect(PROVISIONER_TOKEN_LABEL_RE.test(bad)).toBe(false);
  });
});

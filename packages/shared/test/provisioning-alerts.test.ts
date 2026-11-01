import { describe, expect, it } from "vitest";
import {
  ALERT_CONDITIONS,
  AUDIT_REFUSAL_BUCKETS,
  alertParams,
  RPC_ALERT_KEYS,
  SIGNIN_REFUSAL_BUCKET,
  SQL_ALERT_KEYS,
} from "../src/provisioning/alerts.js";
import { ALERT_KEYS } from "../src/provisioning/enums.js";

describe("ALERT_KEYS", () => {
  it("is the scheduler's alert list (design 5.8), once each", () => {
    expect([...ALERT_KEYS]).toEqual([
      "signin_refused_burst",
      "admin_unknown_sub",
      "job_failed",
      "job_retrying",
      "job_stuck",
      "prod_dirty",
      "prodclean_failed",
      "upgrade_incomplete",
      "unreachable_after_route",
      "purge_stuck",
      "welcome_unsent",
      "signup_cap",
      "oauth_register_flood",
      "token_expiring",
      "token_invalid",
    ]);
    expect(new Set(ALERT_KEYS).size).toBe(ALERT_KEYS.length);
  });

  it("every key is a platform_state key prefix", () => {
    for (const k of ALERT_KEYS) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("splits into D1 conditions and PROVISIONER.tokenStatus() keys", () => {
    expect([...RPC_ALERT_KEYS]).toEqual(["token_expiring", "token_invalid"]);
    expect([...SQL_ALERT_KEYS, ...RPC_ALERT_KEYS].sort()).toEqual(
      [...ALERT_KEYS].sort(),
    );
    expect(Object.keys(ALERT_CONDITIONS).sort()).toEqual(
      [...SQL_ALERT_KEYS].sort(),
    );
  });
});

describe("ALERT_CONDITIONS", () => {
  it("each query binds exactly ?1..?n for its params, read-only", () => {
    for (const k of SQL_ALERT_KEYS) {
      const c = ALERT_CONDITIONS[k];
      const used = new Set(
        [...c.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])),
      );
      expect([...used].sort(), k).toEqual(c.params.map((_, i) => i + 1));
      expect(c.sql.trimStart(), k).toMatch(/^SELECT\b/);
      expect(c.sql, k).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/,
      );
      expect(c.sql, k).not.toMatch(/email/i);
    }
  });

  it("alertParams binds in the query's order", () => {
    const at = { now: 1_000, signupDailyCap: 7 };
    expect(alertParams("job_stuck", at)).toEqual([1_000]);
    expect(alertParams("prodclean_failed", at)).toEqual([]);
    expect(alertParams("signup_cap", at)).toEqual([1_000, 7]);
  });
});

describe("AUDIT_REFUSAL_BUCKETS", () => {
  it("names each audit_refusals bucket once, sign-in among them", () => {
    expect(new Set(AUDIT_REFUSAL_BUCKETS).size).toBe(
      AUDIT_REFUSAL_BUCKETS.length,
    );
    for (const b of AUDIT_REFUSAL_BUCKETS) expect(b).toMatch(/^[a-z_]+$/);
    expect(AUDIT_REFUSAL_BUCKETS).toContain(SIGNIN_REFUSAL_BUCKET);
    expect(AUDIT_REFUSAL_BUCKETS).toContain("oauth_register");
    expect(ALERT_CONDITIONS.signin_refused_burst.sql).toContain(
      `bucket = '${SIGNIN_REFUSAL_BUCKET}'`,
    );
  });
});

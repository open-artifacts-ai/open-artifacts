import { NonRetryableError } from "cloudflare:workflows";
import {
  HOSTED_DOMAINS,
  NAMESPACES,
  PROVISIONER_MAX_TOKEN_DAYS,
  WfpProvisioner,
} from "@oa/provision";
import { describe, expect, it } from "vitest";
import {
  deployEnv,
  type ProvisionerEnv,
  provisionerFor,
  provisionerOptions,
} from "../src/provisioner.js";

// The provisioner's WfpProvisioner (design v7 2.5): the token from Secrets
// Store, the env's namespace and domains, the R2 release reader, an
// ss-<signupId> owner token, and an end date up to 400 days out.

const TOKEN = "cf-test-token-value";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const LABEL = "ss-01JBQ4ZKXW5V9R3M2N8P6T7Y0A";

const mkEnv = (o: Partial<ProvisionerEnv> = {}, gets: string[] = []) =>
  ({
    OA_ENV: "staging",
    ACCOUNT_ID: ACCOUNT,
    RELEASES: {} as R2Bucket,
    PROVISION_TOKEN: {
      get: async () => {
        gets.push("get");
        return TOKEN;
      },
    } as SecretsStoreSecret,
    ...o,
  }) satisfies ProvisionerEnv;

const io = (calls: { url: string; auth: string | null }[] = []) => ({
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, auth: req.headers.get("authorization") });
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { id: "t", status: "active" },
    });
  }) as typeof fetch,
  now: () => 0,
  sleep: async () => {},
});

describe("deployEnv", () => {
  it("is staging or prod; anything else is a terminal internal error", () => {
    expect(deployEnv("staging")).toBe("staging");
    expect(deployEnv("prod")).toBe("prod");
    for (const v of ["", "Staging", "production", "{{OA_ENV}}", " prod"]) {
      const e = (() => {
        try {
          deployEnv(v);
        } catch (x) {
          return x;
        }
      })();
      expect(e, v).toBeInstanceOf(NonRetryableError);
      expect((e as Error).message).toBe("internal");
    }
  });
});

describe("provisionerOptions", () => {
  it("for each env: namespace target, hosted domains, ss- owner token, install id required, maxTokenDays 400", async () => {
    for (const env of ["staging", "prod"] as const) {
      const o = await provisionerOptions(mkEnv({ OA_ENV: env }), LABEL, io());
      expect(o.env).toBe(env);
      expect(o.target).toEqual({ kind: "namespace", ns: NAMESPACES[env] });
      expect(o.domains).toEqual(HOSTED_DOMAINS[env]);
      expect(o.ciOwnerToken).toEqual({ label: LABEL });
      expect(o.requireInstallId).toBe(true);
      expect(o.maxTokenDays).toBe(PROVISIONER_MAX_TOKEN_DAYS);
      expect(PROVISIONER_MAX_TOKEN_DAYS).toBe(400);
      // No PAT file on a Worker; Turnstile and onStep are W3's.
      expect(o).not.toHaveProperty("patDir");
      expect(o.release).toBeDefined();
    }
  });

  it("reads PROVISION_TOKEN once and calls Cloudflare with it on ACCOUNT_ID", async () => {
    const gets: string[] = [];
    const calls: { url: string; auth: string | null }[] = [];
    const o = await provisionerOptions(mkEnv({}, gets), LABEL, io(calls));
    expect(gets).toEqual(["get"]);
    await o.cf.tokenVerify();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/user\/tokens\/verify$/);
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("a Secrets Store failure is retryable internal, never its text", async () => {
    const env = mkEnv({
      PROVISION_TOKEN: {
        get: async () => {
          throw new Error(`secrets store down ${TOKEN}`);
        },
      } as SecretsStoreSecret,
    });
    const e = await provisionerOptions(env, LABEL, io()).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(NonRetryableError);
    expect(e.message).toBe("internal");
  });

  it("a bad OA_ENV is refused before the token is read", async () => {
    const gets: string[] = [];
    const e = await provisionerOptions(
      mkEnv({ OA_ENV: "dev" }, gets),
      LABEL,
      io(),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(NonRetryableError);
    expect(gets).toEqual([]);
  });

  it("provisionerFor builds a WfpProvisioner from those options", async () => {
    expect(await provisionerFor(mkEnv(), LABEL, io())).toBeInstanceOf(
      WfpProvisioner,
    );
  });
});

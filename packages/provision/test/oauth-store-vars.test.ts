import { describe, expect, it } from "vitest";
import { cfClient } from "../src/cf.js";
import { hostedVarProblem } from "../src/metadata.js";
import {
  CREATE_SECRETS,
  type VerifyCleanInput,
  verifyCleanRefusal,
} from "../src/wfp.js";

// #1008 PR1 on the provision side: the mode is a hosted var, verify_clean
// takes OAUTH_COPY_KEY either way, and the cf client deletes a secret.

describe("OAUTH_STORE as a hosted var", () => {
  it("takes the three modes and nothing else", () => {
    for (const m of ["kv", "dual", "d1"])
      expect(hostedVarProblem("OAUTH_STORE", m)).toBeUndefined();
    for (const m of ["", "KV", "dual ", "d2"])
      expect(hostedVarProblem("OAUTH_STORE", m)).toMatch(/OAUTH_STORE/);
  });
});

describe("verify_clean and OAUTH_COPY_KEY", () => {
  const v = {
    id: "i",
    sent: { bindings: [] },
    rec: { variant: "release" },
    broker: false,
    codes: false,
    testHooks: false,
    lastTag: null,
    tag: null,
  } as unknown as VerifyCleanInput;
  const live = (secrets: string[]) => ({ bindings: [], secrets });

  it("is clean with the key absent, and with it present", () => {
    expect(verifyCleanRefusal(live([...CREATE_SECRETS]), v)).toBeNull();
    expect(
      verifyCleanRefusal(live([...CREATE_SECRETS, "OAUTH_COPY_KEY"]), v),
    ).toBeNull();
  });

  it("still refuses any other extra secret, and a missing one", () => {
    expect(
      verifyCleanRefusal(live([...CREATE_SECRETS, "OAUTH_COPY_KEYS"]), v),
    ).toMatch(/not expected/);
    expect(
      verifyCleanRefusal(
        live([...CREATE_SECRETS.slice(1), "OAUTH_COPY_KEY"]),
        v,
      ),
    ).toMatch(/is missing/);
  });
});

describe("cf.secretDelete", () => {
  it("URL-encodes the name and has no body", async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    const cf = cfClient({
      accountId: "a".repeat(32),
      token: "t",
      fetch: (async (u: RequestInfo | URL, i?: RequestInit) => {
        seen.push({
          url: String(u),
          method: i?.method ?? "GET",
          body: String(i?.body ?? ""),
        });
        return Response.json({ success: true, result: null });
      }) as typeof fetch,
      sleep: async () => {},
    });
    await cf.secretDelete({ kind: "namespace", ns: "ns" }, "s", "A/B");
    expect(seen).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/workers/dispatch/namespaces/ns/scripts/s/secrets/A%2FB",
        method: "DELETE",
        body: "",
      },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { limit, RATE_LIMIT_BINDINGS } from "../src/limits.js";
import { fakeEnv } from "./fakes.js";

describe("limit (4.7)", () => {
  it("names one binding per bucket", () => {
    expect(RATE_LIMIT_BINDINGS).toEqual({
      pre_ip: "RL_PV_PRE_IP",
      signin_ip: "RL_PV_SIGNIN_IP",
      write: "RL_PV_WRITE",
      read: "RL_PV_READ",
      slug_ip: "RL_PV_SLUG_IP",
      oauth_ip: "RL_PV_OAUTH_IP",
      admin_escape: "RL_PV_ADMIN_ESCAPE",
      token_write: "RL_PV_TOKEN_WRITE",
    });
  });

  it("charges the bucket's binding with the key; null when allowed", async () => {
    const { env, limits } = fakeEnv();
    expect(await limit(env, "write", "admin:a@b.c")).toBeNull();
    expect(limits.RL_PV_WRITE.keys).toEqual(["admin:a@b.c"]);
    expect(limits.RL_PV_READ.keys).toEqual([]);
  });

  it("over the limit is rate_limited", async () => {
    const { env, limits } = fakeEnv();
    limits.RL_PV_OAUTH_IP.allow = false;
    expect(await limit(env, "oauth_ip", "1.2.3.4")).toEqual({
      refusal: true,
      code: "rate_limited",
    });
  });

  it("an unbound binding fails closed with unavailable", async () => {
    const { env } = fakeEnv({ RL_PV_READ: undefined });
    expect(await limit(env, "read", "k")).toEqual({
      refusal: true,
      code: "unavailable",
    });
  });
});

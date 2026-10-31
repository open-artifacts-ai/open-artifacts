import { describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { NotImplemented } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import {
  type AgentTokenRow,
  mintAgentToken,
  type SessionRow,
  tokenPrincipal,
} from "../src/services/tokens.js";
import { fakeEnv } from "./fakes.js";

const admin: Principal = {
  kind: "admin",
  actorKey: "admin:me@example.com",
  rateKey: "admin:me@example.com",
  label: "me@example.com",
  scopes: [],
  email: "me@example.com",
  sub: "123",
  authAt: 0,
};
const row: AgentTokenRow = {
  id: "01J00000000000000000000000",
  kind: "oat",
  token_hash: "h",
  session_hash: "s",
  admin_email: "me@example.com",
  label: "ci",
  scopes: '["installs:read"]',
  client_id: null,
  client_name: null,
  oauth_user: null,
  grant_id: null,
  created_at: 0,
  expires_at: Number.MAX_SAFE_INTEGER,
  revoked_at: null,
  last_used_at: null,
};
const session: SessionRow = {
  id_hash: "s",
  kind: "admin",
  host: "admin.hosted.test",
  email: "me@example.com",
  sub: "123",
  auth_at: 0,
  created_at: 0,
  expires_at: Number.MAX_SAFE_INTEGER,
  revoked_at: null,
  last_seen_at: null,
};

describe("C4 service stubs", () => {
  it("audit rejects until W4", async () => {
    const { env } = fakeEnv();
    await expect(
      audit(env, {
        action: "authz.refused",
        actor: admin,
        outcome: "refused",
        route: "R2",
        code: "forbidden",
      }),
    ).rejects.toBeInstanceOf(NotImplemented);
  });

  it("mintAgentToken rejects until W5b, for both kinds", async () => {
    const { env } = fakeEnv();
    await expect(
      mintAgentToken(env, admin, {
        kind: "oat",
        scopes: ["installs:read"],
        label: "ci",
        ttlMinutes: 15,
        requestId: "req_0123456789abcdef",
      }),
    ).rejects.toBeInstanceOf(NotImplemented);
    await expect(
      mintAgentToken(env, admin, {
        kind: "oauth",
        scopes: ["installs:read"],
        clientId: "c",
        clientName: "Claude",
      }),
    ).rejects.toBeInstanceOf(NotImplemented);
  });

  it("tokenPrincipal fails closed until W5b", () => {
    const { env } = fakeEnv();
    expect(tokenPrincipal(row, session, env)).toMatchObject({
      refusal: true,
      code: "unauthenticated",
    });
    expect(tokenPrincipal(row, null, env)).toEqual({
      refusal: true,
      code: "unauthenticated",
      reason: "session_ended",
    });
  });
});

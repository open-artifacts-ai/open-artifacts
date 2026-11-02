import { beforeEach, describe, expect, it } from "vitest";
import { handle as appHandle } from "../src/app.js";
import { csrfToken } from "../src/auth/csrf.js";
import { createSession, SESSION_COOKIE } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { ESCAPE_LIMITS } from "../src/limits.js";
import { platformDb } from "./db.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";

// A leaked oat_ token cannot lock its admin out of revoke (R21) or logout
// (R24): those spend `admin-escape:<email>`, and each token spends its own
// `token:<id>` write sub-bucket before the admin's shared one (limits.ts).

/** A binding with a real per-key cap over one window. */
const windowed = (max: number) => {
  const counts = new Map<string, number>();
  return {
    counts,
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
};

const EMAIL = "me@example.com";
const UNKNOWN = "01J00000000000000000000000";

const handle = (req: Request, env: Env) => {
  req = new Request(req);
  req.headers.set("cf-connecting-ip", "192.0.2.10");
  return appHandle(req, env, ctx());
};

async function world() {
  await platformDb();
  const rl = {
    RL_PV_WRITE: windowed(30),
    RL_PV_ADMIN_ESCAPE: windowed(ESCAPE_LIMITS.admin_escape),
    RL_PV_TOKEN_WRITE: windowed(ESCAPE_LIMITS.token_write),
  };
  const { env } = fakeEnv(rl as unknown as Partial<Env>);
  const s = await createSession(
    env,
    { email: EMAIL, sub: "123", authAt: Date.now() },
    Date.now(),
  );
  const csrf = await csrfToken(env, s.sid);
  const admin = (path: string, method: string, body?: unknown) =>
    handle(
      new Request(`${ADMIN}${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${s.sid}`,
          origin: ADMIN,
          "x-csrf-token": csrf,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
  const mint = async () => {
    const r = await admin("/api/v1/tokens", "POST", {
      requestId: `req_${crypto.randomUUID().replace(/-/g, "")}`,
      label: "ci",
      scopes: ["installs:write"],
    });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: string; token: string };
  };
  // A junk write: refused by schema or lookup once past the rate limit.
  const junk = (bearer: string) =>
    handle(
      new Request(`${API}/v1/installs/nope/suspend`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
  return { env, rl, admin, mint, junk };
}

describe("rate-limit escape (R21, R24)", () => {
  beforeEach(async () => {
    await platformDb();
  });

  it("a token's 40 junk writes 429; the admin still revokes it and logs out", async () => {
    const w = await world();
    const t = await w.mint();
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await w.junk(t.token)).status);
    expect(codes.filter((c) => c === 429).length).toBe(
      40 - ESCAPE_LIMITS.token_write,
    );
    expect(codes.slice(ESCAPE_LIMITS.token_write)).toEqual(
      Array(40 - ESCAPE_LIMITS.token_write).fill(429),
    );
    // The token's sub-bucket stopped it inside the admin's total.
    expect(w.rl.RL_PV_TOKEN_WRITE.counts.get(`token:${t.id}`)).toBe(40);
    expect(w.rl.RL_PV_WRITE.counts.get(`admin:${EMAIL}`)).toBe(
      1 + ESCAPE_LIMITS.token_write,
    );
    // Even with the shared write bucket spent, R21 and R24 get through.
    for (let i = 0; i < 30; i++)
      await w.rl.RL_PV_WRITE.limit({ key: `admin:${EMAIL}` });
    expect((await w.admin(`/api/v1/tokens/${t.id}`, "DELETE")).status).toBe(
      204,
    );
    expect((await w.junk(t.token)).status).toBe(401);
    expect((await w.admin("/api/v1/tokens", "DELETE")).status).toBe(204);
    expect((await w.admin("/auth/logout", "POST")).status).toBe(204);
    expect(w.rl.RL_PV_ADMIN_ESCAPE.counts.get(`admin-escape:${EMAIL}`)).toBe(3);
  });

  it("a second token is unaffected by the first token's sub-bucket", async () => {
    const w = await world();
    const t1 = await w.mint();
    const t2 = await w.mint();
    for (let i = 0; i < 20; i++) await w.junk(t1.token);
    expect((await w.junk(t1.token)).status).toBe(429);
    const r = await w.junk(t2.token);
    expect(r.status).not.toBe(429);
    expect(w.rl.RL_PV_TOKEN_WRITE.counts.get(`token:${t2.id}`)).toBe(1);
  });

  it("the escape bucket's own cap still holds", async () => {
    const w = await world();
    const cap = ESCAPE_LIMITS.admin_escape;
    for (let i = 0; i < cap; i++)
      expect(
        (await w.admin(`/api/v1/tokens/${UNKNOWN}`, "DELETE")).status,
      ).toBe(404);
    expect((await w.admin(`/api/v1/tokens/${UNKNOWN}`, "DELETE")).status).toBe(
      429,
    );
    expect((await w.admin("/auth/logout", "POST")).status).toBe(429);
    // The shared write bucket was never charged by R21/R24.
    expect(w.rl.RL_PV_WRITE.counts.get(`admin:${EMAIL}`)).toBeUndefined();
  });
});

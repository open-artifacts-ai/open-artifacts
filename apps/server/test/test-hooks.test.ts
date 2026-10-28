import { env } from "cloudflare:workers";
import {
  AUTH,
  HealthzSchema,
  MeSchema,
  OAuthClientHookResultSchema,
  R,
  TEST_HOOKS,
  TEST_HOOKS_ALLOWED,
  TestSessionResultSchema,
} from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailKey, ipKey } from "../src/auth/codes.js";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { revokeAllGrants } from "../src/mcp/oauth-api.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";

// P2 Task 14: test hooks for P5's cross-tenant suite.
const KEY = "k".repeat(32);
const TD = "p5.test";
type RlCall = { key: string };
const rlCalls: RlCall[] = [];
const passRl = {
  limit: async (o: RlCall) => {
    rlCalls.push(o);
    return { success: true };
  },
} as unknown as RateLimit;
const ON = {
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: KEY,
  TEST_DOMAIN: TD,
  RL_ANON: passRl,
};
const tu = (local: string) => uniq(local, TD);
/**
 * A start time past the current millisecond: an earlier test's last audit
 * row may share it. Waits on the clock moving (a D1 round trip advances
 * workerd's clock), not on a sleep.
 */
async function freshSince(): Promise<number> {
  const t = Date.now();
  while (Date.now() <= t) await env.DB.prepare("select 1").first();
  return Date.now();
}

const auditRows = async (since: number) =>
  (
    await env.DB.prepare(
      "select actor_kind, action, target_type, target_id, detail from audit_events where at >= ? and actor_kind = 'test_hook' order by at",
    )
      .bind(since)
      .all<{
        actor_kind: string;
        action: string;
        target_type: string;
        target_id: string;
        detail: string;
      }>()
  ).results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
/** The standard 404 (hooks off), byte for byte. */
async function same404(r: Response) {
  const ref = await call(env, TEST_HOOKS.session, { body: {} });
  expect(r.status).toBe(404);
  expect(await r.text()).toBe(await ref.text());
  expect(r.headers.get("content-type")).toBe(ref.headers.get("content-type"));
}
/** A refusal after the key: the same 404, plus error.details.reason (and any extra details). */
async function refused404(
  r: Response,
  reason: string,
  extra: Record<string, string> = {},
) {
  const ref = await call(env, TEST_HOOKS.session, { body: {} });
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toBe(ref.headers.get("content-type"));
  const { error } = (await ref.json()) as { error: object };
  expect(await r.json()).toEqual({
    error: { ...error, details: { reason, ...extra } },
  });
}
afterEach(() => vi.restoreAllMocks());

async function call(
  e: Env,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    key?: string;
    host?: string;
    scheme?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const waits: Promise<unknown>[] = [];
  const r = await worker.fetch(
    new Request(
      `${init.scheme ?? "http"}://${init.host ?? "app.localhost"}${path}`,
      {
        method: init.method ?? "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.200",
          ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
    ) as never,
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
}
/** test_otps rows holding `code` (0 when the table doesn't exist). */
const otpRows = async (code: string) =>
  (
    await env.DB.prepare("select count(*) n from test_otps where code = ?")
      .bind(code)
      .first<{ n: number }>()
      .catch(() => null)
  )?.n ?? 0;
const on = (over: Partial<Env> = {}) => ({ ...env, ...ON, ...over }) as Env;
/** A counters row at n = 7 for today's bucket (any bucket: the reset ignores it). */
const seedCounter = (key: string) =>
  env.DB.prepare(
    "insert into counters (key, n, day) values (?1, 7, 'd') on conflict (key) do update set n = 7",
  )
    .bind(key)
    .run();
const counter = async (key: string) =>
  (
    await env.DB.prepare("select n from counters where key = ?")
      .bind(key)
      .first<{ n: number }>()
  )?.n ?? null;
const hook = (e: Env, path: string, body?: unknown, key = KEY) =>
  call(e, path, { body: body ?? {}, key });

describe("activation", () => {
  it("the test build allows hooks", () => {
    expect(TEST_HOOKS_ALLOWED).toBe(true);
  });

  it("off: every method and path is the standard 404", async () => {
    const ref = await call(env, TEST_HOOKS.session, { body: {} });
    expect(ref.status).toBe(404);
    expect(await ref.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    for (const method of ["GET", "POST", "PUT", "DELETE"])
      for (const p of [
        TEST_HOOKS.session,
        TEST_HOOKS.otpLatest,
        TEST_HOOKS.oauthClient,
        "/__test/x",
      ])
        expect(
          (
            await call(env, p, {
              method,
              body: method === "GET" ? undefined : {},
              key: KEY,
            })
          ).status,
        ).toBe(404);
    expect(
      (
        await call(
          { ...env, TEST_HOOKS: "0", TEST_HOOK_KEY: KEY } as Env,
          TEST_HOOKS.session,
          { body: {}, key: KEY },
        )
      ).status,
    ).toBe(404);
  });

  it("on with a 31-char key is still off", async () => {
    const short = "s".repeat(31);
    await same404(
      await hook(
        on({ TEST_HOOK_KEY: short }),
        TEST_HOOKS.session,
        { email: tu("a"), role: "member" },
        short,
      ),
    );
  });

  it("without TEST_DOMAIN the hooks are off", async () => {
    for (const d of [undefined, ""])
      await same404(
        await hook(on({ TEST_DOMAIN: d }), TEST_HOOKS.session, {
          email: tu("nd"),
          role: "member",
        }),
      );
    expect(
      HealthzSchema.parse(
        await (
          await call(on({ TEST_DOMAIN: undefined }), "/healthz", {
            method: "GET",
          })
        ).json(),
      ).testHooks,
    ).toBeUndefined();
  });

  it("a wrong or missing key gets the identical 404", async () => {
    for (const key of ["x".repeat(32), undefined])
      await same404(
        await call(on(), TEST_HOOKS.session, {
          body: { email: tu("a"), role: "member" },
          key,
        }),
      );
  });

  it("the content host is 404 even with the key", async () => {
    const r = await call(on(), TEST_HOOKS.session, {
      body: { email: tu("a"), role: "member" },
      key: KEY,
      host: env.CONTENT_HOST,
    });
    expect(r.status).toBe(404);
  });

  it("off: no D1 or KV access", async () => {
    const d = vi.spyOn(env.DB, "prepare");
    const k = vi.spyOn(env.OAUTH_KV, "get");
    await call(env, TEST_HOOKS.session, { body: {}, key: KEY });
    expect(d).not.toHaveBeenCalled();
    expect(k).not.toHaveBeenCalled();
  });
});

describe("rate limit first", () => {
  const failRl = (keys: string[]) =>
    ({
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    }) as unknown as RateLimit;

  it("over RL_ANON (test:<install>:<ip>) is the 404, before the key compare or D1", async () => {
    const keys: string[] = [];
    const digest = vi.spyOn(crypto.subtle, "digest");
    const d = vi.spyOn(env.DB, "prepare");
    for (const key of [KEY, "x".repeat(32)])
      await same404(
        await hook(
          on({ RL_ANON: failRl(keys) }),
          TEST_HOOKS.session,
          { email: tu("rl"), role: "member" },
          key,
        ),
      );
    expect(keys).toEqual([
      `test:${env.APP_HOST}:198.51.100.200`,
      `test:${env.APP_HOST}:198.51.100.200`,
    ]);
    expect(digest).not.toHaveBeenCalled();
    expect(d).not.toHaveBeenCalled();
  });

  it("a wrong key still spends the limiter", async () => {
    rlCalls.length = 0;
    await call(on(), TEST_HOOKS.session, { body: {}, key: "x".repeat(32) });
    expect(rlCalls).toHaveLength(1);
  });

  it("RL_ANON unbound: the 404 even with the right key", async () => {
    const d = vi.spyOn(env.DB, "prepare");
    await same404(
      await hook(on({ RL_ANON: undefined }), TEST_HOOKS.session, {
        email: tu("unb"),
        role: "member",
      }),
    );
    expect(d).not.toHaveBeenCalled();
  });
});

describe("audit", () => {
  it("each call writes one audit row (hook, IP, domain) and one log line; never the key, email or cookie", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    const since = await freshSince();
    const email = tu("log");
    const r = await hook(on(), TEST_HOOKS.session, { email, role: "member" });
    const { cookie } = TestSessionResultSchema.parse(await r.json());
    await call(on(), TEST_HOOKS.otpLatest, {
      body: {},
      key: "x".repeat(32),
    });
    await hook(on(), TEST_HOOKS.session, {
      email: uniq("other", "a.com"),
      role: "member",
    });
    const rows = await auditRows(since);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          actor_kind: "test_hook",
          action: "test_hook.session",
          target_type: "test_hook",
          target_id: "session",
          detail: {
            hook: "session",
            ip: "198.51.100.200",
            outcome: "ok",
            domain: TD,
          },
        },
        {
          actor_kind: "test_hook",
          action: "test_hook.otp_latest",
          target_type: "test_hook",
          target_id: "otp_latest",
          detail: {
            hook: "otp_latest",
            ip: "198.51.100.200",
            outcome: "denied",
          },
        },
        {
          actor_kind: "test_hook",
          action: "test_hook.session",
          target_type: "test_hook",
          target_id: "session",
          detail: {
            hook: "session",
            ip: "198.51.100.200",
            outcome: "refused",
            domain: "a.com",
          },
        },
      ]),
    );
    const ev = lines.filter((l) => l.includes("test_hook"));
    expect(ev.map((l) => JSON.parse(l).evt)).toEqual([
      "test_hook.session",
      "test_hook.denied",
      "test_hook.refused",
    ]);
    const all = lines.join("\n") + JSON.stringify(rows);
    for (const s of [KEY, email, email.split("@")[0], cookie])
      expect(all).not.toContain(s);
  });
});

describe("TEST_DOMAIN and refusals", () => {
  it("session: only an exact TEST_DOMAIN address; everything else the 404 (user_refused)", async () => {
    for (const email of [
      uniq("x", "a.com"),
      uniq("x", `sub.${TD}`),
      uniq("x", `${TD}.evil.com`),
      uniq("x", `evil${TD}`),
    ])
      await refused404(
        await hook(on(), TEST_HOOKS.session, { email, role: "member" }),
        "user_refused",
      );
    expect(
      (
        await hook(on(), TEST_HOOKS.session, {
          email: tu("ok"),
          role: "member",
        })
      ).status,
    ).toBe(200);
  });

  it("session: the owner email is refused", async () => {
    const owner = tu("owner");
    await refused404(
      await hook(on({ OWNER_EMAIL: owner }), TEST_HOOKS.session, {
        email: owner.toUpperCase(),
        role: "owner",
      }),
      "user_refused",
    );
    expect(
      await env.DB.prepare("select id from users where email = ?")
        .bind(owner)
        .first(),
    ).toBeNull();
  });

  it("session: an existing user's role is never changed; the same role is fine", async () => {
    const email = tu("exist");
    await seedUser(email, "member");
    await refused404(
      await hook(on(), TEST_HOOKS.session, { email, role: "admin" }),
      "user_refused",
    );
    expect(
      await env.DB.prepare("select role from users where email = ?")
        .bind(email)
        .first("role"),
    ).toBe("member");
    expect(
      (await hook(on(), TEST_HOOKS.session, { email, role: "member" })).status,
    ).toBe(200);
  });

  it("session: role owner is refused outright (new users cap at admin)", async () => {
    const email = tu("own");
    await refused404(
      await hook(on(), TEST_HOOKS.session, { email, role: "owner" }),
      "user_refused",
    );
    expect(
      await env.DB.prepare("select id from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
    expect(
      (await hook(on(), TEST_HOOKS.session, { email, role: "admin" })).status,
    ).toBe(200);
  });

  it("session: racing roles for one new address: one wins, the other is the 404, the row keeps the winner's role", async () => {
    const email = tu("race");
    const roles = ["member", "admin", "guest"] as const;
    const rs = await Promise.all(
      roles.map((role) => hook(on(), TEST_HOOKS.session, { email, role })),
    );
    const ok = rs.flatMap((r, i) => (r.status === 200 ? [roles[i]] : []));
    expect(ok).toHaveLength(1);
    for (const r of rs)
      if (r.status !== 200) await refused404(r, "user_refused");
    expect(
      await env.DB.prepare("select role from users where email = ?")
        .bind(email)
        .first("role"),
    ).toBe(ok[0]);
  });

  it("session: a suspended user is refused, not revived", async () => {
    const email = tu("susp");
    await seedUser(email, "member", { status: "suspended" });
    await refused404(
      await hook(on(), TEST_HOOKS.session, { email, role: "member" }),
      "user_refused",
    );
  });

  it("session: bad input is the 404 with bad_input; a bad route says bad_route", async () => {
    await refused404(
      await hook(on(), TEST_HOOKS.session, { email: "nope", role: "member" }),
      "bad_input",
    );
    await refused404(
      await call(on(), "/__test/x", { body: {}, key: KEY }),
      "bad_route",
    );
    await refused404(
      await call(on(), TEST_HOOKS.session, { method: "GET", key: KEY }),
      "bad_route",
    );
  });

  it("before the key verifies, a refusal has no reason (the uniform 404)", async () => {
    // Wrong key, missing key, rate limited, limiter unbound, hooks off: the
    // body is exactly the standard 404, with no details.
    const noRl = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;
    const rs = [
      await call(on(), "/__test/x", { body: {}, key: "x".repeat(32) }),
      await call(on(), TEST_HOOKS.session, { body: { email: "nope" } }),
      await hook(on({ RL_ANON: noRl }), TEST_HOOKS.session, { email: "nope" }),
      await hook(on({ RL_ANON: undefined }), TEST_HOOKS.session, {}),
      await hook(env, TEST_HOOKS.session, { email: "nope" }),
    ];
    for (const r of rs) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({
        error: { code: "not_found", message: "Not found" },
      });
    }
  });

  it("otp/latest: an address outside TEST_DOMAIN is the 404 with bad_input", async () => {
    await refused404(
      await hook(on(), TEST_HOOKS.otpLatest, { email: uniq("o", "a.com") }),
      "bad_input",
    );
  });
});

describe("hooks", () => {
  it("session: a real cookie for that role; me.auth.method is test", async () => {
    const e = on({
      AUTH_PROVIDERS: "google,email",
      AUTH_DOMAINS: "a.com",
      GOOGLE_CLIENT_ID: "c",
      GOOGLE_CLIENT_SECRET: "s",
    });
    const r = await hook(e, TEST_HOOKS.session, {
      email: tu("adm"),
      role: "admin",
    });
    expect(r.status).toBe(200);
    const { cookie } = TestSessionResultSchema.parse(await r.json());
    const me = MeSchema.parse(
      await (
        await call(e, R.me, {
          method: "GET",
          headers: { cookie: `${sessionCookieName(env)}=${cookie}` },
        })
      ).json(),
    );
    expect(me.user.role).toBe("admin");
    expect(me.auth?.method).toBe("test");
  });

  it("otp/latest: the code just sent; it verifies; then the hook 404s", async () => {
    const m = mailer();
    const e = {
      ...direct(),
      ...ON,
      TEST_DOMAIN: "x.com",
      ...m.env,
    } as Env;
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const req = await call(e, AUTH.codeRequest, {
      body: { email: guest },
      headers: { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
    });
    expect(req.status).toBe(202);
    const pending =
      req.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0] ?? "";
    const otp = await hook(e, TEST_HOOKS.otpLatest, { email: guest });
    expect(otp.status).toBe(200);
    const { code } = (await otp.json()) as { code: string };
    expect(code).toBe(m.codeFor(guest));
    const v = await call(e, AUTH.codeVerify, {
      body: { code },
      headers: {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        cookie: pending,
      },
    });
    expect(v.status).toBe(200);
    await refused404(
      await hook(e, TEST_HOOKS.otpLatest, { email: guest }),
      "no_code",
      { outcome: "used" },
    );
  });

  it("on, but a code outside TEST_DOMAIN: no plaintext copy", async () => {
    const m = mailer();
    const e = { ...direct(), ...ON, ...m.env } as Env;
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const puts = vi.spyOn(env.OAUTH_KV, "put");
    await call(e, AUTH.codeRequest, {
      body: { email: guest },
      headers: { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
    });
    const code = m.codeFor(guest);
    expect(code).toBeTruthy();
    expect(JSON.stringify(puts.mock.calls)).not.toContain(code);
    expect(await otpRows(code)).toBe(0);
  });

  it("off: a full code flow writes no plaintext anywhere", async () => {
    const m = mailer();
    const e = { ...direct(), ...m.env } as Env;
    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const puts = vi.spyOn(env.OAUTH_KV, "put");
    await call(e, AUTH.codeRequest, {
      body: { email: guest },
      headers: { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
    });
    const code = m.codeFor(guest);
    expect(JSON.stringify(puts.mock.calls)).not.toContain(code);
    expect(await otpRows(code)).toBe(0);
    const rows = JSON.stringify(
      (
        await env.DB.prepare("select * from login_codes where email_key = ?")
          .bind(await emailKey(e, guest))
          .all()
      ).results,
    );
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(guest);
  });

  it("oauth-client: a real grant for p5-oauth@TEST_DOMAIN that works on /mcp and is revocable", async () => {
    const e = on();
    const r = await hook(e, TEST_HOOKS.oauthClient);
    expect(r.status).toBe(200);
    const { accessToken, clientId } = OAuthClientHookResultSchema.parse(
      await r.json(),
    );
    expect(clientId).toBeTruthy();
    const mcp = (t: string) =>
      call(e, "/mcp", {
        scheme: "https",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: {
          authorization: `Bearer ${t}`,
          accept: "application/json, text/event-stream",
        },
      });
    expect((await mcp(accessToken)).status).toBe(200);
    const uid = (
      await env.DB.prepare("select id from users where email = ?")
        .bind(`p5-oauth@${TD}`)
        .first<{ id: string }>()
    )?.id;
    await revokeAllGrants(e, uid as string);
    expect((await mcp(accessToken)).status).toBe(401);
  });

  it("code-caps/reset: before the key, the uniform 404 and nothing deleted", async () => {
    const ik = await ipKey(env, "198.51.100.200");
    await seedCounter(`code:ip:${ik}`);
    for (const r of [
      await call(on(), TEST_HOOKS.codeCapsReset, {
        body: {},
        key: "x".repeat(32),
      }),
      await call(on(), TEST_HOOKS.codeCapsReset, { body: {} }),
      await hook(env, TEST_HOOKS.codeCapsReset, {}),
    ])
      await same404(r);
    expect(await counter(`code:ip:${ik}`)).toBe(7);
  });

  it("code-caps/reset: deletes only the caller's code:ip and code:fail buckets", async () => {
    const mine = await ipKey(env, "198.51.100.200");
    const other = await ipKey(env, "203.0.113.9");
    const keep = [
      `code:ip:${other}`,
      `code:fail:${other}`,
      `code:eip:ek1:${mine}`,
      `code:en:ek1:${mine}`,
      "code:e:ek1",
      "email:pool",
    ];
    for (const k of [`code:ip:${mine}`, `code:fail:${mine}`, ...keep])
      await seedCounter(k);
    const r = await hook(on(), TEST_HOOKS.codeCapsReset, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ reset: 2 });
    expect(await counter(`code:ip:${mine}`)).toBeNull();
    expect(await counter(`code:fail:${mine}`)).toBeNull();
    for (const k of keep) expect(await counter(k)).toBe(7);
    // Again: nothing left to reset.
    expect(
      await (await hook(on(), TEST_HOOKS.codeCapsReset, {})).json(),
    ).toEqual({ reset: 0 });
  });

  it("code-caps/reset: the body must be exactly {} (no IP or key to aim it)", async () => {
    const since = await freshSince();
    for (const body of [{ ip: "203.0.113.9" }, { key: "code:ip:x" }, []])
      await refused404(
        await hook(on(), TEST_HOOKS.codeCapsReset, body),
        "bad_input",
      );
    const rows = await auditRows(since);
    expect(rows.map((r) => [r.action, r.detail.outcome])).toEqual([
      ["test_hook.code_caps_reset", "refused"],
      ["test_hook.code_caps_reset", "refused"],
      ["test_hook.code_caps_reset", "refused"],
    ]);
  });

  it("code-caps/reset: audited and rate-limited like every hook", async () => {
    const since = await freshSince();
    rlCalls.length = 0;
    await hook(on(), TEST_HOOKS.codeCapsReset, {});
    expect(rlCalls).toHaveLength(1);
    const rows = await auditRows(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("test_hook.code_caps_reset");
    expect(rows[0]?.detail).toEqual({
      hook: "code_caps_reset",
      ip: "198.51.100.200",
      outcome: "ok",
    });
    const noRl = {
      limit: async () => ({ success: false }),
    } as unknown as RateLimit;
    await same404(
      await hook(on({ RL_ANON: noRl }), TEST_HOOKS.codeCapsReset, {}),
    );
  });

  const groupEmail = async (id: string) =>
    (
      await env.DB.prepare(
        "select email from directory_groups where group_id = ?",
      )
        .bind(id)
        .first<{ email: string }>()
    )?.email ?? null;

  it("directory-groups: before the key, the uniform 404 and nothing written", async () => {
    const id = `test-g-${crypto.randomUUID().slice(0, 8)}`;
    const body = { groups: [{ groupId: id, email: `g@${TD}` }] };
    for (const r of [
      await call(on(), TEST_HOOKS.directoryGroups, {
        body,
        key: "x".repeat(32),
      }),
      await call(on(), TEST_HOOKS.directoryGroups, { body }),
      await hook(env, TEST_HOOKS.directoryGroups, body),
    ])
      await same404(r);
    expect(await groupEmail(id)).toBeNull();
  });

  it("directory-groups: seeds test- ids at TEST_DOMAIN emails, idempotently", async () => {
    const a = `test-g-${crypto.randomUUID().slice(0, 8)}`;
    const b = `test-g-${crypto.randomUUID().slice(0, 8)}`;
    const body = {
      groups: [
        { groupId: a, email: `${a}@${TD}` },
        { groupId: b, email: `${b}@${TD}` },
      ],
    };
    const r = await hook(on(), TEST_HOOKS.directoryGroups, body);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ seeded: 2 });
    expect(await groupEmail(a)).toBe(`${a}@${TD}`);
    expect((await hook(on(), TEST_HOOKS.directoryGroups, body)).status).toBe(
      200,
    );
    expect(await groupEmail(b)).toBe(`${b}@${TD}`);
  });

  it("directory-groups: never a non-test id or an email outside TEST_DOMAIN; a real group is untouched", async () => {
    const real = `g-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, 'real@corp.example')",
    )
      .bind(real)
      .run();
    const since = await freshSince();
    for (const groups of [
      [{ groupId: real, email: `x@${TD}` }],
      [{ groupId: "TEST-x", email: `x@${TD}` }],
      [{ groupId: "test-ok", email: "x@corp.example" }],
      [{ groupId: "test-ok", email: `x@sub.${TD}` }],
      [
        { groupId: "test-dup", email: `x@${TD}` },
        { groupId: "test-dup", email: `y@${TD}` },
      ],
      [],
    ])
      await refused404(
        await hook(on(), TEST_HOOKS.directoryGroups, { groups }),
        "bad_input",
      );
    await refused404(
      await hook(on(), TEST_HOOKS.directoryGroups, {
        groups: [{ groupId: "test-ok", email: `x@${TD}` }],
        extra: 1,
      }),
      "bad_input",
    );
    expect(await groupEmail(real)).toBe("real@corp.example");
    expect(await groupEmail("test-ok")).toBeNull();
    const rows = await auditRows(since);
    expect(rows).toHaveLength(7);
    expect(
      rows.every(
        (r) =>
          r.action === "test_hook.directory_groups" &&
          r.detail.outcome === "refused",
      ),
    ).toBe(true);
  });

  it("/healthz reports testHooks", async () => {
    const h = HealthzSchema.parse(
      await (await call(env, "/healthz", { method: "GET" })).json(),
    );
    expect(h.testHooks).toBeUndefined();
    expect(
      HealthzSchema.parse(
        await (await call(on(), "/healthz", { method: "GET" })).json(),
      ).testHooks,
    ).toBe(true);
  });
});

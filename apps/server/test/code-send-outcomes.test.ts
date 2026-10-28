import { env } from "cloudflare:workers";
import { AUTH, TEST_HOOKS } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_LIMITS,
  counterBucket,
  deliverCode,
  emailKey,
  errorClass,
  netKey,
} from "../src/auth/codes.js";
import { authConfig } from "../src/auth/config.js";
import { sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { noteTestOtp } from "../src/test-hooks/index.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";

// Every deliverCode outcome logs exactly one code_send line (never the
// address, its key or the code), and, in test builds with hooks on, the
// otp/latest hook reports that outcome after its key verifies.

const IP = "203.0.113.9";
const KEY = "k".repeat(32);
const TD = "x.com";
const ON = {
  TEST_HOOKS: "1",
  TEST_HOOK_KEY: KEY,
  TEST_DOMAIN: TD,
  RL_ANON: { limit: async () => ({ success: true }) } as unknown as RateLimit,
};
const withMail = (e: Env, m = mailer()) => ({ ...e, ...m.env }) as Env;
const DAY0 =
  Date.UTC(2032, 0, 1) + Math.floor(Math.random() * 1000) * 86_400_000;
const fill = (key: string, n: number, kind: "day" | "hour", now: number) =>
  env.DB.prepare(
    "insert into counters (key, n, day) values (?1, ?2, ?3) on conflict (key) do update set n = ?2, day = ?3",
  )
    .bind(key, n, counterBucket(kind, now))
    .run();

/** Every console line while `fn` runs; code_send lines parsed. */
async function captured(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    }),
  );
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const sends = lines
    .filter((l) => l.includes('"evt":"code_send"'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { text: lines.join("\n"), sends };
}

/**
 * A D1 whose statements containing `match` throw on prepare (default: the
 * deliverCode resend gate, after eligibility and caps). `seen` gets every SQL.
 */
class BoomError extends Error {}
function throwingDb(
  msg: string,
  match = "where counters.n <= excluded.n - ?4",
  seen: string[] = [],
): D1Database {
  const db = env.DB;
  return new Proxy(db, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          seen.push(sql);
          if (sql.includes(match)) throw new BoomError(msg);
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

async function call(
  e: Env,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const waits: Promise<unknown>[] = [];
  const r = await worker.fetch(
    new Request(`http://app.localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.201",
        ...headers,
      },
      body: JSON.stringify(body),
    }) as never,
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
}
const requestCode = (e: Env, email: string) =>
  call(
    e,
    AUTH.codeRequest,
    { email },
    { "x-oa-request": "1", "sec-fetch-site": "same-origin" },
  );
const otpLatest = (e: Env, email: string, key = KEY) =>
  call(e, TEST_HOOKS.otpLatest, { email }, { authorization: `Bearer ${key}` });
const details = async (r: Response) =>
  ((await r.json()) as { error?: { details?: unknown } }).error?.details;
/** The plaintext copy at rest for `email`, or undefined when no row. */
const copyOf = async (e: Env, email: string) =>
  (
    await env.DB.prepare("select code from test_otps where ek = ?")
      .bind(await emailKey(e, email))
      .first<{ code: string | null }>()
      .catch(() => null)
  )?.code;

afterEach(() => vi.restoreAllMocks());

describe("deliverCode: one code_send line per outcome", () => {
  async function outcome(
    run: (email: string) => Promise<unknown>,
    seed = true,
  ) {
    const email = uniq("o", "x.com");
    if (seed) await seedUser(email, "guest");
    const { text, sends } = await captured(() => run(email));
    expect(text).not.toContain(email);
    expect(text).not.toContain(await emailKey(env, email));
    return sends;
  }

  it("sent", async () => {
    const m = mailer();
    const e = withMail(direct(), m);
    let code = "";
    const sends = await outcome(async (to) => {
      await deliverCode(e, authConfig(e), to, await emailKey(e, to), "s", IP);
      code = m.codeFor(to);
    });
    expect(sends).toEqual([{ evt: "code_send", outcome: "sent" }]);
    expect(code).toMatch(/^\d{8}$/);
  });

  it("email_off", async () => {
    // Defence in depth: the route isn't offered without email (emailCodes),
    // and deliverCode still refuses to send.
    const e = direct({ EMAIL: undefined, EMAIL_FROM: undefined });
    expect(
      await outcome(async (to) =>
        deliverCode(e, authConfig(e), to, await emailKey(e, to), "o", IP),
      ),
    ).toEqual([{ evt: "code_send", outcome: "email_off" }]);
  });

  it("ineligible", async () => {
    const e = withMail(direct());
    expect(
      await outcome(
        async (to) =>
          deliverCode(e, authConfig(e), to, await emailKey(e, to), "i", IP),
        false,
      ),
    ).toEqual([{ evt: "code_send", outcome: "ineligible" }]);
  });

  it("pool_full", async () => {
    const e = withMail(direct({ CODE_EMAILS_PER_DAY: "3" }));
    const t = DAY0 + 3_600_000;
    await fill("code:*", 3, "day", t);
    expect(
      await outcome(async (to) =>
        deliverCode(e, authConfig(e), to, await emailKey(e, to), "p", IP, t),
      ),
    ).toEqual([{ evt: "code_send", outcome: "pool_full" }]);
  });

  it("capped", async () => {
    const e = withMail(direct());
    const t = DAY0 + 2 * 3_600_000;
    expect(
      await outcome(async (to) => {
        const ek = await emailKey(e, to);
        await fill(
          `code:sentn:${ek}:${await netKey(e, IP)}`,
          CODE_LIMITS.sendsPerEmailNetPerHour,
          "hour",
          t,
        );
        return deliverCode(e, authConfig(e), to, ek, "c", IP, t);
      }),
    ).toEqual([{ evt: "code_send", outcome: "capped" }]);
  });

  it("resend_wait", async () => {
    const e = withMail(direct());
    const t = DAY0 + 3 * 3_600_000;
    const sends = await outcome(async (to) => {
      const ek = await emailKey(e, to);
      await deliverCode(e, authConfig(e), to, ek, "r1", IP, t);
      await deliverCode(e, authConfig(e), to, ek, "r2", IP, t + 1000);
    });
    expect(sends).toEqual([
      { evt: "code_send", outcome: "sent" },
      { evt: "code_send", outcome: "resend_wait" },
    ]);
  });

  it("send_failed", async () => {
    const e = withMail(direct(), mailer(true));
    expect(
      await outcome(async (to) =>
        deliverCode(e, authConfig(e), to, await emailKey(e, to), "f", IP),
      ),
    ).toEqual([{ evt: "code_send", outcome: "send_failed" }]);
  });

  it("error: the route logs the class only, never the message or address", async () => {
    const email = uniq("err", "x.com");
    await seedUser(email, "guest");
    const m = mailer();
    const e = withMail(direct({ DB: throwingDb(`boom ${email}`) }), m);
    let status = 0;
    const { text, sends } = await captured(async () => {
      status = (await requestCode(e, email)).status;
    });
    expect(status).toBe(202);
    expect(sends).toEqual([
      { evt: "code_send", outcome: "error", error: "BoomError" },
    ]);
    expect(text).not.toContain(email);
    expect(text).not.toContain("boom");
    expect(m.sent).toHaveLength(0);
  });

  it("errorClass gives a safe class name or unknown", () => {
    expect(errorClass(new TypeError("x@y.com"))).toBe("TypeError");
    expect(errorClass(new BoomError())).toBe("BoomError");
    expect(errorClass("x@y.com")).toBe("unknown");
    expect(errorClass(null)).toBe("unknown");
    expect(errorClass({ constructor: { name: "a b@c" } })).toBe("unknown");
  });
});

describe("otp/latest reports the last outcome after the key", () => {
  const on = (e: Env) => ({ ...e, ...ON }) as Env;

  async function reason(e: Env, email: string) {
    const r = await otpLatest(e, email);
    expect(r.status).toBe(404);
    return details(r);
  }

  it("sent: 200 with the code; once used, no_code (used)", async () => {
    const email = uniq("s", TD);
    await seedUser(email, "guest");
    const m = mailer();
    const e = on(withMail(direct(), m));
    const req = await requestCode(e, email);
    expect(req.status).toBe(202);
    const r = await otpLatest(e, email);
    expect(r.status).toBe(200);
    const { code } = (await r.json()) as { code: string };
    expect(code).toBe(m.codeFor(email));
    const pending =
      req.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0] ?? "";
    const v = await call(
      e,
      AUTH.codeVerify,
      { code },
      {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        cookie: pending,
      },
    );
    expect(v.status).toBe(200);
    expect(await reason(e, email)).toEqual({
      reason: "no_code",
      outcome: "used",
    });
    expect(await copyOf(e, email)).toBeNull();
  });

  it.each([
    ["ineligible", false, () => mailer()],
    ["send_failed", true, () => mailer(true)],
  ] as const)("%s", async (want, seed, mk) => {
    const email = uniq("n", TD);
    if (seed) await seedUser(email, "guest");
    const e = on(withMail(direct(), mk()));
    expect((await requestCode(e, email)).status).toBe(202);
    expect(await reason(e, email)).toEqual({
      reason: "no_code",
      outcome: want,
    });
    expect(await copyOf(e, email)).toBeNull();
  });

  // Review item 35: an install that can't send email doesn't offer codes, so
  // a request is a 404, never a 202 that sends nothing.
  it("email off: codes aren't offered (404), and no code is ever pending", async () => {
    const email = uniq("off", TD);
    await seedUser(email, "guest");
    const e = on(direct({ EMAIL: undefined, EMAIL_FROM: undefined }));
    expect((await requestCode(e, email)).status).toBe(404);
    expect((await copyOf(e, email)) ?? null).toBeNull();
  });

  it("error (deliverCode threw)", async () => {
    const email = uniq("e", TD);
    await seedUser(email, "guest");
    const e = on(withMail(direct({ DB: throwingDb("boom") })));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await requestCode(e, email)).status).toBe(202);
    expect(await reason(on(direct()), email)).toEqual({
      reason: "no_code",
      outcome: "error",
    });
  });

  it("pending while the send is in flight; none for an address never asked", async () => {
    const e = on(direct());
    const email = uniq("p", TD);
    await noteTestOtp(e, email, await emailKey(e, email), "pending");
    expect(await reason(e, email)).toEqual({
      reason: "no_code",
      outcome: "pending",
    });
    expect(await reason(e, uniq("never", TD))).toEqual({
      reason: "no_code",
      outcome: "none",
    });
  });

  it("a sent code past its TTL is expired", async () => {
    const e = on(direct());
    const email = uniq("x", TD);
    const ek = await emailKey(e, email);
    await noteTestOtp(e, email, ek, "sent", "12345678");
    await env.DB.prepare("update test_otps set at = ?2 where ek = ?1")
      .bind(ek, Date.now() - 601_000)
      .run();
    expect(await reason(e, email)).toEqual({
      reason: "no_code",
      outcome: "expired",
    });
  });

  it("only a sent outcome keeps the plaintext", async () => {
    const e = on(direct());
    const email = uniq("k", TD);
    const ek = await emailKey(e, email);
    await noteTestOtp(e, email, ek, "send_failed", "12345678");
    expect(await copyOf(e, email)).toBeNull();
  });

  it("a D1 failure clearing the copy still returns the session", async () => {
    const email = uniq("f", TD);
    await seedUser(email, "guest");
    const m = mailer();
    const e = on(withMail(direct(), m));
    const req = await requestCode(e, email);
    const pending =
      req.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0] ?? "";
    const bad = {
      ...e,
      DB: throwingDb("boom", "update test_otps set code = null"),
    } as Env;
    const { text } = await captured(async () => {
      const v = await call(
        bad,
        AUTH.codeVerify,
        { code: m.codeFor(email) },
        {
          "x-oa-request": "1",
          "sec-fetch-site": "same-origin",
          cookie: pending,
        },
      );
      expect(v.status).toBe(200);
      expect(
        v.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${sessionCookieName(bad)}=`)),
      ).toBe(true);
    });
    expect(text).toContain('"evt":"test_hook.otp_note_failed"');
  });

  it("verify outside TEST_DOMAIN never touches test_otps", async () => {
    const email = uniq("v", "y.com");
    await seedUser(email, "guest");
    const m = mailer();
    const seen: string[] = [];
    const e = on(
      withMail(direct({ DB: throwingDb("never", "\u0000", seen) }), m),
    );
    const req = await requestCode(e, email);
    const pending =
      req.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0] ?? "";
    const v = await call(
      e,
      AUTH.codeVerify,
      { code: m.codeFor(email) },
      {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        cookie: pending,
      },
    );
    expect(v.status).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((q) => q.includes("test_otps"))).toEqual([]);
  });

  it("before the key verifies: the uniform 404, no outcome", async () => {
    const email = uniq("u", TD);
    await seedUser(email, "guest");
    const e = on(withMail(direct(), mailer(true)));
    await requestCode(e, email);
    const ref = await call(env, TEST_HOOKS.otpLatest, { email });
    const r = await otpLatest(e, email, "z".repeat(32));
    expect(r.status).toBe(404);
    expect(await r.text()).toBe(await ref.text());
  });

  it("hooks off or outside TEST_DOMAIN: no row is written", async () => {
    const m = mailer();
    const outside = uniq("out", "y.com");
    await seedUser(outside, "guest");
    const e = withMail(direct(), m);
    await requestCode(on(e), outside);
    expect(m.codeFor(outside)).toBeTruthy();
    expect(await copyOf(e, outside)).toBeUndefined();
    const off = uniq("off", TD);
    await seedUser(off, "guest");
    await requestCode(e, off);
    expect(m.codeFor(off)).toBeTruthy();
    expect(await copyOf(e, off)).toBeUndefined();
  });
});

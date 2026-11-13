import { env } from "cloudflare:workers";
import { AUTH } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";
import { fakeGoogle } from "./fixtures/fake-google.js";

// P2 Task 10: one auth event per sign-in outcome, and nothing secret in any log.
const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
afterEach(() => vi.restoreAllMocks());

function capture() {
  const lines: string[] = [];
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  return {
    lines,
    events: () =>
      lines
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.evt === "auth"),
  };
}
const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
const post = async (e: Env, path: string, body: unknown, cookie?: string) => {
  const waits: Promise<unknown>[] = [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "198.51.100.77",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    e,
    {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as never,
  );
  await Promise.all(waits);
  return r;
};

async function google(e: Env, claims: Record<string, unknown>) {
  const g = await fakeGoogle();
  const start = await get(e, `${AUTH.loginGoogle}?next=/`);
  const u = new URL(start.headers.get("location") ?? "");
  const cookie =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const code = g.issueCode(
    { nonce: u.searchParams.get("nonce"), ...claims },
    u.searchParams.get("code_challenge") as string,
  );
  return get(
    e,
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    cookie,
  );
}

describe("auth events", () => {
  it("each login outcome logs exactly one auth event, with no email or code anywhere", async () => {
    const cap = capture();
    const e = direct();
    const ok = uniq("ok");
    await google(e, { email: ok, sub: `s-${ok}` });
    await google(e, { email: uniq("t"), hd: "b.com" });
    const conflict = uniq("c");
    await seedUser(conflict, "member", { googleSub: `old-${conflict}` });
    await google(e, { email: conflict, sub: `new-${conflict}` });

    const guest = uniq("g", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const em = { ...e, ...m.env } as Env;
    const req = await post(em, AUTH.codeRequest, { email: guest });
    const pending = req.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const bad = await post(em, AUTH.codeVerify, { code: "00000000" }, pending);
    const pending2 = bad.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const code = m.codeFor(guest);
    await post(em, AUTH.codeVerify, { code }, pending2);

    const ev = cap.events();
    expect(ev.map((x) => [x.provider, x.outcome, x.stage ?? null])).toEqual([
      ["google", "ok", null],
      ["google", "refused", "tenant"],
      ["google", "refused", "identity_conflict"],
      ["code", "refused", "invalid_code"],
      ["code", "ok", null],
    ]);
    const all = cap.lines.join("\n");
    for (const secret of [ok, guest, conflict, code, env.SESSION_SECRET])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/\b\d{8}\b/);
    expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  });

  it("an Access state failure logs one refused event", async () => {
    const cap = capture();
    await get(env, `${AUTH.callback}?state=s&code=c`);
    expect(cap.events()).toEqual([
      {
        evt: "auth",
        provider: "access",
        outcome: "refused",
        stage: "no_state_cookie",
      },
    ]);
  });

  it("an expired pending code logs one refused event with stage expired", async () => {
    const guest = uniq("x", "x.com");
    await seedUser(guest, "guest");
    const m = mailer();
    const em = { ...direct(), ...m.env } as Env;
    const req = await post(em, AUTH.codeRequest, { email: guest });
    const pending = req.headers
      .getSetCookie()
      .find((c) => c.startsWith("oa_code="))
      ?.split(";")[0];
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_000);
    const cap = capture();
    const r = await post(
      em,
      AUTH.codeVerify,
      { code: m.codeFor(guest) },
      pending,
    );
    expect(r.status).toBe(401);
    expect(cap.events()).toEqual([
      { evt: "auth", provider: "code", outcome: "refused", stage: "expired" },
    ]);
  });

  it("a Google token-endpoint failure logs its stage as an enum, no status or code", async () => {
    const e = direct();
    const g = await fakeGoogle();
    const start = await get(e, `${AUTH.loginGoogle}?next=/`);
    const u = new URL(start.headers.get("location") ?? "");
    const cookie =
      start.headers
        .getSetCookie()
        .find((c) => /oa_oidc_/.test(c))
        ?.split(";")[0] ?? "";
    g.setTokenStatus(500);
    const cap = capture();
    await get(
      e,
      `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=c-1`,
      cookie,
    );
    expect(cap.events()).toEqual([
      {
        evt: "auth",
        provider: "google",
        outcome: "refused",
        stage: "token_http",
      },
    ]);
  });

  it("login warnings go through logAuth and log.ts redaction", async () => {
    const { logAuth } = await import("../src/auth/audit.js");
    const cap = capture();
    logAuth({
      evt: "oidc_fail",
      stage: "jwt_verify",
      description: "for bob@a.com",
    });
    logAuth({ evt: "directory_sync_failed" });
    logAuth({ evt: "code_abuse", scope: "email" });
    logAuth({ evt: "email_drift", outcome: "kept" });
    expect(cap.lines.map((l) => JSON.parse(l))).toEqual([
      { evt: "oidc_fail", stage: "jwt_verify", description: "for <email>" },
      { evt: "directory_sync_failed" },
      { evt: "code_abuse", scope: "email" },
      { evt: "email_drift", outcome: "kept" },
    ]);
  });
});

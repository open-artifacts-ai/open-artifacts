// Direct sign-in CPU (Free plan: 10 ms per request). Wall-clock budgets run
// serially via vitest.cpu.config.ts (median of 7); absolute bounds are
// reports, asserted only under test:cpu:strict (see budget()).
import { AUTH } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { direct, mailer, seedUser, uniq } from "./auth-helpers.js";
import { budget, medianMs as time } from "./cpu-time.js";
import { fakeGoogle } from "./fixtures/fake-google.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const get = (e: Env, path: string, cookie?: string) =>
  app.fetch(
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    ctx,
  );
let ip = 0;
const post = async (e: Env, path: string, body: unknown, cookie?: string) => {
  const waits: Promise<unknown>[] = [];
  const r = await app.fetch(
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": `10.9.${Math.floor(ip / 250)}.${ip++ % 250}`,
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

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

describe("direct login CPU (Free: 10 ms)", () => {
  it("GET /auth/providers is under 1 ms (config only)", async ({
    annotate,
  }) => {
    const e = direct();
    const ms = await time(async () => (await get(e, AUTH.providers)).text());
    await budget(annotate, "GET /auth/providers", ms, 1);
    expect(ms).toBeLessThan(5);
  });

  it("the Google callback (RS256 verify, admission, session) fits the budget", async ({
    annotate,
  }) => {
    const e = direct();
    const g = await fakeGoogle();
    const ms = await time(async () => {
      const start = await get(e, `${AUTH.loginGoogle}?next=/`);
      const u = new URL(start.headers.get("location") ?? "");
      const cookie =
        start.headers
          .getSetCookie()
          .find((c) => /oa_oidc_/.test(c))
          ?.split(";")[0] ?? "";
      const email = uniq("cpu");
      const code = g.issueCode(
        { nonce: u.searchParams.get("nonce"), email, sub: `cpu-${email}` },
        u.searchParams.get("code_challenge") as string,
      );
      const r = await get(
        e,
        `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
        cookie,
      );
      expect(r.status).toBe(302);
    });
    await budget(annotate, "Google login (login + callback, wall)", ms, 10);
  });

  it("a code request and a verify fit the budget", async ({ annotate }) => {
    const m = mailer();
    const e = { ...direct(), ...m.env } as Env;
    const reqMs = await time(async () => {
      const guest = uniq("cpu", "x.com");
      await seedUser(guest, "guest");
      await post(e, AUTH.codeRequest, { email: guest });
    });
    await budget(annotate, "POST code request (wall, D1 included)", reqMs, 10);
    const verifyMs = await time(async () => {
      const guest = uniq("cpv", "x.com");
      await seedUser(guest, "guest");
      const r = await post(e, AUTH.codeRequest, { email: guest });
      const cookie = r.headers
        .getSetCookie()
        .find((c) => c.startsWith("oa_code="))
        ?.split(";")[0];
      const v = await post(
        e,
        AUTH.codeVerify,
        { code: m.codeFor(guest) },
        cookie,
      );
      expect(v.status).toBe(200);
    });
    await budget(
      annotate,
      "code request + verify (wall, D1 included)",
      verifyMs,
      20,
    );
  });
});

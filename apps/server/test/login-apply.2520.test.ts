// #2520: a hosted owner's login-domain change reaches the platform through the
// LoginGate (POST /login-domains) and is applied there. Fake gate only: no
// staging, no prod.
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import {
  LOGIN_DOMAINS_PATH,
  LoginDomainsBodySchema,
} from "@oa/provisioning-contract/login-domains";
import { LoginSettingsSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { direct, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAINS: "",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

async function fresh(userId: string, hd: string | null) {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  const now = Date.now();
  return `${sessionCookieName(env)}=${await signSession(env, userId, now, {
    provider: "google",
    epoch: row?.e ?? 0,
    ...(hd ? { hd } : {}),
    authAt: now,
  })}`;
}

type Seen = { path: string; text: string; kid: string; sig: string };
/** A fake gate: answers `answer` for each call (a status and a JSON body), records what it was sent. */
function gate(answers: { status: number; body: unknown }[]) {
  const seen: Seen[] = [];
  const g = {
    async fetch(req: Request): Promise<Response> {
      seen.push({
        path: new URL(req.url).pathname,
        text: await req.text(),
        kid: req.headers.get("x-oa-kid") ?? "",
        sig: req.headers.get("x-oa-sig") ?? "",
      });
      const a = answers.shift() ?? {
        status: 202,
        body: { ok: true, applying: true },
      };
      return Response.json(a.body, { status: a.status });
    },
  };
  return { g, seen };
}

const UNSURE =
  "We couldn't confirm the change. It may still take effect in a few minutes. Check back before trying again.";
const auditRows = async (userId: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from audit_events where action = 'settings.change' and actor_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>()
  )?.n ?? 0;
const ACCEPT = { status: 202, body: { ok: true, applying: true } };
const refuse = (status: number, error: string) => ({ status, body: { error } });

async function owner(hd: string | null = "acme.io") {
  const u = await login(uniq("own", "acme.io"), "owner");
  return { u, cookie: await fresh(u.userId, hd) };
}
const put = (
  e: Env,
  cookie: string,
  body: object,
  props?: Record<string, unknown>,
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.loginSettings}`, {
      method: "PUT",
      headers: {
        cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    e,
    props,
  );
const get = (e: Env, cookie: string, props?: Record<string, unknown>) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.loginSettings}`, {
      headers: { cookie, "x-oa-request": "1" },
    }),
    e,
    props,
  );
const H = direct({ ...HOSTED }) as Env;
const asks = { autoJoin: true, domains: ["acme.io"] };

describe("with the platform's gate", () => {
  it("is editable on hosted with the gate; not without it, and not off hosted", async () => {
    const { cookie } = await owner();
    const { g } = gate([]);
    const on = LoginSettingsSchema.parse(
      await (await get(H, cookie, { LOGIN: g, LOGIN_EDITABLE: true })).json(),
    );
    expect(on.editable).toBe(true);
    const noGate = LoginSettingsSchema.parse(
      await (await get(H, cookie)).json(),
    );
    expect(noGate.editable).toBe(false);
    const selfHost = LoginSettingsSchema.parse(
      await (
        await get(direct({ HOSTED: undefined }) as Env, cookie, {
          LOGIN: g,
          LOGIN_EDITABLE: true,
        })
      ).json(),
    );
    expect(selfHost.editable).toBe(false);
  });

  it("the gate alone isn't editable: with the prop missing or false GET says editable false, and PUT is 409 apply_pending without calling the gate", async () => {
    const { cookie } = await owner();
    for (const props of [
      undefined,
      { LOGIN_EDITABLE: false },
      { LOGIN_EDITABLE: "true" },
      { LOGIN_EDITABLE: 1 },
    ]) {
      const { g, seen } = gate([ACCEPT]);
      const p = { LOGIN: g, ...props };
      const got = LoginSettingsSchema.parse(
        await (await get(H, cookie, p)).json(),
      );
      expect(got.editable, JSON.stringify(props)).toBe(false);
      const r = await put(H, cookie, asks, p);
      expect(r.status).toBe(409);
      expect((await errOf(r)).code).toBe("apply_pending");
      expect(seen).toEqual([]);
    }
    // The prop alone, with no gate, is no either.
    const r = await put(H, cookie, asks, { LOGIN_EDITABLE: true });
    expect(r.status).toBe(409);
    // Both: editable, and the change goes through.
    const { g, seen } = gate([ACCEPT]);
    const on = { LOGIN: g, LOGIN_EDITABLE: true };
    expect(
      LoginSettingsSchema.parse(await (await get(H, cookie, on)).json())
        .editable,
    ).toBe(true);
    expect((await put(H, cookie, asks, on)).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("success: one signed POST of exactly the six fields; the answer says it is applying", async () => {
    const { u, cookie } = await owner();
    const { g, seen } = gate([ACCEPT]);
    const r = await put(
      H,
      cookie,
      { autoJoin: true, domains: [" Acme.io ", "acme.io"] },
      { LOGIN: g, LOGIN_EDITABLE: true },
    );
    expect(r.status).toBe(200);
    const body = LoginSettingsSchema.parse(await r.json());
    expect(body.applying).toBe(true);
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.path).toBe(LOGIN_DOMAINS_PATH);
    const sent = LoginDomainsBodySchema.parse(JSON.parse(s.text));
    expect(sent).toMatchObject({
      ownerUserId: u.userId,
      hd: "acme.io",
      domains: ["acme.io"],
      autoJoin: true,
    });
    expect(Math.abs(sent.ts - Date.now())).toBeLessThan(5000);
    expect(
      await verifyRequest(
        await publicFromPkcs8(TEST_BROKER_KEY),
        s.path,
        s.kid,
        s.text,
        s.sig,
      ),
    ).toBe(true);
    // The body names no install.
    expect(s.text).not.toMatch(/install/i);
  });

  it("an accepted change writes one settings.change audit row, by the owner, with the domains and autoJoin", async () => {
    const { u, cookie } = await owner();
    const { g } = gate([ACCEPT]);
    await put(
      H,
      cookie,
      { autoJoin: false, domains: ["Acme.io"] },
      { LOGIN: g, LOGIN_EDITABLE: true },
    );
    const rows = (
      await env.DB.prepare(
        "select actor_id, target_type, target_id, detail from audit_events where action = 'settings.change' and actor_id = ?",
      )
        .bind(u.userId)
        .all<{
          actor_id: string;
          target_type: string;
          target_id: string;
          detail: string;
        }>()
    ).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_type: "settings",
      target_id: "instance",
    });
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      loginDomains: ["acme.io"],
      autoJoin: false,
    });
  });

  it("each call carries a fresh nonce; the marker clears when the config shows the change", async () => {
    const { cookie } = await owner();
    const { g, seen } = gate([ACCEPT, ACCEPT]);
    await put(H, cookie, asks, { LOGIN: g, LOGIN_EDITABLE: true });
    await put(H, cookie, asks, { LOGIN: g, LOGIN_EDITABLE: true });
    const nonces = seen.map(
      (s) => (JSON.parse(s.text) as { nonce: string }).nonce,
    );
    expect(new Set(nonces).size).toBe(2);
    // The redeploy has happened: the install now shows the domain.
    const applied = direct({
      ...HOSTED,
      AUTH_DOMAINS: "acme.io",
      AUTH_DOMAIN_JOIN: "member",
      AUTH_DOMAIN_JOIN_SOURCE: "owner",
    }) as Env;
    const after = LoginSettingsSchema.parse(
      await (
        await get(applied, cookie, { LOGIN: g, LOGIN_EDITABLE: true })
      ).json(),
    );
    expect(after.applying).toBeUndefined();
    expect(after.domains).toEqual(["acme.io"]);
  });
});

describe("refusals", () => {
  const cases: [string, ReturnType<typeof refuse>, number, string, unknown?][] =
    [
      [
        "plan_required",
        refuse(403, "plan_required"),
        403,
        "forbidden",
        { reason: "plan_required" },
      ],
      [
        "google_required",
        refuse(403, "google_required"),
        403,
        "forbidden",
        { reason: "google_required" },
      ],
      [
        "email_codes_on",
        refuse(403, "email_codes_on"),
        403,
        "forbidden",
        { reason: "email_codes_on" },
      ],
      [
        "install_not_serving",
        refuse(403, "install_not_serving"),
        403,
        "forbidden",
        { reason: "install_not_serving" },
      ],
      [
        "domain_unproven",
        refuse(403, "domain_unproven"),
        403,
        "domain_unproven",
        { domain: "acme.io" },
      ],
      ["rate_limited", refuse(429, "rate_limited"), 429, "rate_limited"],
      ["apply_pending", refuse(409, "apply_pending"), 409, "apply_pending"],
      ["replay", refuse(409, "replay"), 409, "apply_pending"],
      ["no_vars", refuse(409, "no_vars"), 409, "apply_pending"],
      [
        "too_many_domains",
        refuse(422, "too_many_domains"),
        400,
        "bad_request",
        { reason: "too_many_domains" },
      ],
      [
        "bad_domain",
        refuse(422, "bad_domain"),
        400,
        "bad_request",
        { reason: "bad_domain" },
      ],
      [
        "auto_join_needs_one_domain",
        refuse(422, "auto_join_needs_one_domain"),
        400,
        "bad_request",
        { reason: "auto_join_needs_one_domain" },
      ],
      [
        "vars_refused",
        refuse(422, "vars_refused"),
        400,
        "bad_request",
        { reason: "vars_refused" },
      ],
    ];
  it.each(cases)(
    "%s is a clear refusal and changes nothing",
    async (_n, answer, status, code, details) => {
      const { cookie } = await owner();
      const { g } = gate([answer]);
      const r = await put(H, cookie, asks, { LOGIN: g, LOGIN_EDITABLE: true });
      expect(r.status).toBe(status);
      const err = await errOf(r);
      expect(err.code).toBe(code);
      if (details !== undefined) expect(err.details).toEqual(details);
      if (code === "bad_request")
        expect(err.message).toBe(
          "These login domains can't be used. Check each one and try again.",
        );
      // Nothing was marked as applying.
      const after = LoginSettingsSchema.parse(
        await (await get(H, cookie, { LOGIN: g, LOGIN_EDITABLE: true })).json(),
      );
      expect(after.applying).toBeUndefined();
    },
  );

  it("fails closed: no answer, a 5xx, a bad signature, an unknown code, a wrong-shaped 202: login_unavailable 503", async () => {
    for (const a of [
      { status: 503, body: { error: "unavailable" } },
      { status: 500, body: { error: "boom" } },
      { status: 401, body: { error: "bad_signature" } },
      { status: 400, body: { error: "bad_body" } },
      { status: 404, body: { error: "unknown_install" } },
      { status: 418, body: { error: "teapot" } },
      { status: 202, body: { ok: true } },
      { status: 202, body: { ok: true, applying: true, extra: 1 } },
    ]) {
      const { u, cookie } = await owner();
      const { g } = gate([a]);
      const r = await put(H, cookie, asks, { LOGIN: g, LOGIN_EDITABLE: true });
      expect(r.status, JSON.stringify(a)).toBe(503);
      const err = await errOf(r);
      expect(err.code).toBe("login_unavailable");
      // Unknown whether it applied: never "nothing changed".
      expect(err.message).toBe(UNSURE);
      expect(err.message).not.toMatch(/nothing changed/i);
      expect(await auditRows(u.userId)).toBe(0);
    }
    // A gate that never answers.
    const { u, cookie } = await owner();
    const hang = { fetch: () => new Promise<Response>(() => {}) };
    const r = await put(H, cookie, asks, { LOGIN: hang, LOGIN_EDITABLE: true });
    expect(r.status).toBe(503);
    expect((await errOf(r)).message).toBe(UNSURE);
    expect(await auditRows(u.userId)).toBe(0);
  }, 30_000);

  it("a request that never left says nothing changed: no signing key", async () => {
    const { u, cookie } = await owner();
    const { g, seen } = gate([ACCEPT]);
    const noKey = direct({ ...HOSTED, BROKER_SIGNING_KEY: undefined }) as Env;
    const r = await put(noKey, cookie, asks, {
      LOGIN: g,
      LOGIN_EDITABLE: true,
    });
    expect(r.status).toBe(503);
    const err = await errOf(r);
    expect(err.code).toBe("login_unavailable");
    expect(err.message).toBe(
      "We couldn't save the change. Nothing changed. Try again in a minute.",
    );
    expect(seen).toEqual([]);
    expect(await auditRows(u.userId)).toBe(0);
  });

  it("no gate: today's 409 apply_pending, and nothing is sent", async () => {
    const { cookie } = await owner();
    const r = await put(H, cookie, asks);
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("apply_pending");
  });

  it("the instance's own checks come first: no fresh login, an unproven domain and a non-owner never reach the platform", async () => {
    const { g, seen } = gate([ACCEPT]);
    const u = await login(uniq("own2", "acme.io"), "owner");
    // No fresh login.
    const stale = await login(uniq("own3", "acme.io"), "owner");
    expect(
      (await put(H, stale.cookie, asks, { LOGIN: g, LOGIN_EDITABLE: true }))
        .status,
    ).toBe(401);
    // A different domain than the proven one.
    const r = await put(
      H,
      await fresh(u.userId, "acme.io"),
      { autoJoin: false, domains: ["other.io"] },
      { LOGIN: g, LOGIN_EDITABLE: true },
    );
    expect((await errOf(r)).code).toBe("domain_unproven");
    // A member.
    const m = await login(uniq("mem", "acme.io"), "member");
    expect([403, 404]).toContain(
      (
        await put(H, await fresh(m.userId, "acme.io"), asks, {
          LOGIN: g,
          LOGIN_EDITABLE: true,
        })
      ).status,
    );
    expect(seen).toEqual([]);
  });
});

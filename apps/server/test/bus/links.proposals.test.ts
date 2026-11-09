// #1567 link proposals: `oa-bus link` records a proposal with a machine token
// (POST R.busLinkProposals) and links nothing; the member confirms it on its
// one-time link, in a browser (GET/POST /bus/links/confirm/:token), with the
// role confirm page's checks. No agent credential proposes with anything but
// a machine token, and none confirms.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  BUS_LINK_PROPOSAL_TTL_MS,
  BUS_LINK_PROPOSALS_PENDING_MAX,
  BUS_LINK_PROPOSALS_PER_MACHINE_HOUR,
  type BusLinkProposed,
  R,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import type { BusHub } from "../../src/bus/hub.js";
import { LINK_CONFIRM_SCOPE } from "../../src/bus/link-confirm.js";
import { ROLE_CONFIRM_SCOPE } from "../../src/bus/role-confirm.js";
import { formCsrf } from "../../src/http/pages.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { api, errOf, fetchAndWait } from "../helpers.js";
import { confirmBrowser } from "./confirm-browser.js";
import { daemon, hubOf, machine, member, ns } from "./helpers.js";

const runInHub = async (uid: string, fn: (s: DurableObjectState) => void) =>
  runInDurableObject(await hubOf(uid), (_: BusHub, s: DurableObjectState) =>
    fn(s),
  );

const app = createApp();
const APP = "http://app.localhost";

async function sessionAt(uid: string, iat: number, authAt?: number) {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(uid)
    .first<{ e: number }>();
  return `${sessionCookieName(env)}=${await signSession(env, uid, iat, {
    provider: "access",
    epoch: row?.e ?? 0,
    ...(authAt !== undefined ? { authAt } : {}),
  })}`;
}

/** A member (with a freshly signed-in browser) and a connected machine. */
async function withBus() {
  const base = await member();
  const now = Date.now();
  const cookie = await sessionAt(base.userId, now, now);
  const mach = await machine("MacBook", base.userId);
  const d = await daemon(mach.token);
  d.send({
    v: 1,
    id: "h",
    type: "hello",
    machine_label: "MacBook",
    client_version: "0.0.0",
  });
  await d.next();
  return {
    userId: base.userId,
    cookie,
    d,
    machineToken: mach.token,
    machineId: mach.id,
  };
}

const propose = (
  auth: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.busLinkProposals}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const proposed = async (r: Response) => {
  expect(r.status).toBe(200);
  const sc = (await r.json()) as BusLinkProposed;
  const m = /\/bus\/links\/confirm#([A-Za-z0-9_-]{43})$/.exec(sc.confirmUrl);
  if (!m?.[1]) throw new Error(`no confirm link: ${sc.confirmUrl}`);
  return { ...sc, secret: m[1] };
};

const BASE = "/bus/links/confirm";
const browser = confirmBrowser(app, APP, BASE);
const get = (secret: string, headers: Record<string, string>) =>
  browser.get(secret, headers, env);
const post = (
  secret: string,
  headers: Record<string, string>,
  fields: [string, string][],
) => browser.post(secret, headers, fields, env);
const csrfOf = (body: string) => {
  const m = /name="csrf" value="([^"]+)"/.exec(body);
  if (!m?.[1]) throw new Error("no csrf field on the page");
  return m[1];
};
async function confirmInBrowser(
  cookie: string,
  secret: string,
  decision: "confirm" | "reject" = "confirm",
) {
  const page = await get(secret, { cookie });
  expect(page.status).toBe(200);
  return post(secret, { cookie }, [
    ["csrf", csrfOf(await page.text())],
    ["decision", decision],
  ]);
}

const links = async (uid: string) => (await hubOf(uid)).listLinks();

describe("link proposals (#1567)", () => {
  it("a machine token proposes and links nothing; the member confirms once in a browser", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const [a, b] = [ns("pa"), ns("pb")];
    const before = Date.now();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: b, b: a }),
    );
    // The response carries the URL and its expiry, nothing about a link.
    expect(Object.keys(p).sort()).toEqual([
      "confirmUrl",
      "expiresAt",
      "secret",
    ]);
    expect(Date.parse(p.expiresAt) - before).toBeGreaterThanOrEqual(
      BUS_LINK_PROPOSAL_TTL_MS - 5_000,
    );
    expect(Date.parse(p.expiresAt) - before).toBeLessThanOrEqual(
      BUS_LINK_PROPOSAL_TTL_MS + 5_000,
    );
    expect(await links(userId)).toEqual([]);

    const page = await get(p.secret, { cookie });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Link");
    expect(html).toContain(a);
    expect(html).toContain(b);
    expect(await links(userId)).toEqual([]);

    const done = await post(p.secret, { cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("are linked");
    expect(await links(userId)).toMatchObject([
      { a: a < b ? a : b, b: a < b ? b : a },
    ]);

    // One use: the same form again, or a fresh load, is refused.
    const again = await post(p.secret, { cookie }, [
      ["csrf", csrfOf(html)],
      ["decision", "confirm"],
    ]);
    expect(again.status).toBe(410);
    expect((await get(p.secret, { cookie })).status).toBe(410);

    // An unlink proposal removes it.
    const u = await proposed(
      await propose(machineToken, { action: "unlink", a, b }),
    );
    expect(await (await get(u.secret, { cookie })).text()).toContain("Unlink");
    const ud = await confirmInBrowser(cookie, u.secret);
    expect(ud.status).toBe(200);
    expect(await ud.text()).toContain("are unlinked");
    expect(await links(userId)).toEqual([]);
    d.close();
  });

  it("if the hub applies the link but the call then fails, the card says it could not confirm, as JSON, never nothing changed", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ua"), b: ns("ub") }),
    );
    const csrf = csrfOf(await (await get(p.secret, { cookie })).text());
    // A hub that applies the decision and then times out on the caller.
    const real = env.BUS_HUB;
    const flaky = {
      idFromName: (n: string) => real.idFromName(n),
      get: (id: DurableObjectId) => {
        const stub = real.get(id) as unknown as Record<string, unknown>;
        return new Proxy(stub, {
          get: (_t, k) =>
            k === "decideLinkProposal"
              ? async (...a: unknown[]) => {
                  await (stub[k] as (...x: unknown[]) => unknown)(...a);
                  throw new Error("bus hub timed out");
                }
              : (...a: unknown[]) =>
                  (stub[k as string] as (...x: unknown[]) => unknown)(...a),
        });
      },
    };
    const e = Object.create(env, { BUS_HUB: { value: flaky } });
    // Raw, as the page's script gets it: the harness's `post` unwraps JSON.
    const r = await browser.postJson(
      e,
      BASE,
      { cookie },
      {
        secret: p.secret,
        csrf,
        decision: "confirm",
      },
    );
    expect(r.status).toBe(500);
    expect(r.headers.get("content-type")).toContain("application/json");
    const { html: card } = (await r.json()) as { html: string };
    expect(card).toContain("We could not confirm this finished");
    expect(card).not.toContain("Nothing changed");
    // The link did apply.
    expect(await links(userId)).toHaveLength(1);
    d.close();
  });

  it("rejecting changes nothing and ends the link", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ra"), b: ns("rb") }),
    );
    const r = await confirmInBrowser(cookie, p.secret, "reject");
    expect(r.status).toBe(200);
    expect(await links(userId)).toEqual([]);
    expect((await get(p.secret, { cookie })).status).toBe(410);
    d.close();
  });

  it("a link that exists, or an unlink of one that doesn't, confirms as a no-op with a clear message", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const [a, b] = [ns("na"), ns("nb")];
    await (await hubOf(userId)).putLink(a, b);
    const l = await proposed(
      await propose(machineToken, { action: "link", a, b }),
    );
    const lp = await (await get(l.secret, { cookie })).text();
    expect(lp).toContain("already linked");
    const lr = await confirmInBrowser(cookie, l.secret);
    expect(lr.status).toBe(200);
    expect(await lr.text()).toContain("already linked");
    expect(await links(userId)).toHaveLength(1);

    const [c, e2] = [ns("nc"), ns("nd")];
    const u = await proposed(
      await propose(machineToken, { action: "unlink", a: c, b: e2 }),
    );
    const ur = await confirmInBrowser(cookie, u.secret);
    expect(ur.status).toBe(200);
    expect(await ur.text()).toContain("were not linked");
    expect(await links(userId)).toHaveLength(1);
    d.close();
  });

  it("only a machine token proposes: a PAT, a cookie, no credential or a revoked machine is 401, and the namespaces are checked", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const [xa, xb] = [ns("xa"), ns("xb")];
    const body = { action: "link", a: xa, b: xb };
    const pat = (await createPat(env, userId, "agent")).token;
    expect((await propose(pat, body)).status).toBe(401);
    expect((await propose(null, body)).status).toBe(401);
    // A cookie alone is no credential (the cookie POST guard may answer first).
    expect([401, 403]).toContain(
      (await propose(null, body, { cookie })).status,
    );
    expect((await propose("oa_machine_nope", body)).status).toBe(401);
    // Shape and namespace checks.
    for (const bad of [
      { action: "link", a: xa },
      { action: "link", a: xa, b: xa },
      { action: "grant", a: xa, b: xb },
      { action: "link", a: "Not Canonical", b: xb },
      { ...body, extra: 1 },
    ])
      expect(
        (await propose(machineToken, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    await env.DB.prepare(
      "update bus_machines set revoked_at = ? where user_id = ?",
    )
      .bind(Date.now(), userId)
      .run();
    expect((await propose(machineToken, body)).status).toBe(401);
    d.close();
  });

  it("no agent credential confirms: a machine token or a PAT, with or without the member's cookie", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ca"), b: ns("cb") }),
    );
    const pat = (await createPat(env, userId, "agent")).token;
    const csrf = await formCsrf(
      env,
      LINK_CONFIRM_SCOPE,
      userId,
      await sha256Hex(p.secret),
    );
    for (const token of [machineToken, pat])
      for (const withCookie of [false, true]) {
        const h = {
          authorization: `Bearer ${token}`,
          ...(withCookie ? { cookie } : {}),
        };
        const g = await get(p.secret, h);
        expect([401, 302, 404]).toContain(g.status);
        const r = await post(p.secret, h, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ]);
        expect([401, 403, 404]).toContain(r.status);
      }
    expect(await links(userId)).toEqual([]);
    // Another member's session finds nothing behind this link.
    const other = await member();
    const oc = await sessionAt(other.userId, Date.now(), Date.now());
    expect((await get(p.secret, { cookie: oc })).status).toBe(404);
    expect(await links(userId)).toEqual([]);
    d.close();
  });

  it("a stale session or a bad form token can't confirm", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("sa"), b: ns("sb") }),
    );
    // A sign-in older than ten minutes: the page asks to sign in again.
    const old = Date.now() - 11 * 60_000;
    const stale = await sessionAt(userId, old, old);
    const g = await get(p.secret, { cookie: stale });
    expect(g.status).toBe(403);
    expect(await g.text()).toContain("Sign in again");
    const csrf = await formCsrf(
      env,
      LINK_CONFIRM_SCOPE,
      userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie: stale }, [
          ["csrf", csrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    // A fresh session but no, a foreign or another link's form token.
    expect(
      (await post(p.secret, { cookie }, [["decision", "confirm"]])).status,
    ).toBe(403);
    expect(
      (
        await post(p.secret, { cookie }, [
          ["csrf", `1.${"A".repeat(43)}`],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    const other = await formCsrf(
      env,
      LINK_CONFIRM_SCOPE,
      userId,
      await sha256Hex("x".repeat(43)),
    );
    expect(
      (
        await post(p.secret, { cookie }, [
          ["csrf", other],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    expect(
      (
        await fetchAndWait(
          app,
          new Request(`${APP}${BASE}`, {
            method: "POST",
            headers: {
              cookie,
              "sec-fetch-site": "cross-site",
              "content-type": "application/x-www-form-urlencoded",
              "content-length": "0",
            },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(await links(userId)).toEqual([]);
    // The right form still works.
    expect((await confirmInBrowser(cookie, p.secret)).status).toBe(200);
    expect(await links(userId)).toHaveLength(1);
    d.close();
  });

  it("the confirm page names the machine that proposed, escaped", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ma"), b: ns("mb") }),
    );
    const html = await (await get(p.secret, { cookie })).text();
    expect(html).toMatch(/Proposed from[\s\S]{0,40}MacBook/);
    expect(html).toContain("MacBook");
    expect(html).toMatch(
      /MacBook[\s\S]{0,40}at[\s\S]{0,20}\d{4}-\d\d-\d\d \d\d:\d\d UTC/,
    );
    // A hostile label is escaped.
    await runInHub(userId, (s) => {
      s.storage.sql.exec("update machines set label = ?", "<b>evil</b>");
    });
    const h2 = await (await get(p.secret, { cookie })).text();
    expect(h2).not.toContain("<b>evil</b>");
    expect(h2).toContain("&lt;b&gt;evil&lt;/b&gt;");
    d.close();
  });

  it("another member opening or posting to this URL gets 404; a role-scope form token is refused", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ka"), b: ns("kb") }),
    );
    const b = await withBus();
    expect((await get(p.secret, { cookie: b.cookie })).status).toBe(404);
    const bCsrf = await formCsrf(
      env,
      LINK_CONFIRM_SCOPE,
      b.userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie: b.cookie }, [
          ["csrf", bCsrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(404);
    const roleCsrf = await formCsrf(
      env,
      ROLE_CONFIRM_SCOPE,
      userId,
      await sha256Hex(p.secret),
    );
    expect(
      (
        await post(p.secret, { cookie }, [
          ["csrf", roleCsrf],
          ["decision", "confirm"],
        ])
      ).status,
    ).toBe(403);
    expect(await links(userId)).toEqual([]);
    expect(await links(b.userId)).toEqual([]);
    d.close();
    b.d.close();
  });

  it("an expired proposal is refused and nothing changes", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("ea"), b: ns("eb") }),
    );
    await runInHub(userId, (s) => {
      s.storage.sql.exec("update link_proposals set expires_at = 1");
    });
    const r = await get(p.secret, { cookie });
    expect(r.status).toBe(410);
    expect(await r.text()).toContain("This link expired");
    expect(await links(userId)).toEqual([]);
    d.close();
  });

  it("at most 10 are pending per member, and 10 per machine per hour", async () => {
    const { userId, d, machineToken } = await withBus();
    const one = async (tok: string) =>
      propose(tok, { action: "link", a: ns("la"), b: ns("lb") });
    const second = await machine("Second", userId);
    const d2 = await daemon(second.token);
    d2.send({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "Second",
      client_version: "0.0.0",
    });
    await d2.next();
    for (let i = 0; i < BUS_LINK_PROPOSALS_PENDING_MAX; i++)
      expect((await one(machineToken)).status).toBe(200);
    // The member has 10 waiting: another machine is refused too.
    const full = await one(second.token);
    expect(full.status).toBe(409);
    expect((await errOf(full)).details).toEqual({ reason: "proposal_limit" });
    // The first machine used its hour, whatever became of its proposals.
    expect(BUS_LINK_PROPOSALS_PER_MACHINE_HOUR).toBe(10);
    await runInHub(userId, (s) => {
      s.storage.sql.exec(
        "update link_proposals set status = 'refused', decided_at = ?",
        Date.now(),
      );
    });
    const rl = await one(machineToken);
    expect(rl.status).toBe(409);
    expect((await errOf(rl)).details).toEqual({ reason: "rate_limited" });
    // The second machine is under its own limit.
    expect((await one(second.token)).status).toBe(200);
    d.close();
    d2.close();
  });
});

describe("link proposals: revoking the machine (#1403)", () => {
  it("revoking a machine expires its pending proposals at once; another machine's and decided ones are untouched", async () => {
    const { userId, cookie, d, machineToken, machineId } = await withBus();
    const other = await machine("Other", userId);
    const od = await daemon(other.token);
    od.send({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "Other",
      client_version: "0.0.0",
    });
    await od.next();
    const [a, b] = [ns("ra"), ns("rb")];
    const mine = await proposed(
      await propose(machineToken, { action: "link", a, b }),
    );
    const decided = await proposed(
      await propose(machineToken, { action: "link", a: ns("da"), b: ns("db") }),
    );
    expect(
      (await confirmInBrowser(cookie, decided.secret, "reject")).status,
    ).toBe(200);
    const theirs = await proposed(
      await propose(other.token, { action: "link", a, b }),
    );
    const statuses = async () =>
      (
        await runInDurableObject(
          await hubOf(userId),
          (_: BusHub, st: DurableObjectState) =>
            st.storage.sql
              .exec<{ status: string }>("select status from link_proposals")
              .toArray()
              .map((r) => r.status),
        )
      ).sort();
    expect(await statuses()).toEqual(["pending", "pending", "refused"]);
    const rev = await api(app, R.busMachine(machineId), cookie, {
      method: "DELETE",
    });
    expect(rev.status).toBe(204);
    expect(await statuses()).toEqual(["expired", "pending", "refused"]);
    // The revoked machine's link is dead; nothing was linked.
    expect((await get(mine.secret, { cookie })).status).toBe(410);
    expect((await confirmInBrowser(cookie, theirs.secret)).status).toBe(200);
    d.close();
    od.close();
  });
});

describe("link proposals: a machine revoked in bulk (#1403)", () => {
  it("members.ts/identity.ts revoke machines in D1 without the hub: the link still refuses at view and confirm, and other machines' links work", async () => {
    const { userId, cookie, d, machineToken, machineId } = await withBus();
    const other = await machine("Other", userId);
    const od = await daemon(other.token);
    od.send({
      v: 1,
      id: "h",
      type: "hello",
      machine_label: "Other",
      client_version: "0.0.0",
    });
    await od.next();
    const mine = await proposed(
      await propose(machineToken, { action: "link", a: ns("ba"), b: ns("bb") }),
    );
    const mine2 = await proposed(
      await propose(machineToken, { action: "link", a: ns("bc"), b: ns("bd") }),
    );
    const theirs = await proposed(
      await propose(other.token, { action: "link", a: ns("be"), b: ns("bf") }),
    );
    await env.DB.prepare("update bus_machines set revoked_at = ? where id = ?")
      .bind(Date.now(), machineId)
      .run();
    expect((await get(mine.secret, { cookie })).status).toBe(410);
    const dead = await post(mine2.secret, { cookie }, [
      [
        "csrf",
        await formCsrf(
          env,
          LINK_CONFIRM_SCOPE,
          userId,
          await sha256Hex(mine2.secret),
        ),
      ],
      ["decision", "confirm"],
    ]);
    expect(dead.status).toBe(410);
    expect(await links(userId)).toEqual([]);
    expect((await confirmInBrowser(cookie, theirs.secret)).status).toBe(200);
    d.close();
    od.close();
  });
});

describe("link proposals: the secret rides in the URL fragment (#1426)", () => {
  it("fragment -> details -> confirm links, with no secret in any request URL; the machine label shows", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("fa"), b: ns("fb") }),
    );
    expect(p.confirmUrl).toBe(`${APP}${BASE}#${p.secret}`);
    const b = confirmBrowser(app, APP, BASE);
    const page = await b.send(env, `${APP}${BASE}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).toContain("connect-src 'self'");
    expect(await page.text()).not.toContain(p.secret);
    const viewed = await b.get(p.secret, { cookie }, env);
    expect(viewed.status).toBe(200);
    const card = await viewed.text();
    expect(card).toContain("MacBook");
    expect(await links(userId)).toEqual([]);
    const done = await b.post(
      p.secret,
      { cookie },
      [
        ["csrf", csrfOf(card)],
        ["decision", "confirm"],
      ],
      env,
    );
    expect(done.status).toBe(200);
    expect(await links(userId)).toHaveLength(1);
    expect(b.urls.length).toBeGreaterThanOrEqual(3);
    for (const u of b.urls) expect(u, u).not.toContain(p.secret);
    d.close();
  });

  it("an old path-style link is refused with a notice and does not consume the proposal", async () => {
    const { userId, cookie, d, machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("oa"), b: ns("ob") }),
    );
    for (const c of [cookie, ""]) {
      const old = await fetchAndWait(
        app,
        new Request(`${APP}${BASE}/${p.secret}`, { headers: { cookie: c } }),
        env,
      );
      expect(old.status).toBe(410);
      expect(await old.text()).toContain("old format");
    }
    expect(await links(userId)).toEqual([]);
    expect((await confirmInBrowser(cookie, p.secret)).status).toBe(200);
    expect(await links(userId)).toHaveLength(1);
    d.close();
  });

  it("signed out, the hop goes to sign-in with the page's path as next and never the secret", async () => {
    const { machineToken } = await withBus();
    const p = await proposed(
      await propose(machineToken, { action: "link", a: ns("sa"), b: ns("sb") }),
    );
    const b = confirmBrowser(app, APP, BASE);
    const hop = await b.send(env, `${APP}${BASE}`);
    expect(hop.status).toBe(200);
    const html = await hop.text();
    expect(html).toContain(
      `data-go="/auth/login?next=${encodeURIComponent(BASE)}"`,
    );
    expect(html).not.toContain(p.secret);
    expect(hop.headers.get("location")).toBeNull();
  });
});

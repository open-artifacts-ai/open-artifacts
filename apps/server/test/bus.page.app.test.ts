import { env } from "cloudflare:workers";
import { NOTICE_SENDER } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { encodeAddress } from "../src/bus/page.js";
import { formCsrf } from "../src/http/pages.js";
import { getShareNotices } from "../src/services/follows.js";
import { machine, member } from "./bus/helpers.js";
import { fetchAndWait } from "./helpers.js";

// #1300: the /bus page through the real app (createApp() with mountRoutes),
// on the real services: busView and revokeBusMachine (services/bus.ts) and
// get/setShareNotices (services/follows.ts), against D1. bus.page.test.ts
// covers the page's logic with injected deps; this file proves it is mounted,
// policied, session-wired and calls the real functions.

const APP = "http://app.localhost";
const app = createApp();

/** BUS_HUB unbound: the bus is off (services/bus.ts busOn). */
const UNBOUND = { ...env, BUS_HUB: undefined } as typeof env;

const get = (
  path: string,
  cookie: string | null,
  e: typeof env = env,
  headers: Record<string, string> = {},
) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
    e,
  );

const post = (
  path: string,
  cookie: string,
  fields: [string, string][],
  e: typeof env = env,
  headers: Record<string, string> = {},
) => {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    }),
    e,
  );
};

const loc = (r: Response) => r.headers.get("location");
const revokedAt = async (id: string) =>
  (
    await env.DB.prepare("select revoked_at r from bus_machines where id = ?")
      .bind(id)
      .first<{ r: number | null }>()
  )?.r ?? null;

/** The csrf value of the page's first form (the server-rendered token). */
const csrfOf = (body: string) => {
  const m = /name="csrf" value="([^"]+)"/.exec(body);
  if (!m?.[1]) throw new Error("no csrf field on the page");
  return m[1];
};

/** Loads the confirm page and posts its own form, as a browser would. */
async function revokeThroughPage(cookie: string, id: string) {
  const confirm = await get(`/bus/machines/${id}/revoke`, cookie);
  expect(confirm.status).toBe(200);
  return post(`/bus/machines/${id}/revoke`, cookie, [
    ["csrf", csrfOf(await confirm.text())],
  ]);
}

describe("/bus on the real app", () => {
  it("BUS_HUB unbound: every /bus page route is the bus-off 404, and a valid token revokes and saves nothing", async () => {
    const m = await member();
    const { id } = await machine("off-box", m.userId);
    const off = async (r: Response) => {
      expect(r.status).toBe(404);
      expect(await r.text()).toContain("There is nothing here.");
    };
    // Signed out too: the gate comes before the sign-in redirect, as /bus/approve.
    await off(await get("/bus", null, UNBOUND));
    await off(await get("/bus", m.cookie, UNBOUND));
    await off(await get(`/bus/machines/${id}/revoke`, m.cookie, UNBOUND));
    const rt = await formCsrf(env, "bus-revoke", m.userId, id);
    await off(
      await post(
        `/bus/machines/${id}/revoke`,
        m.cookie,
        [["csrf", rt]],
        UNBOUND,
      ),
    );
    const st = await formCsrf(
      env,
      "bus-share-notices",
      m.userId,
      "share-notices",
    );
    await off(
      await post(
        "/bus/share-notices",
        m.cookie,
        [
          ["csrf", st],
          [
            "address",
            encodeAddress({ namespace: "test.local/off", name: "a" }),
          ],
        ],
        UNBOUND,
      ),
    );
    expect(await revokedAt(id)).toBeNull();
    expect(await getShareNotices(env, m.userId)).toEqual([]);
    // The same member and machine with the bus on: the page loads.
    expect((await get("/bus", m.cookie)).status).toBe(200);
  });

  it("signed out: GET /bus is 302 to sign-in with next", async () => {
    const r = await get("/bus", null);
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(`/auth/login?next=${encodeURIComponent("/bus")}`);
  });

  it("a member sees their own machine (not another member's) and the share card", async () => {
    const m = await member();
    const other = await member();
    const mine = `mine-${crypto.randomUUID().slice(0, 6)}`;
    const theirs = `theirs-${crypto.randomUUID().slice(0, 6)}`;
    await machine(mine, m.userId);
    await machine(theirs, other.userId);
    const r = await get("/bus", m.cookie);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(mine);
    expect(body).not.toContain(theirs);
    // Seeded, never connected: no hub, so Offline (not Unknown).
    // The row's own status (the page's CSS also names .s-offline), and no
    // "hub unknown" lines: a machine that never connected is plainly offline.
    expect(body).toContain('<span class="status s-offline">');
    expect(body).not.toContain('<span class="status s-unknown">');
    expect(body).not.toContain("Live status isn't available");
    expect(body).not.toContain("Running agents can't be listed");
    expect(body).toContain("Share notices");
  });

  it("revoke with the page's CSRF token revokes in D1 and shows the revoked line", async () => {
    const m = await member();
    const label = `rv-${crypto.randomUUID().slice(0, 6)}`;
    const { id } = await machine(label, m.userId);
    const r = await revokeThroughPage(m.cookie, id);
    expect(r.status).toBe(303);
    expect(loc(r)).toBe(`/bus?done=revoked&m=${id}`);
    expect(await revokedAt(id)).not.toBeNull();
    const after = await (await get(loc(r) as string, m.cookie)).text();
    expect(after).toContain(`${label} revoked.`);
    expect(after).toContain("s-revoked");
  });

  it("a revoke POST without a CSRF token, or with a forged one, is refused and nothing is revoked", async () => {
    const m = await member();
    const { id } = await machine("no-csrf", m.userId);
    for (const fields of [[], [["csrf", "1.forged"]]] as [string, string][][]) {
      const r = await post(`/bus/machines/${id}/revoke`, m.cookie, fields);
      expect(r.status).toBe(303);
      expect(loc(r)).toBe("/bus?error=expired");
    }
    expect(await revokedAt(id)).toBeNull();
  });

  it("another member's machine: their confirm page is not_found and a POST with a valid token for that id revokes nothing", async () => {
    const m = await member();
    const other = await member();
    const { id } = await machine("other", other.userId);
    const confirm = await get(`/bus/machines/${id}/revoke`, m.cookie);
    expect(loc(confirm)).toBe("/bus?error=not_found");
    // A well-formed token for m and that id: CSRF passes, ownership doesn't.
    const token = await formCsrf(env, "bus-revoke", m.userId, id);
    const r = await post(`/bus/machines/${id}/revoke`, m.cookie, [
      ["csrf", token],
    ]);
    expect(loc(r)).toBe("/bus?error=not_found");
    expect(await revokedAt(id)).toBeNull();
  });

  it("a capped (restricted) member gets the revoke-only page and can still revoke their machine", async () => {
    const m = await member();
    const { id } = await machine("capped-box", m.userId);
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(m.userId)
      .run();
    const page = await (await get("/bus", m.cookie)).text();
    expect(page).toContain(
      "You can't connect new machines. You can revoke these.",
    );
    expect(page).not.toContain("Share notices");
    const r = await revokeThroughPage(m.cookie, id);
    expect(loc(r)).toBe(`/bus?done=revoked&m=${id}`);
    expect(await revokedAt(id)).not.toBeNull();
  });

  it("share notices save through the real setShareNotices; a reserved name and over the cap are refused by its validation", async () => {
    const m = await member();
    await machine("share-box", m.userId);
    // No hub in this pool, so no running agents and no picker form on the
    // page: the token the page would render (bus.page.test.ts covers that).
    expect((await get("/bus", m.cookie)).status).toBe(200);
    const csrf = await formCsrf(
      env,
      "bus-share-notices",
      m.userId,
      "share-notices",
    );
    const a = { namespace: "test.local/page", name: "claude" };
    const ok = await post("/bus/share-notices", m.cookie, [
      ["csrf", csrf],
      ["address", encodeAddress(a)],
    ]);
    expect(loc(ok)).toBe("/bus?done=saved");
    expect(await getShareNotices(env, m.userId)).toEqual([a]);

    const reserved = await post("/bus/share-notices", m.cookie, [
      ["csrf", csrf],
      [
        "address",
        encodeAddress({ namespace: "test.local/page", name: NOTICE_SENDER }),
      ],
    ]);
    expect(loc(reserved)).toBe("/bus?error=bad_form");
    const many = await post("/bus/share-notices", m.cookie, [
      ["csrf", csrf],
      ...Array.from({ length: 11 }, (_, i): [string, string] => [
        "address",
        encodeAddress({ namespace: "test.local/page", name: `a${i}` }),
      ]),
    ]);
    expect(loc(many)).toBe("/bus?error=too_many");
    // Neither refused save changed the stored set.
    expect(await getShareNotices(env, m.userId)).toEqual([a]);
  });

  it("an own machine past the 100 listed rows: its confirm page loads and a capped member can revoke it", async () => {
    const m = await member();
    const old = await machine("old-box", m.userId);
    await env.DB.prepare(
      "update bus_machines set revoked_at = ?, created_at = 1 where id = ?",
    )
      .bind(Date.now(), old.id)
      .run();
    // 100 active machines list first (busView's cap), so old-box isn't listed.
    for (let i = 0; i < 100; i++) await machine(`box-${i}`, m.userId);
    const page = await (await get("/bus", m.cookie)).text();
    expect(page).not.toContain("old-box");
    const confirm = await get(`/bus/machines/${old.id}/revoke`, m.cookie);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("old-box");
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(m.userId)
      .run();
    const r = await post(`/bus/machines/${old.id}/revoke`, m.cookie, [
      ["csrf", await formCsrf(env, "bus-revoke", m.userId, old.id)],
    ]);
    expect(loc(r)).toBe(`/bus?done=revoked&m=${old.id}`);
  });

  it("share notices take an interactive sign-in: a dev session's valid-token save is 404 and stores nothing", async () => {
    const m = await member();
    const dev = `${sessionCookieName(env)}=${await signSession(
      env,
      m.userId,
      Date.now(),
      { provider: "dev", epoch: 0 },
    )}`;
    const csrf = await formCsrf(
      env,
      "bus-share-notices",
      m.userId,
      "share-notices",
    );
    const fields: [string, string][] = [
      ["csrf", csrf],
      ["address", encodeAddress({ namespace: "test.local/dev", name: "a" })],
    ];
    const r = await post("/bus/share-notices", dev, fields);
    expect(r.status).toBe(404);
    expect(await getShareNotices(env, m.userId)).toEqual([]);
    // The same save from the member's interactive session goes through.
    expect(loc(await post("/bus/share-notices", m.cookie, fields))).toBe(
      "/bus?done=saved",
    );
  });

  it("embed requests are 404 on every page route (no sign-in redirect loop), and revoke nothing", async () => {
    const m = await member();
    const { id } = await machine("embed-box", m.userId);
    const H = { "X-OA-Embed": "1" };
    for (const r of [
      await get("/bus?embed=1", null),
      await get("/bus?embed=1", m.cookie),
      await get("/bus", m.cookie, env, H),
      await get(`/bus/machines/${id}/revoke?embed=1`, m.cookie),
      await post(
        `/bus/machines/${id}/revoke`,
        m.cookie,
        [["csrf", await formCsrf(env, "bus-revoke", m.userId, id)]],
        env,
        H,
      ),
    ]) {
      expect(r.status).toBe(404);
      expect(loc(r)).toBeNull();
    }
    expect(await revokedAt(id)).toBeNull();
  });
});

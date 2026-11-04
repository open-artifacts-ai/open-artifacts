// #1291 the bus's Worker routes: device flow, the approval page, GET
// /bus/connect, the dashboard's REST, the bus-off 404s and the credential
// boundary (a machine token is bus-only; PATs and OAuth tokens are refused
// at /bus/connect).
import { env } from "cloudflare:workers";
import {
  BUS_ROUTES,
  type DeviceCodeResponse,
  isMachineToken,
} from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { CODES_PER_IP, RL_KEYS } from "../../src/bus/routes.js";
import { api, errOf, fetchAndWait } from "../helpers.js";
import { limiter } from "../mcp-helpers.js";
import {
  e,
  hello,
  type Member,
  machine,
  member,
  upgrade,
  waitFor,
  workerFetch,
} from "./helpers.js";

const app = createApp();
let ipSeq = 0;
const nextIp = () => `203.0.113.${(++ipSeq % 250) + 1}`;

const post = (path: string, body: unknown, ip = nextIp(), ev: unknown = env) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
    ev,
  );

async function startDevice(
  label = "leo-laptop",
  ip = nextIp(),
): Promise<DeviceCodeResponse> {
  const r = await post(BUS_ROUTES.device, { machine_label: label }, ip);
  expect(r.status).toBe(201);
  return (await r.json()) as DeviceCodeResponse;
}

/** Polls once, clearing the slow-down clock first (no sleeps). */
async function poll(deviceCode: string): Promise<Response> {
  await env.DB.prepare(
    "update bus_device_codes set last_poll_at = null where device_code_hash is not null",
  ).run();
  return post(BUS_ROUTES.deviceToken, { device_code: deviceCode });
}

const page = (path: string, cookie: string | null, host = "app.localhost") =>
  fetchAndWait(
    app,
    new Request(`http://${host}${path}`, {
      headers: cookie ? { cookie } : {},
    }),
  );

const csrfOf = (html: string) =>
  /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

async function decide(
  path: string,
  cookie: string,
  fields: Record<string, string>,
  extra: Record<string, string> = {},
) {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...extra,
      },
      body,
    }),
  );
}

/** The whole flow for `who`: returns the machine token. */
async function approveMachine(who: Member, label = "leo-laptop") {
  const d = await startDevice(label);
  const path = new URL(d.verification_uri).pathname;
  const shown = await page(path, who.cookie);
  expect(shown.status).toBe(200);
  const r = await decide(path, who.cookie, {
    csrf: csrfOf(await shown.text()),
    decision: "approve",
  });
  expect(r.status).toBe(200);
  const t = await poll(d.device_code);
  const j = (await t.json()) as { status: string; machine_token?: string };
  expect(j.status).toBe("approved");
  return j.machine_token as string;
}

let alice: Member;
let bob: Member;
let guest: Member;

beforeAll(async () => {
  alice = await member();
  bob = await member();
  guest = await member("guest");
});

describe("device flow", () => {
  it("POST /bus/device answers the contract: a secret, a code and the approval URL", async () => {
    const d = await startDevice();
    expect(d.device_code).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43}$/);
    expect(d.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(d.verification_uri).toBe(
      `http://app.localhost/bus/approve/${d.user_code}`,
    );
    expect(d.expires_in).toBe(600);
    expect(d.interval).toBe(5);
    // Only hashes are stored: the secret is nowhere in D1.
    const row = await env.DB.prepare(
      "select device_code_hash, ip_tag from bus_device_codes where user_code = ?",
    )
      .bind(d.user_code)
      .first<{ device_code_hash: string; ip_tag: string }>();
    expect(row?.device_code_hash).not.toBe(d.device_code);
    expect(row?.ip_tag).not.toContain("203.0.113");
  });

  it("pending, then approved once with a bus-only token; the next poll is expired", async () => {
    const d = await startDevice();
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "pending",
    });
    const path = new URL(d.verification_uri).pathname;
    const html = await (await page(path, alice.cookie)).text();
    await decide(path, alice.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    const j = (await (await poll(d.device_code)).json()) as {
      status: string;
      machine_token: string;
    };
    expect(j.status).toBe("approved");
    expect(isMachineToken(j.machine_token)).toBe(true);
    const stored = await env.DB.prepare(
      "select user_id, label, token_hash from bus_machines where user_id = ? order by created_at desc limit 1",
    )
      .bind(alice.userId)
      .first<{ user_id: string; label: string; token_hash: string }>();
    expect(stored?.label).toBe("leo-laptop");
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(j.machine_token);
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "expired",
    });
  });

  it("deny answers denied once, then expired", async () => {
    const d = await startDevice();
    const path = new URL(d.verification_uri).pathname;
    const html = await (await page(path, alice.cookie)).text();
    const r = await decide(path, alice.cookie, {
      csrf: csrfOf(html),
      decision: "deny",
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Machine not connected");
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "denied",
    });
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "expired",
    });
  });

  it("a poll faster than the interval is 429 with Retry-After", async () => {
    const d = await startDevice();
    expect((await poll(d.device_code)).status).toBe(200);
    const fast = await post(BUS_ROUTES.deviceToken, {
      device_code: d.device_code,
    });
    expect(fast.status).toBe(429);
    expect(fast.headers.get("retry-after")).toBe("5");
  });

  it("an unknown device code is expired; a malformed one is 400", async () => {
    const r = await post(BUS_ROUTES.deviceToken, {
      device_code: "1".repeat(43),
    });
    expect(await r.json()).toEqual({ status: "expired" });
    expect(
      (await post(BUS_ROUTES.deviceToken, { device_code: "nope" })).status,
    ).toBe(400);
  });

  it(`one IP holds at most ${CODES_PER_IP} pending codes`, async () => {
    const ip = nextIp();
    for (let i = 0; i < CODES_PER_IP; i++)
      expect((await post(BUS_ROUTES.device, {}, ip)).status).toBe(201);
    const r = await post(BUS_ROUTES.device, {}, ip);
    expect(r.status).toBe(429);
    expect((await errOf(r)).code).toBe("rate_limited");
  });

  it("RL_ANON limits /bus/device per IP and the poll per IP and per device code", async () => {
    const l = limiter(2);
    const ev = { ...env, ...l };
    const ip = nextIp();
    expect((await post(BUS_ROUTES.device, {}, ip, ev)).status).toBe(201);
    expect((await post(BUS_ROUTES.device, {}, ip, ev)).status).toBe(201);
    const third = await post(BUS_ROUTES.device, {}, ip, ev);
    expect(third.status).toBe(429);
    expect(l.counts.get(RL_KEYS.device + ip)).toBe(3);
    // The poll: per IP, and per code even from fresh addresses.
    const d = await startDevice();
    const l2 = limiter(2);
    const ev2 = { ...env, ...l2 };
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(
        "update bus_device_codes set last_poll_at = null",
      ).run();
      expect(
        (
          await post(
            BUS_ROUTES.deviceToken,
            { device_code: d.device_code },
            nextIp(),
            ev2,
          )
        ).status,
      ).toBe(200);
    }
    const over = await post(
      BUS_ROUTES.deviceToken,
      { device_code: d.device_code },
      nextIp(),
      ev2,
    );
    expect(over.status).toBe(429);
    expect(
      [...l2.counts.keys()].filter((k) => k.startsWith(RL_KEYS.tokenCode)),
    ).toHaveLength(1);
  });

  it("an approval by a member removed before the poll redeems nothing", async () => {
    const carol = await member();
    const d = await startDevice();
    const path = new URL(d.verification_uri).pathname;
    const html = await (await page(path, carol.cookie)).text();
    await decide(path, carol.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(carol.userId)
      .run();
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "expired",
    });
    const n = await env.DB.prepare(
      "select count(*) as n from bus_machines where user_id = ?",
    )
      .bind(carol.userId)
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("approval page", () => {
  it("no session redirects to sign-in with the page as next", async () => {
    const d = await startDevice();
    const path = new URL(d.verification_uri).pathname;
    const r = await page(path, null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent(path)}`,
    );
  });

  it("a member who can't connect (a guest) is refused, and nothing is decided", async () => {
    const d = await startDevice();
    const path = new URL(d.verification_uri).pathname;
    const r = await page(path, guest.cookie);
    expect(r.status).toBe(403);
    // Even with a token minted for another member, POST is refused.
    const html = await (await page(path, alice.cookie)).text();
    const p = await decide(path, guest.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    expect(p.status).toBe(403);
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "pending",
    });
  });

  it("shows the machine, the code and the account, with no secret, and the page CSP", async () => {
    const d = await startDevice("studio-mac");
    const path = new URL(d.verification_uri).pathname;
    const r = await page(path, alice.cookie);
    const html = await r.text();
    expect(html).toContain("studio-mac");
    expect(html).toContain(d.user_code);
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("No artifacts, no API and no MCP access");
    expect(html).not.toContain(d.device_code);
    expect(r.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a client-supplied label is escaped on the form and the success screen", async () => {
    const evil = '"><script>alert(1)</script>';
    const d = await startDevice(evil);
    const path = new URL(d.verification_uri).pathname;
    const html = await (await page(path, alice.cookie)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    const r = await decide(path, alice.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    const ok = await r.text();
    expect(ok).not.toContain("<script>");
    expect(ok).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("the success screen names the account and the instance's own /bus URL, never the Host header's", async () => {
    const d = await startDevice("work-box");
    const path = new URL(d.verification_uri).pathname;
    const html = await (await page(path, alice.cookie, "evil.example")).text();
    const r = await fetchAndWait(
      app,
      new Request(`http://evil.example${path}`, {
        method: "POST",
        headers: {
          cookie: alice.cookie,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(
            `csrf=${encodeURIComponent(csrfOf(html))}&decision=approve`.length,
          ),
        },
        body: `csrf=${encodeURIComponent(csrfOf(html))}&decision=approve`,
      }),
    );
    const ok = await r.text();
    expect(ok).toContain("Machine connected");
    expect(ok).toContain('"work-box" is connected to');
    expect(ok).toContain("http://app.localhost/bus");
    expect(ok).not.toContain("evil.example");
    expect(ok).toContain(
      "You can close this tab and go back to your terminal.",
    );
  });

  it("POST without the form token, with another code's token, or cross-site is refused", async () => {
    const d1 = await startDevice();
    const d2 = await startDevice();
    const p1 = new URL(d1.verification_uri).pathname;
    const p2 = new URL(d2.verification_uri).pathname;
    const t2 = csrfOf(await (await page(p2, alice.cookie)).text());
    expect(
      (await decide(p1, alice.cookie, { decision: "approve" })).status,
    ).toBe(403);
    expect(
      (await decide(p1, alice.cookie, { csrf: t2, decision: "approve" }))
        .status,
    ).toBe(403);
    // Bob can't use Alice's token for the same code.
    const t1 = csrfOf(await (await page(p1, alice.cookie)).text());
    expect(
      (await decide(p1, bob.cookie, { csrf: t1, decision: "approve" })).status,
    ).toBe(403);
    expect(
      (
        await decide(
          p1,
          alice.cookie,
          { csrf: t1, decision: "approve" },
          { "sec-fetch-site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    expect(await (await poll(d1.device_code)).json()).toEqual({
      status: "pending",
    });
  });

  it("a used or expired code shows the same expired page", async () => {
    const used = await startDevice();
    const usedPath = new URL(used.verification_uri).pathname;
    const html = await (await page(usedPath, alice.cookie)).text();
    await decide(usedPath, alice.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    const again = await page(usedPath, alice.cookie);
    expect(again.status).toBe(404);
    const usedText = await again.text();
    expect(usedText).toContain("This code expired");
    // A second decision with the still-valid token is refused the same way.
    const twice = await decide(usedPath, alice.cookie, {
      csrf: csrfOf(html),
      decision: "approve",
    });
    expect(twice.status).toBe(404);

    const old = await startDevice();
    await env.DB.prepare(
      "update bus_device_codes set expires_at = 0 where user_code = ?",
    )
      .bind(old.user_code)
      .run();
    const oldPage = await page(
      new URL(old.verification_uri).pathname,
      alice.cookie,
    );
    expect(oldPage.status).toBe(404);
    expect(await oldPage.text()).toBe(usedText);
    expect((await page("/bus/approve/ZZZZ-ZZZZ", alice.cookie)).status).toBe(
      404,
    );
  });
});

describe("GET /bus/connect: the machine token and nothing else", () => {
  it("a machine token connects; the hub answers hello_ok for that machine", async () => {
    const token = await approveMachine(alice);
    const r = await upgrade(token);
    expect(r.status).toBe(101);
    const ws = r.webSocket as WebSocket;
    ws.accept();
    const got = new Promise<string>((res) =>
      ws.addEventListener("message", (m) => res(String(m.data))),
    );
    ws.send(JSON.stringify(hello()));
    expect(JSON.parse(await got).type).toBe("hello_ok");
    ws.close();
  });

  it("a PAT, an OAuth-shaped token, a cookie or nothing is 401", async () => {
    const pat = (await createPat(env, alice.userId, "x")).token;
    expect((await upgrade(pat)).status).toBe(401);
    expect((await upgrade("eyJhbGciOi.fake.oauth")).status).toBe(401);
    expect((await upgrade(`${alice.userId}:grant:secret`)).status).toBe(401);
    expect((await upgrade(null)).status).toBe(401);
    expect((await upgrade(null, { cookie: alice.cookie })).status).toBe(401);
    // A well-formed machine token that was never issued.
    expect(
      (await upgrade("oa_machine_11111111111111111111111111111111")).status,
    ).toBe(401);
  });

  it("not an upgrade is 426", async () => {
    const m = await machine("x", alice.userId);
    const r = await workerFetch(
      new Request("http://app.localhost/bus/connect", {
        headers: { authorization: `Bearer ${m.token}` },
      }),
    );
    expect(r.status).toBe(426);
  });

  it("a revoked machine, a removed member or a member who can't connect is 401", async () => {
    const m1 = await machine("one", alice.userId);
    await env.DB.prepare("update bus_machines set revoked_at = ? where id = ?")
      .bind(Date.now(), m1.id)
      .run();
    expect((await upgrade(m1.token)).status).toBe(401);

    const gone = await member();
    const m2 = await machine("two", gone.userId);
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gone.userId)
      .run();
    expect((await upgrade(m2.token)).status).toBe(401);

    // A guest can't connect (canConnect), even holding a machine row.
    const m3 = await machine("three", guest.userId);
    expect((await upgrade(m3.token)).status).toBe(401);

    // A restricted (capped) member can't either.
    const capped = await member();
    const m4 = await machine("four", capped.userId);
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    expect((await upgrade(m4.token)).status).toBe(401);
  });
});

describe("a machine token is bus-only", () => {
  it("is 401 on REST", async () => {
    const m = await machine("rest", alice.userId);
    for (const path of [R.me, R.artifacts, R.busMachines, R.tokens]) {
      const r = await workerFetch(
        new Request(`http://app.localhost${path}`, {
          headers: { authorization: `Bearer ${m.token}` },
        }),
      );
      expect(r.status, path).toBe(401);
    }
  });

  it("is 401 at /mcp", async () => {
    const m = await machine("mcp", alice.userId);
    const r = await workerFetch(
      new Request("http://app.localhost/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${m.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(r.status).toBe(401);
  });
});

describe("the bus is off: unbound, or hosted (until #1299)", () => {
  const unbound = { ...env, BUS_HUB: undefined };
  const hosted = { ...env, HOSTED: "1" };
  for (const [name, ev] of [
    ["unbound", unbound],
    ["hosted", hosted],
  ] as const) {
    it(`${name}: every /bus route answers 404`, async () => {
      expect((await post(BUS_ROUTES.device, {}, nextIp(), ev)).status).toBe(
        404,
      );
      expect(
        (
          await post(
            BUS_ROUTES.deviceToken,
            { device_code: "1".repeat(43) },
            nextIp(),
            ev,
          )
        ).status,
      ).toBe(404);
      const ap = await fetchAndWait(
        app,
        new Request("http://app.localhost/bus/approve/ABCD-EFGH", {
          headers: { cookie: alice.cookie },
        }),
        ev,
      );
      expect(ap.status).toBe(404);
      const m = await machine("off", alice.userId);
      expect((await upgrade(m.token, {}, ev)).status).toBe(404);
    });
  }

  it("self-host (bound, not hosted) serves", async () => {
    expect((await post(BUS_ROUTES.device, {})).status).toBe(201);
  });

  it("agents are an empty, not-live list (never 404) when the hub isn't bound", async () => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.busAgents}`, {
        headers: { cookie: alice.cookie },
      }),
      unbound,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agents: [], live: false });
  });
});

describe("dashboard REST", () => {
  it("lists only the caller's machines, never a token or hash", async () => {
    const mine = await machine("mine", bob.userId);
    await machine("theirs", alice.userId);
    const r = await api(app, R.busMachines, bob.cookie);
    const j = (await r.json()) as { machines: Record<string, unknown>[] };
    expect(j.machines.map((m) => m.id)).toEqual([mine.id]);
    expect(Object.keys(j.machines[0] ?? {}).sort()).toEqual(
      [
        "connected",
        "createdAt",
        "id",
        "label",
        "lastUsedAt",
        "revokedAt",
      ].sort(),
    );
    expect(JSON.stringify(j)).not.toContain(mine.token);
  });

  it("revoke: 204, idempotent; another member's or unknown is 404", async () => {
    const m = await machine("rev", bob.userId);
    const other = await machine("alice-own", alice.userId);
    expect(
      (await api(app, R.busMachine(other.id), bob.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.busMachine("nope"), bob.cookie, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (await api(app, R.busMachine(m.id), bob.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (await api(app, R.busMachine(m.id), bob.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await upgrade(m.token)).status).toBe(401);
    expect((await upgrade(other.token)).status).toBe(101);
  });

  it("a capped (restricted) member can still list and revoke their own machines", async () => {
    const capped = await member();
    const m = await machine("capped", capped.userId);
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(capped.userId)
      .run();
    expect((await api(app, R.busMachines, capped.cookie)).status).toBe(200);
    expect(
      (await api(app, R.busMachine(m.id), capped.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await api(app, R.busAgents, capped.cookie)).status).toBe(404);
  });

  it("agents need canConnect (404 for a guest)", async () => {
    expect((await api(app, R.busAgents, guest.cookie)).status).toBe(404);
    expect((await api(app, R.busAgents, bob.cookie)).status).toBe(200);
  });

  it("no BusHub is created for a member without a machine that connected", async () => {
    const dave = await member();
    await machine("never", dave.userId);
    const r = await api(app, R.busMachines, dave.cookie);
    const j = (await r.json()) as { machines: { connected: unknown }[] };
    expect(j.machines[0]?.connected).toBe(false);
    const agents = await api(app, R.busAgents, dave.cookie);
    expect(await agents.json()).toEqual({ agents: [], live: false });
    // Looking inside builds the DO (schema), so the check is that the routes
    // never reached it: no machines mirror row, no revokedAt.
    const { runInDurableObject } = await import("cloudflare:test");
    const ns = e.BUS_HUB;
    if (!ns) throw new Error("unbound");
    const rows = await runInDurableObject(
      ns.get(ns.idFromName(`bus:${dave.userId}`)),
      (_i, s: DurableObjectState) =>
        s.storage.sql
          .exec<{ n: number }>("select count(*) as n from machines")
          .one().n,
    );
    expect(rows).toBe(0);
  });

  it("connected follows the live socket", async () => {
    const erin = await member();
    const m = await machine("live", erin.userId);
    const r = await upgrade(m.token);
    const ws = r.webSocket as WebSocket;
    ws.accept();
    const j = (await (await api(app, R.busMachines, erin.cookie)).json()) as {
      machines: {
        id: string;
        connected: boolean | null;
        lastUsedAt: string | null;
      }[];
    };
    expect(j.machines[0]?.connected).toBe(true);
    expect(j.machines[0]?.lastUsedAt).not.toBeNull();
    ws.close();
    void waitFor;
  });
});

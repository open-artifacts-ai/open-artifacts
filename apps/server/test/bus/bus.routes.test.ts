// #1291 the bus's Worker routes: device flow, the approval page, GET
// /bus/connect, the dashboard's REST, the bus-off 404s and the credential
// boundary (a machine token is bus-only; PATs and OAuth tokens are refused
// at /bus/connect).
import { env } from "cloudflare:workers";
import {
  BUS_ROUTES,
  type DeviceCodeResponse,
  DeviceCodeResponseSchema,
  isMachineToken,
  verificationUriMatches,
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

const post = (
  path: string,
  body: unknown,
  ip = nextIp(),
  ev: unknown = env,
  cf?: Record<string, unknown>,
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
      ...(cf ? { cf } : {}),
    } as RequestInit),
    ev,
  );

async function startDevice(
  label = "leo-laptop",
  ip = nextIp(),
  cf?: Record<string, unknown>,
): Promise<DeviceCodeResponse> {
  const r = await post(
    BUS_ROUTES.device,
    { machine_label: label },
    ip,
    env,
    cf,
  );
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

const APPROVE = "/bus/approve";

const page = (cookie: string | null, host = "app.localhost") =>
  fetchAndWait(
    app,
    new Request(`http://${host}${APPROVE}`, {
      headers: cookie ? { cookie } : {},
    }),
  );

const csrfOf = (html: string) =>
  /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

/** A form POST to /bus/approve. */
async function form(
  cookie: string,
  fields: Record<string, string>,
  extra: Record<string, string> = {},
  host = "app.localhost",
  ev: unknown = env,
) {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    app,
    new Request(`http://${host}${APPROVE}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        "cf-connecting-ip": nextIp(),
        ...extra,
      },
      body,
    }),
    ev,
  );
}

/** Opens the entry page and types `typed`: the response (confirm, or entry with an error). */
async function enter(
  who: Member,
  typed: string,
  opts: { host?: string; ev?: unknown; extra?: Record<string, string> } = {},
) {
  const entry = await page(who.cookie, opts.host);
  expect(entry.status).toBe(200);
  return form(
    who.cookie,
    { csrf: csrfOf(await entry.text()), step: "code", code: typed },
    opts.extra,
    opts.host,
    opts.ev,
  );
}

/** The confirm screen's HTML for `code` (it must match). */
async function confirmHtml(who: Member, code: string, host?: string) {
  const r = await enter(who, code, { host });
  const html = await r.text();
  expect(html, "not the confirm screen").toContain(
    'name="step" value="decide"',
  );
  return html;
}

/** Approve or deny from the confirm screen. */
async function decide(
  who: Member,
  code: string,
  decision: "approve" | "deny",
  html?: string,
  host?: string,
) {
  const h = html ?? (await confirmHtml(who, code, host));
  return form(
    who.cookie,
    { csrf: csrfOf(h), step: "decide", code, decision },
    {},
    host,
  );
}

/** The whole flow for `who`: returns the machine token. */
async function approveMachine(who: Member, label = "leo-laptop") {
  const d = await startDevice(label);
  const r = await decide(who, d.user_code, "approve");
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
  it("POST /bus/device answers the contract: a secret, a code, and the plain approval URL", async () => {
    const d = await startDevice();
    expect(d.device_code).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43}$/);
    expect(d.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // RFC 8628 5.4: the code is never in the URI (#1319's contract).
    expect(d.verification_uri).toBe("http://app.localhost/bus/approve");
    expect(d.verification_uri).not.toContain(d.user_code.replace("-", ""));
    expect(d.verification_uri).not.toContain(d.user_code.slice(0, 4));
    // The client's own checks (@oa/bus-protocol) take it as is. The test
    // origin is http on app.localhost, which the client allows only on a real
    // loopback name, so they see the same answer on an https origin.
    expect(new URL(d.verification_uri).pathname).toBe(BUS_ROUTES.approve);
    const onHttps = {
      ...d,
      verification_uri: d.verification_uri.replace(
        "http://app.localhost",
        "https://app.example",
      ),
    };
    expect(DeviceCodeResponseSchema.safeParse(onHttps).success).toBe(true);
    expect(
      verificationUriMatches(onHttps.verification_uri, "https://app.example"),
    ).toBe(true);
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

  it("the verification URI is the configured origin's, never the Host header's", async () => {
    const r = await fetchAndWait(
      app,
      new Request("http://evil.example/bus/device", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": nextIp(),
        },
        body: "{}",
      }),
    );
    expect(((await r.json()) as DeviceCodeResponse).verification_uri).toBe(
      "http://app.localhost/bus/approve",
    );
  });

  it("pending, then approved once with a bus-only token; the next poll is expired", async () => {
    const d = await startDevice();
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "pending",
    });
    await decide(alice, d.user_code, "approve");
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
    const r = await decide(alice, d.user_code, "deny");
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
    await decide(carol, d.user_code, "approve");
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

describe("approval page: the person types the code (RFC 8628 5.4)", () => {
  it("no session redirects to sign-in with the page as next", async () => {
    const r = await page(null);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent("/bus/approve")}`,
    );
  });

  it("the entry screen shows one code field and nothing about any machine", async () => {
    const d = await startDevice("secret-host-name");
    const r = await page(alice.cookie);
    const html = await r.text();
    expect(html).toContain("Connect a machine");
    expect(html).toContain(
      "Type the code shown in the terminal where you started the setup. Only use a code from a setup you started yourself.",
    );
    expect(html).toContain("Code from your terminal");
    expect(html).toContain('placeholder="XXXX-XXXX"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain('spellcheck="false"');
    expect(html).toContain('autocapitalize="characters"');
    expect(html).toContain(">Continue<");
    expect(html).toContain("Signed in as");
    expect(html).not.toContain("secret-host-name");
    expect(html).not.toContain(d.user_code);
    expect(r.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("a member who can't connect (a guest) is refused, and nothing is decided", async () => {
    const d = await startDevice();
    expect((await page(guest.cookie)).status).toBe(403);
    // A form token minted for another member doesn't help either.
    const html = await confirmHtml(alice, d.user_code);
    const p = await form(guest.cookie, {
      csrf: csrfOf(html),
      step: "decide",
      code: d.user_code,
      decision: "approve",
    });
    expect(p.status).toBe(403);
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "pending",
    });
  });

  it("the code is accepted in lower case and without the dash", async () => {
    const d = await startDevice("lower");
    const raw = d.user_code.replace("-", "").toLowerCase();
    const html = await (await enter(alice, raw)).text();
    expect(html).toContain('name="step" value="decide"');
    expect(html).toContain("lower");
  });

  it("a wrong code reveals nothing, keeps the typed value and shows Design's error", async () => {
    const d = await startDevice("hidden-box");
    for (const typed of ["ZZZZ-ZZZZ", "nonsense", ""]) {
      const r = await enter(alice, typed);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(
        "That code doesn&#39;t match a request waiting for you. Check your terminal and type it again.",
      );
      expect(html).toContain(`value="${typed}"`);
      expect(html).not.toContain("hidden-box");
      expect(html).not.toContain('value="decide"');
    }
    expect(await (await poll(d.device_code)).json()).toEqual({
      status: "pending",
    });
  });

  it("an expired code shows the expired error; a decided one is a wrong code", async () => {
    const old = await startDevice();
    await env.DB.prepare(
      "update bus_device_codes set expires_at = 0 where user_code = ?",
    )
      .bind(old.user_code)
      .run();
    expect(await (await enter(alice, old.user_code)).text()).toContain(
      "That code has expired. Run the setup on your machine again to get a new one.",
    );
    const used = await startDevice();
    await decide(alice, used.user_code, "approve");
    expect(await (await enter(alice, used.user_code)).text()).toContain(
      "That code doesn&#39;t match a request waiting for you.",
    );
  });

  it("code entry is limited per member and per IP", async () => {
    const l = limiter(1);
    const ev = { ...env, ...l };
    const html = await (await page(alice.cookie)).text();
    const ip = nextIp();
    const tryOnce = () =>
      form(
        alice.cookie,
        { csrf: csrfOf(html), step: "code", code: "ZZZZ-ZZZZ" },
        { "cf-connecting-ip": ip },
        undefined,
        ev,
      );
    expect((await tryOnce()).status).toBe(200);
    const over = await tryOnce();
    expect(over.status).toBe(429);
    expect(await over.text()).toContain(
      "Too many tries. Wait a few minutes, then type the code again.",
    );
    expect(l.counts.get(RL_KEYS.code + alice.userId)).toBe(2);
    // Another member from the same IP is limited by the IP key too.
    const l2 = limiter(1);
    const ev2 = { ...env, ...l2 };
    const bHtml = await (await page(bob.cookie)).text();
    await form(
      alice.cookie,
      { csrf: csrfOf(html), step: "code", code: "ZZZZ-ZZZZ" },
      { "cf-connecting-ip": ip },
      undefined,
      ev2,
    );
    const viaIp = await form(
      bob.cookie,
      { csrf: csrfOf(bHtml), step: "code", code: "ZZZZ-ZZZZ" },
      { "cf-connecting-ip": ip },
      undefined,
      ev2,
    );
    expect(viaIp.status).toBe(429);
  });

  it("the code step needs its own form token (CSRF), bound to the member", async () => {
    const d = await startDevice();
    const aliceEntry = csrfOf(await (await page(alice.cookie)).text());
    for (const csrf of ["", "nope", aliceEntry]) {
      const r = await form(bob.cookie, {
        csrf,
        step: "code",
        code: d.user_code,
      });
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain("leo-laptop");
    }
    // Cross-site is refused before anything else.
    const bobEntry = csrfOf(await (await page(bob.cookie)).text());
    const x = await form(
      bob.cookie,
      { csrf: bobEntry, step: "code", code: d.user_code },
      { "sec-fetch-site": "cross-site" },
    );
    expect(x.status).toBe(403);
  });

  it("the confirm screen shows the machine, where the request came from, the code and the new warning", async () => {
    const d = await startDevice("studio-mac", nextIp(), {
      country: "DE",
      asOrganization: "Deutsche Telekom AG",
    });
    const r = await enter(alice, d.user_code);
    const html = await r.text();
    expect(html).toContain(
      'Connect <span class="nw">studio-mac</span> to Open Artifacts?',
    );
    expect(html).toContain(
      `Requested just now from Germany, Deutsche Telekom AG · code <span class="mono nw">${d.user_code}</span>`,
    );
    expect(html).toContain(
      "Only approve if you started this setup yourself. If you don't recognise where it came from, choose Deny.",
    );
    expect(html).toContain("No artifacts, no API and no MCP access");
    expect(html).not.toContain(d.device_code);
    // No IP is stored with the code.
    const row = await env.DB.prepare(
      "select origin_country as c, origin_network as n from bus_device_codes where user_code = ?",
    )
      .bind(d.user_code)
      .first<{ c: string; n: string }>();
    expect(row).toEqual({ c: "DE", n: "Deutsche Telekom AG" });
  });

  it("the network is only ever cf.asOrganization: with colo but no organization, the country alone", async () => {
    const d = await startDevice("colo-only", nextIp(), {
      country: "DE",
      colo: "FRA",
      city: "Frankfurt",
      asn: 3320,
    });
    const html = await (await enter(alice, d.user_code)).text();
    expect(html).toContain(
      `Requested just now from Germany · code <span class="mono nw">${d.user_code}</span>`,
    );
    expect(html).not.toContain("FRA");
    expect(html).not.toContain("Frankfurt");
    expect(html).not.toContain("3320");
    const row = await env.DB.prepare(
      "select origin_network as n from bus_device_codes where user_code = ?",
    )
      .bind(d.user_code)
      .first<{ n: string | null }>();
    expect(row?.n).toBeNull();
  });

  it("an unknown origin, an ASN-only network or Tor show no guess", async () => {
    for (const cf of [
      {},
      { country: "XX" },
      { country: "T1", asOrganization: "AS13335" },
    ]) {
      const d = await startDevice("o", nextIp(), cf);
      const html = await (await enter(alice, d.user_code)).text();
      expect(html).toContain(
        `Requested just now · code <span class="mono nw">${d.user_code}</span>`,
      );
    }
    const d = await startDevice("o2", nextIp(), {
      country: "FR",
      asOrganization: "13335",
    });
    expect(await (await enter(alice, d.user_code)).text()).toContain(
      "Requested just now from France · code",
    );
  });

  it("the code is nowrap everywhere; the label is nowrap up to 32 characters, then wraps anywhere", async () => {
    const short = "a".repeat(32);
    const long = `${"b".repeat(33)}`;
    const d1 = await startDevice(short);
    const h1 = await (await enter(alice, d1.user_code)).text();
    expect(
      h1.match(/<span class="mono nw">[A-Z2-9]{4}-[A-Z2-9]{4}<\/span>/g),
    ).toHaveLength(1);
    expect(
      h1.match(new RegExp(`<span class="nw">${short}</span>`, "g")),
    ).toHaveLength(2);
    expect(h1).not.toContain('class="wrap"');
    const d2 = await startDevice(long);
    const h2 = await (await enter(alice, d2.user_code)).text();
    expect(
      h2.match(new RegExp(`<span class="wrap">${long}</span>`, "g")),
    ).toHaveLength(2);
    expect(h2).not.toContain(`<span class="nw">${long}`);
    expect(h2).toContain(".wrap{overflow-wrap:anywhere}");
  });

  it("no word 'bus' reaches a reader on the entry, confirm, success, deny and expired screens (the /bus URL aside)", async () => {
    const visible = (h: string) =>
      h
        .replace(/<style>[\s\S]*?<\/style>/, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+\/bus\b/g, "")
        // The test accounts are bus-N-...@x.com.
        .replace(/\S+@\S+/g, "");
    const noBus = (h: string) =>
      expect(
        visible(h).match(/.{0,40}\bbus\b.{0,40}/i)?.[0] ?? null,
      ).toBeNull();
    noBus(await (await page(alice.cookie)).text());
    noBus(await (await enter(alice, "ZZZZ-ZZZZ")).text());
    const d = await startDevice("box");
    const conf = await confirmHtml(alice, d.user_code);
    noBus(conf);
    noBus(await (await decide(alice, d.user_code, "approve", conf)).text());
    const d2 = await startDevice("box2");
    noBus(await (await decide(alice, d2.user_code, "deny")).text());
    const d3 = await startDevice("box3");
    const c3 = await confirmHtml(alice, d3.user_code);
    await decide(alice, d3.user_code, "approve", c3);
    noBus(await (await decide(alice, d3.user_code, "approve", c3)).text());
  });

  it("a client-supplied label is escaped on the confirm and success screens", async () => {
    const evil = '"><script>alert(1)</script>';
    const d = await startDevice(evil);
    const html = await confirmHtml(alice, d.user_code);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    const ok = await (await decide(alice, d.user_code, "approve", html)).text();
    expect(ok).not.toContain("<script>");
    expect(ok).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("the success screen names the account and the instance's own /bus URL, never the Host header's", async () => {
    const d = await startDevice("work-box");
    const r = await decide(
      alice,
      d.user_code,
      "approve",
      undefined,
      "evil.example",
    );
    const ok = await r.text();
    expect(ok).toContain("Machine connected");
    expect(ok).toContain('"<span class="nw">work-box</span>" is connected to');
    expect(ok).toContain("http://app.localhost/bus");
    expect(ok).not.toContain("evil.example");
    expect(ok).toContain(
      "You can close this tab and go back to your terminal.",
    );
  });

  it("the decision needs the confirm token for that code and member", async () => {
    const d1 = await startDevice();
    const d2 = await startDevice();
    const t2 = csrfOf(await confirmHtml(alice, d2.user_code));
    const t1 = csrfOf(await confirmHtml(alice, d1.user_code));
    const entryTok = csrfOf(await (await page(alice.cookie)).text());
    const tries: [Member, string][] = [
      [alice, ""],
      [alice, t2],
      [alice, entryTok],
      [bob, t1],
    ];
    for (const [who, csrf] of tries)
      expect(
        (
          await form(who.cookie, {
            csrf,
            step: "decide",
            code: d1.user_code,
            decision: "approve",
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await form(
          alice.cookie,
          { csrf: t1, step: "decide", code: d1.user_code, decision: "approve" },
          { "sec-fetch-site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    expect(await (await poll(d1.device_code)).json()).toEqual({
      status: "pending",
    });
  });

  it("a second decision on a decided code is the expired page", async () => {
    const d = await startDevice();
    const html = await confirmHtml(alice, d.user_code);
    await decide(alice, d.user_code, "approve", html);
    const twice = await decide(alice, d.user_code, "deny", html);
    expect(twice.status).toBe(404);
    expect(await twice.text()).toContain("This code expired");
  });

  it("there is no per-code URL any more", async () => {
    const d = await startDevice();
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost/bus/approve/${d.user_code}`, {
        headers: { cookie: alice.cookie },
      }),
    );
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("leo-laptop");
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
        new Request("http://app.localhost/bus/approve", {
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

  it("/me says canConnect, on GET and PATCH, from the server's rule", async () => {
    const me = async (cookie: string, method = "GET") =>
      (
        (await (
          await api(app, R.me, cookie, {
            method,
            ...(method === "PATCH"
              ? { body: { displayName: "Bus Tester" } }
              : {}),
          })
        ).json()) as { canConnect?: boolean }
      ).canConnect;
    expect(await me(bob.cookie)).toBe(true);
    expect(await me(bob.cookie, "PATCH")).toBe(true);
    expect(await me(guest.cookie)).toBe(false);
    expect(await me(guest.cookie, "PATCH")).toBe(false);
  });

  it("/me says busOn: true with BUS_HUB bound, false unbound or hosted (#1293)", async () => {
    const busOnFor = async (e: unknown) => {
      const r = await fetchAndWait(
        app,
        new Request(`http://app.localhost${R.me}`, {
          headers: { cookie: bob.cookie },
        }),
        e,
      );
      expect(r.status).toBe(200);
      return ((await r.json()) as { busOn?: boolean }).busOn;
    };
    expect(await busOnFor(env)).toBe(true);
    expect(await busOnFor({ ...env, BUS_HUB: undefined })).toBe(false);
    expect(await busOnFor({ ...env, HOSTED: "1" })).toBe(false);
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

  it("GET agents for a member whose machines never connected: no agents, live (the hub's state is known)", async () => {
    const fay = await member();
    await machine("never", fay.userId);
    const r = await api(app, R.busAgents, fay.cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agents: [], live: true });
  });

  it("no BusHub is created for a member without a machine that connected", async () => {
    const dave = await member();
    await machine("never", dave.userId);
    const r = await api(app, R.busMachines, dave.cookie);
    const j = (await r.json()) as { machines: { connected: unknown }[] };
    expect(j.machines[0]?.connected).toBe(false);
    const agents = await api(app, R.busAgents, dave.cookie);
    // Live (#1300 review M1): no machine ever connected, so none can be
    // connected and nothing is unknown, though no hub was read.
    expect(await agents.json()).toEqual({ agents: [], live: true });
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

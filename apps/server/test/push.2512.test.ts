// #2512 S5: browser push. Keys are generated here, per run; none is committed.
import { env } from "cloudflare:workers";
import { type NotificationPrefs, newId, R } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { RECOVERY_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { DEFAULT_PREFS, putPrefs } from "../src/services/notification-prefs.js";
import {
  BUNDLE_MS,
  DEFAULT_BODY,
  drainPush,
  MAX_SUBSCRIPTIONS,
  queueAskPush,
  queuePush,
} from "../src/services/push.js";
import {
  b64u,
  encryptPayload,
  pushEndpointOk,
  unb64u,
  vapidHeader,
} from "../src/services/web-push.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ keys

async function vapidKeys() {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    kp.privateKey,
  )) as JsonWebKey;
  const pub = new Uint8Array([
    4,
    ...unb64u(jwk.x as string),
    ...unb64u(jwk.y as string),
  ]);
  return {
    VAPID_PUBLIC_KEY: b64u(pub),
    VAPID_PRIVATE_KEY: jwk.d as string,
    publicKey: kp.publicKey,
  };
}

/** A browser: its ECDH key pair, auth secret and the subscription body it sends. */
async function browser(host = "fcm.googleapis.com") {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    kp,
    raw,
    auth,
    body: {
      endpoint: `https://${host}/fcm/send/${newId()}`,
      keys: { p256dh: b64u(raw), auth: b64u(auth) },
    },
  };
}

// An independent RFC 8291 / 8188 decryption: HKDF built from HMAC by hand.
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", k, data as Uint8Array<ArrayBuffer>),
  );
}
const cat = (...p: Uint8Array[]) => new Uint8Array(p.flatMap((x) => [...x]));
async function decrypt(
  body: Uint8Array,
  b: Awaited<ReturnType<typeof browser>>,
): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idlen = body[20] as number;
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey(
    "raw",
    asPub,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      b.kp.privateKey,
      256,
    ),
  );
  const prkKey = await hmac(b.auth, shared);
  const ikm = (
    await hmac(
      prkKey,
      cat(enc.encode("WebPush: info\0"), b.raw, asPub, Uint8Array.of(1)),
    )
  ).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(
      prk,
      cat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)),
    )
  ).slice(0, 16);
  const nonce = (
    await hmac(
      prk,
      cat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)),
    )
  ).slice(0, 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ct),
  );
  expect(pt[pt.length - 1]).toBe(2);
  return dec.decode(pt.slice(0, -1));
}

// ----------------------------------------------------------------- world

type Sent = { url: string; headers: Headers; body: Uint8Array };
function fakePush(status: (url: string) => number = () => 201) {
  const sent: Sent[] = [];
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      sent.push({
        url,
        headers: new Headers(init?.headers),
        body: new Uint8Array(init?.body as ArrayBuffer),
      });
      return new Response(null, { status: status(url) });
    });
  return { sent, spy };
}
afterEach(() => vi.restoreAllMocks());

async function world() {
  const keys = await vapidKeys();
  const E = {
    ...(env as Env),
    APP_HOST: "app.localhost",
    VAPID_PUBLIC_KEY: keys.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: keys.VAPID_PRIVATE_KEY,
  } as Env;
  return { E, keys };
}
const mk = (p: string) => login(`${p}-${tag}@x.com`, "member");
const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_PREFS,
  needsYou: { inApp: true, browser: true },
  browserAllAsks: true,
  ...over,
});
const subscribe = (E: Env, cookie: string, body: unknown) =>
  api(app, R.mePushSubscriptions, cookie, { method: "POST", body }, E);
const T0 = Date.UTC(2026, 10, 18, 12, 0);
const item = (key: string, over: object = {}) => ({
  key,
  kind: "ask" as const,
  artifactId: "art1",
  threadId: "th1",
  askerName: "Scout",
  excerpt: "Ship the draft?",
  ...over,
});
const pendingCount = async (userId: string) =>
  (
    await env.DB.prepare(
      "select count(*) n from push_pending where user_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>()
  )?.n;
async function enroll(E: Env, over: Partial<NotificationPrefs> = {}) {
  const u = await mk(`u-${newId().slice(0, 5)}`);
  const b = await browser();
  expect((await subscribe(E, u.cookie, b.body)).status).toBe(201);
  await putPrefs(E, u.userId, prefs(over));
  return { u, b };
}

// ---------------------------------------------------------------- crypto

describe("the encrypted payload (RFC 8291) and the VAPID header (RFC 8292)", () => {
  it("decrypts, with an independent implementation, to the plaintext", async () => {
    const b = await browser();
    for (const text of [
      "hi",
      "An agent is waiting for your answer",
      "é".repeat(500),
    ]) {
      const body = await encryptPayload(b.raw, b.auth, enc.encode(text));
      expect(await decrypt(body, b)).toBe(text);
    }
    // Fresh key and salt every time.
    const a = await encryptPayload(b.raw, b.auth, enc.encode("x"));
    const c = await encryptPayload(b.raw, b.auth, enc.encode("x"));
    expect(a.slice(0, 16)).not.toEqual(c.slice(0, 16));
    expect(a.slice(21, 86)).not.toEqual(c.slice(21, 86));
  });

  it("refuses a bad key, a bad auth secret and a payload past one record", async () => {
    const b = await browser();
    await expect(
      encryptPayload(b.raw.slice(0, 64), b.auth, enc.encode("x")),
    ).rejects.toThrow();
    await expect(
      encryptPayload(b.raw, b.auth.slice(0, 8), enc.encode("x")),
    ).rejects.toThrow();
    await expect(
      encryptPayload(b.raw, b.auth, new Uint8Array(4100)),
    ).rejects.toThrow();
  });

  it("the VAPID JWT is ES256 for the push service's origin, under a day, signed by the instance key", async () => {
    const { E, keys } = await world();
    const h = await vapidHeader(
      E,
      "https://fcm.googleapis.com/fcm/send/abc",
      T0,
    );
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
    expect(m).not.toBeNull();
    const [, hd, cl, sg, k] = m as RegExpExecArray;
    expect(k).toBe(keys.VAPID_PUBLIC_KEY);
    expect(JSON.parse(dec.decode(unb64u(hd as string)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(dec.decode(unb64u(cl as string)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://app.localhost");
    expect(claims.exp - T0 / 1000).toBeGreaterThan(0);
    expect(claims.exp - T0 / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        unb64u(sg as string),
        enc.encode(`${hd}.${cl}`),
      ),
    ).toBe(true);
  });
});

describe("the endpoint guard (SSRF)", () => {
  it("accepts only https on a known push service, the default port, no credentials", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/a",
      "https://updates.push.services.mozilla.com/wpush/v2/a",
      "https://web.push.apple.com/a",
      "https://wns2-par02p.notify.windows.com/w/?token=a",
    ])
      expect(pushEndpointOk(ok), ok).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/a",
      "https://fcm.googleapis.com.evil.example/a",
      "https://evil.example/fcm.googleapis.com",
      "https://xpush.apple.com/a",
      "https://push.apple.com/a",
      "https://notify.windows.com/a",
      "https://fcm.googleapis.com:8443/a",
      "https://user:pw@fcm.googleapis.com/a",
      "https://127.0.0.1/a",
      "https://localhost/a",
      "https://169.254.169.254/latest/meta-data",
      "ftp://fcm.googleapis.com/a",
      "not a url",
    ])
      expect(pushEndpointOk(bad), bad).toBe(false);
  });
});

// ---------------------------------------------------------------- routes

describe("the routes", () => {
  it("with no VAPID key pair every push route answers 404 push_unavailable", async () => {
    const u = await mk("off");
    const b = await browser();
    for (const [path, method, body] of [
      [R.mePushKey, "GET", undefined],
      [R.mePushSubscriptions, "GET", undefined],
      [R.mePushSubscriptions, "POST", b.body],
      [R.mePushSubscription("x"), "DELETE", undefined],
    ] as const) {
      const r = await api(app, path, u.cookie, { method, body });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "push_unavailable",
      );
    }
  });

  it("with a key pair: the public key, subscribe, list, remove; 201 { id }, 204", async () => {
    const { E, keys } = await world();
    const u = await mk("on");
    const k = await api(app, R.mePushKey, u.cookie, {}, E);
    expect(await k.json()).toEqual({ publicKey: keys.VAPID_PUBLIC_KEY });
    const b = await browser();
    const r = await subscribe(E, u.cookie, { ...b.body, label: "Laptop" });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const l = (await (
      await api(app, R.mePushSubscriptions, u.cookie, {}, E)
    ).json()) as {
      items: { id: string; label: string | null; lastSentAt: string | null }[];
    };
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ id, label: "Laptop", lastSentAt: null });
    // The same browser again: one row, new keys.
    const again = (await (await subscribe(E, u.cookie, b.body)).json()) as {
      id: string;
    };
    expect(again.id).toBe(id);
    expect(
      (
        (await (
          await api(app, R.mePushSubscriptions, u.cookie, {}, E)
        ).json()) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(1);
    const d = await api(
      app,
      R.mePushSubscription(id),
      u.cookie,
      { method: "DELETE" },
      E,
    );
    expect(d.status).toBe(204);
    expect(
      (
        await api(
          app,
          R.mePushSubscription(id),
          u.cookie,
          { method: "DELETE" },
          E,
        )
      ).status,
    ).toBe(404);
  });

  it("refuses an endpoint on another host: nothing stored", async () => {
    const { E } = await world();
    const u = await mk("ssrf");
    const b = await browser("evil.example");
    expect((await subscribe(E, u.cookie, b.body)).status).toBe(400);
    expect(
      (
        await subscribe(E, u.cookie, {
          ...b.body,
          endpoint: "http://fcm.googleapis.com/x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        (await (
          await api(app, R.mePushSubscriptions, u.cookie, {}, E)
        ).json()) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(0);
  });

  it("changes take a person in a browser: a token gets 404; deleting another's subscription is 404", async () => {
    const { E } = await world();
    const a = await mk("own-a");
    const b2 = await mk("own-b");
    const br = await browser();
    const pat = (await createPat(E, a.userId, "push")).token;
    expect((await subscribe(E, pat, br.body)).status).toBe(404);
    const { id } = (await (await subscribe(E, a.cookie, br.body)).json()) as {
      id: string;
    };
    expect(
      (
        await api(
          app,
          R.mePushSubscription(id),
          b2.cookie,
          { method: "DELETE" },
          E,
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(app, R.mePushSubscription(id), pat, { method: "DELETE" }, E))
        .status,
    ).toBe(404);
    // Reading is the caller's own.
    expect(
      (
        (await (
          await api(app, R.mePushSubscriptions, b2.cookie, {}, E)
        ).json()) as {
          items: unknown[];
        }
      ).items,
    ).toHaveLength(0);
  });

  it("Axe 1: an endpoint belongs to one person; registering it for a second removes it from the first", async () => {
    const { E } = await world();
    const a = await mk("ax1-a");
    const b = await mk("ax1-b");
    const br = await browser();
    await subscribe(E, a.cookie, br.body);
    await subscribe(E, b.cookie, br.body);
    const rows = async (cookie: string) =>
      (
        (await (
          await api(app, R.mePushSubscriptions, cookie, {}, E)
        ).json()) as {
          items: unknown[];
        }
      ).items.length;
    expect(await rows(a.cookie)).toBe(0);
    expect(await rows(b.cookie)).toBe(1);
  });

  it("a member keeps at most MAX_SUBSCRIPTIONS browsers, the newest", async () => {
    const { E } = await world();
    const u = await mk("cap");
    for (let i = 0; i <= MAX_SUBSCRIPTIONS; i++)
      await subscribe(E, u.cookie, (await browser()).body);
    const l = (await (
      await api(app, R.mePushSubscriptions, u.cookie, {}, E)
    ).json()) as {
      items: unknown[];
    };
    expect(l.items).toHaveLength(MAX_SUBSCRIPTIONS);
  });

  it("Axe 2: ending a member's sessions or changing their status deletes their subscriptions and queued items", async () => {
    const { E } = await world();
    for (const sql of [
      "update users set session_epoch = session_epoch + 1 where id = ?",
      "update users set status = 'suspended' where id = ?",
      "update users set status = 'removed' where id = ?",
    ]) {
      const { u } = await enroll(E);
      await queuePush(E, [u.userId], item(`ask:${newId()}`), T0);
      expect(await pendingCount(u.userId)).toBe(1);
      await env.DB.prepare(sql).bind(u.userId).run();
      const left = await env.DB.prepare(
        "select count(*) n from push_subscriptions where user_id = ?",
      )
        .bind(u.userId)
        .first<{ n: number }>();
      expect(left?.n, sql).toBe(0);
      expect(await pendingCount(u.userId), sql).toBe(0);
    }
    // An unrelated update keeps them.
    const { u } = await enroll(E);
    await env.DB.prepare("update users set name = 'Renamed' where id = ?")
      .bind(u.userId)
      .run();
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from push_subscriptions where user_id = ?",
        )
          .bind(u.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------- sending

describe("sending", () => {
  it("the default text hides the question: one fixed line, a link to the ask, no actions", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:c1"), T0);
    expect(await drainPush(E, T0)).toBe(1);
    expect(sent).toHaveLength(1);
    const s = sent[0] as Sent;
    expect(s.url).toBe(b.body.endpoint);
    expect(s.headers.get("content-encoding")).toBe("aes128gcm");
    expect(s.headers.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(Number(s.headers.get("ttl"))).toBeGreaterThan(0);
    const p = JSON.parse(await decrypt(s.body, b));
    expect(p).toEqual({
      v: 1,
      title: "Open Artifacts",
      body: DEFAULT_BODY,
      href: "/a/art1?thread=th1",
      tag: "needs-you",
    });
    expect(JSON.stringify(p)).not.toContain("Ship the draft");
    expect(JSON.stringify(p)).not.toContain("Scout");
    expect(await pendingCount(u.userId)).toBe(0);
    // lastSentAt shows on the list.
    const l = (await (
      await api(app, R.mePushSubscriptions, u.cookie, {}, E)
    ).json()) as {
      items: { lastSentAt: string | null }[];
    };
    expect(l.items[0]?.lastSentAt).toBe(new Date(T0).toISOString());
  });

  it("Axe 3: the asker and the question show only with lockScreenDetail, written by the server (controls stripped, cut)", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { lockScreenDetail: true });
    const { sent } = fakePush();
    await queuePush(
      E,
      [u.userId],
      item("ask:c2", {
        askerName: "Sc‮out\u0000",
        excerpt: `Ship ${"x".repeat(400)}`,
      }),
      T0,
    );
    await drainPush(E, T0);
    const p = JSON.parse(await decrypt((sent[0] as Sent).body, b));
    expect(p.body.startsWith("Scout asks: Ship ")).toBe(true);
    for (const c of [0x202e, 0])
      expect(p.body.includes(String.fromCharCode(c))).toBe(false);
    expect([...p.body].length).toBeLessThanOrEqual(200);
  });

  it("items due together go as one notification with a count, linked to the latest", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:a", { threadId: "t1" }), T0);
    await queuePush(
      E,
      [u.userId],
      item("ask:b", { threadId: "t2" }),
      T0 + 1000,
    );
    await queuePush(
      E,
      [u.userId],
      item("ask:b", { threadId: "t2" }),
      T0 + 2000,
    );
    expect(await pendingCount(u.userId)).toBe(2);
    await drainPush(E, T0 + 3000);
    expect(sent).toHaveLength(1);
    const p = JSON.parse(await decrypt((sent[0] as Sent).body, b));
    expect(p.count).toBe(2);
    expect(p.body).toBe("2 things are waiting for your answer");
    expect(p.href).toBe("/a/art1?thread=t2");
  });

  it("items within 10 minutes of a push wait and go as one bundle", async () => {
    const { E } = await world();
    const { u } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:1"), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(1);
    await queuePush(E, [u.userId], item("ask:2"), T0 + 60_000);
    await queuePush(E, [u.userId], item("ask:3"), T0 + 120_000);
    await drainPush(E, T0 + 5 * 60_000);
    expect(sent).toHaveLength(1);
    await drainPush(E, T0 + BUNDLE_MS - 1);
    expect(sent).toHaveLength(1);
    await drainPush(E, T0 + BUNDLE_MS);
    expect(sent).toHaveLength(2);
    expect(await pendingCount(u.userId)).toBe(0);
    // A drain with nothing due sends nothing.
    await drainPush(E, T0 + 3 * BUNDLE_MS);
    expect(sent).toHaveLength(2);
  });

  it("quiet hours hold the items and one bundle goes when they end", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      quietHours: { start: "22:00", end: "07:30" },
    });
    const { sent } = fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    await queuePush(E, [u.userId], item("ask:n1"), night);
    await queuePush(E, [u.userId], item("ask:n2"), night + 3_600_000);
    await drainPush(E, night + 3_600_000);
    await drainPush(E, Date.UTC(2026, 10, 19, 7, 29));
    expect(sent).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(2);
    await drainPush(E, Date.UTC(2026, 10, 19, 7, 30));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(await decrypt((sent[0] as Sent).body, b)).count).toBe(2);
  });

  it("quiet hours that start after an item was queued still hold it at drain time", async () => {
    const { E } = await world();
    const { u } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:late"), T0);
    await putPrefs(
      E,
      u.userId,
      prefs({ quietHours: { start: "11:00", end: "13:00" } }),
    );
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
    await drainPush(E, T0 + 3_600_000);
    expect(sent).toHaveLength(1);
  });

  it("nothing is queued with the browser switch off, or with no browser; turning it off drops what waits", async () => {
    const { E } = await world();
    const off = await enroll(E, { needsYou: { inApp: true, browser: false } });
    const bare = await mk("bare");
    await putPrefs(E, bare.userId, prefs());
    await queuePush(E, [off.u.userId, bare.userId], item("ask:z"), T0);
    expect(await pendingCount(off.u.userId)).toBe(0);
    expect(await pendingCount(bare.userId)).toBe(0);
    const on = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [on.u.userId], item("ask:y"), T0);
    await putPrefs(
      E,
      on.u.userId,
      prefs({ needsYou: { inApp: true, browser: false } }),
    );
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
    expect(await pendingCount(on.u.userId)).toBe(0);
  });

  it("with 'asks waiting for you' only, an ask from someone else is dropped unsent", async () => {
    const { E } = await world();
    const { u } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:other"), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("a 410 or 404 removes that browser; another failure keeps it and drops the item; a send never throws", async () => {
    const { E } = await world();
    const gone = await enroll(E);
    const flaky = await enroll(E);
    const fp = fakePush((url) =>
      url === gone.b.body.endpoint
        ? 410
        : url === flaky.b.body.endpoint
          ? 500
          : 201,
    );
    await queuePush(E, [gone.u.userId, flaky.u.userId], item("ask:g"), T0);
    expect(await drainPush(E, T0)).toBe(0);
    expect(fp.sent).toHaveLength(2);
    const has = async (id: string) =>
      (
        await env.DB.prepare(
          "select count(*) n from push_subscriptions where user_id = ?",
        )
          .bind(id)
          .first<{ n: number }>()
      )?.n;
    expect(await has(gone.u.userId)).toBe(0);
    expect(await has(flaky.u.userId)).toBe(1);
    expect(await pendingCount(flaky.u.userId)).toBe(0);
    fp.spy.mockRejectedValue(new Error("network"));
    await queuePush(E, [flaky.u.userId], item("ask:g2"), T0 + BUNDLE_MS * 3);
    expect(await drainPush(E, T0 + BUNDLE_MS * 3)).toBe(0);
  });

  it("never posts to a stored endpoint that is not a known push service", async () => {
    const { E } = await world();
    const { u } = await enroll(E);
    await env.DB.prepare(
      "update push_subscriptions set endpoint = ? where user_id = ?",
    )
      .bind("https://evil.example/x", u.userId)
      .run();
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:ev"), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
  });

  it("no key pair: nothing is queued and nothing is sent", async () => {
    const { E } = await world();
    const { u } = await enroll(E);
    const bare = {
      ...E,
      VAPID_PUBLIC_KEY: undefined,
      VAPID_PRIVATE_KEY: undefined,
    } as Env;
    const { sent } = fakePush();
    await queuePush(bare, [u.userId], item("ask:np"), T0);
    expect(await pendingCount(u.userId)).toBe(0);
    await queuePush(E, [u.userId], item("ask:np2"), T0);
    expect(await drainPush(bare, T0)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("an ask queues for who it waits on, not for the person who typed it, and not for a held one", async () => {
    const { E } = await world();
    const typer = await enroll(E);
    const waiter = await enroll(E);
    const held = await enroll(E);
    const asker = JSON.stringify({
      kind: "user",
      ref: typer.u.userId,
      name: "Typer",
      typed: true,
    });
    await queueAskPush(
      E,
      [typer.u.userId, waiter.u.userId, held.u.userId],
      new Set([held.u.userId]),
      "art1",
      "th1",
      "c9",
      { question: "Ok?", asker },
    );
    expect(await pendingCount(typer.u.userId)).toBe(0);
    expect(await pendingCount(waiter.u.userId)).toBe(1);
    expect(await pendingCount(held.u.userId)).toBe(0);
    // A person's own agent asking them does queue for them, with who waits.
    const agent = JSON.stringify({
      kind: "user",
      ref: typer.u.userId,
      agent: {
        name: "Scout",
        via: null,
        identity: { identityId: "idn1", name: "Scout", kind: "claude" },
      },
    });
    await queueAskPush(E, [typer.u.userId], new Set(), "art1", "th2", "c10", {
      question: "Go?",
      asker: agent,
    });
    const row = await env.DB.prepare(
      "select asker_name, asker_ref, agent_key from push_pending where user_id = ? and key = 'ask:c10'",
    )
      .bind(typer.u.userId)
      .first();
    expect(row).toEqual({
      asker_name: "Scout",
      asker_ref: typer.u.userId,
      agent_key: "idn1",
    });
  });
});

describe("the cron tick", () => {
  it("self-host's RECOVERY_CRON sends what is due; an idle tick or push off adds nothing", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    const run = async (e: Env, at: number) => {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      await scheduled({ cron: RECOVERY_CRON, scheduledTime: at }, e, ctx);
      await Promise.all(pending);
      return pending.length;
    };
    const off = { ...E, VAPID_PUBLIC_KEY: undefined } as Env;
    const base = await run(off, T0);
    await queuePush(E, [u.userId], item("ask:cr"), T0);
    // Push off: the due item stays.
    const mine = () => sent.filter((x) => x.url === b.body.endpoint);
    expect(await run(off, T0)).toBe(base);
    expect(mine()).toHaveLength(0);
    expect(await run(E, T0)).toBe(base + 1);
    expect(mine()).toHaveLength(1);
  });
});

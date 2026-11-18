// #2512 S5: browser push. Keys are generated here, per run; none is committed.
import { env } from "cloudflare:workers";
import { type NotificationPrefs, newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { RECOVERY_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  forgetCommentItems,
  recordShareItem,
  refreshCommentItems,
  writeInboxItems,
} from "../src/services/inbox-items.js";
import { DEFAULT_PREFS, putPrefs } from "../src/services/notification-prefs.js";
import {
  BUNDLE_MS,
  DEFAULT_BODY,
  DEFAULT_MENTION_BODY,
  DEFAULT_UPDATE_BODY,
  drainPush,
  MAX_SUBSCRIPTIONS,
  queueAskPush,
  queueBackFromLater,
  queuePush as rawQueuePush,
  queueUpdatePush as rawQueueUpdatePush,
} from "../src/services/push.js";
import { getUser } from "../src/services/users.js";
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
/** A public page everyone can read, and another (for mutes). */
let PUB = "";
let MUTED = "";
beforeAll(async () => {
  const owner = await login(`pub-${tag}@x.com`, "member");
  const m = await getUser(env as unknown as Env, owner.userId);
  const mkPublic = async (title: string) => {
    const { id } = await publish(
      env as unknown as Env,
      m as never,
      { title, format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    await env.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(id)
      .run();
    return id;
  };
  PUB = await mkPublic("Shared page");
  MUTED = await mkPublic("Muted page");
});
const item = (key: string, over: object = {}) => ({
  key,
  kind: "ask" as const,
  artifactId: PUB,
  threadId: "th1",
  askerName: "Scout",
  excerpt: "Ship the draft?",
  ...over,
});
type QItem = ReturnType<typeof item>;
/** What the queue is backed by, as the app writes it: an open ask row, or an inbox item. */
async function seed(
  userIds: string[],
  it: Pick<QItem, "key" | "artifactId" | "threadId" | "excerpt"> & {
    kind: string;
  },
) {
  for (const userId of userIds) {
    if (it.kind === "ask" || it.kind === "later")
      await env.DB.prepare(
        `insert or replace into artifact_asks (artifact_id, thread_id, comment_id, addressee, open, answered, question, asker, asked_at, confirm)
         values (?, ?, ?, ?, 1, 0, ?, '{}', '2026-11-18T10:00:00Z', 0)`,
      )
        .bind(
          it.artifactId,
          it.threadId,
          it.kind === "later" ? (it.key.split(":")[2] ?? "") : it.key.slice(4),
          userId,
          it.excerpt,
        )
        .run();
    else if (it.kind === "update")
      await env.DB.prepare(
        `insert or replace into inbox_items (id, user_id, kind, level, key, artifact_id, thread_id, comment_id, actor, excerpt, created_at)
         values (?, ?, 'comment', 'update', ?, ?, ?, ?, '{"kind":"user","ref":"x"}', ?, ?)`,
      )
        .bind(
          newId(),
          userId,
          it.key,
          it.artifactId,
          it.threadId,
          it.key.split(":")[1],
          it.excerpt,
          T0,
        )
        .run();
  }
}
const queuePush = async (e: Env, users: string[], it: QItem, now?: number) => {
  await seed(users, it);
  return rawQueuePush(e, users, it, now);
};
const queueUpdatePush = async (
  e: Env,
  user: string,
  it: Omit<QItem, "kind">,
  now?: number,
) => {
  await seed([user], { ...it, kind: "update" });
  return rawQueueUpdatePush(e, user, it, now);
};
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
      href: `/a/${PUB}?thread=th1`,
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
    expect(p.href).toBe(`/a/${PUB}?thread=t2`);
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

describe("per-browser switches, Updates, mutes and Back from later (design v10)", () => {
  const patch = (E: Env, cookie: string, id: string, body: unknown) =>
    api(app, R.mePushSubscription(id), cookie, { method: "PATCH", body }, E);
  const subOf = async (E: Env, cookie: string) =>
    (
      (await (await api(app, R.mePushSubscriptions, cookie, {}, E)).json()) as {
        items: { id: string; needsYou: boolean; updates: boolean }[];
      }
    ).items[0] as { id: string; needsYou: boolean; updates: boolean };

  it("a new browser starts with Needs-you on and Updates as the member's default; PATCH changes this browser only", async () => {
    const { E } = await world();
    const u = await mk("sw");
    await putPrefs(
      E,
      u.userId,
      prefs({ updates: { inApp: true, browser: true } }),
    );
    const a = await browser();
    const b = await browser();
    await subscribe(E, u.cookie, a.body);
    await subscribe(E, u.cookie, b.body);
    const list = (
      (await (
        await api(app, R.mePushSubscriptions, u.cookie, {}, E)
      ).json()) as {
        items: { id: string; needsYou: boolean; updates: boolean }[];
      }
    ).items;
    expect(list.map((i) => [i.needsYou, i.updates])).toEqual([
      [true, true],
      [true, true],
    ]);
    const r = await patch(E, u.cookie, list[0]?.id as string, {
      updates: false,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ needsYou: true, updates: false });
    const after = (
      (await (
        await api(app, R.mePushSubscriptions, u.cookie, {}, E)
      ).json()) as {
        items: { needsYou: boolean; updates: boolean }[];
      }
    ).items;
    expect(after.map((i) => [i.needsYou, i.updates])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("PATCH is the owner's, in a browser: another person or a token gets 404; an empty body is 400", async () => {
    const { E } = await world();
    const a = await mk("pa");
    const b2 = await mk("pb");
    await subscribe(E, a.cookie, (await browser()).body);
    const id = (await subOf(E, a.cookie)).id;
    expect((await patch(E, b2.cookie, id, { updates: true })).status).toBe(404);
    const pat = (await createPat(E, a.userId, "p")).token;
    expect((await patch(E, pat, id, { updates: true })).status).toBe(404);
    expect((await patch(E, a.cookie, id, {})).status).toBe(400);
    expect((await patch(E, a.cookie, "nope", { updates: true })).status).toBe(
      404,
    );
    expect((await subOf(E, a.cookie)).updates).toBe(false);
  });

  it("an Update is pushed only with the member-wide Updates switch and the browser's, with the fixed text", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      updates: { inApp: true, browser: true },
    });
    await patch(E, u.cookie, (await subOf(E, u.cookie)).id, { updates: true });
    const { sent } = fakePush();
    await queueUpdatePush(E, u.userId, item("reply:1", { kind: "update" }), T0);
    await drainPush(E, T0);
    const mine = sent.filter((x) => x.url === b.body.endpoint);
    expect(mine).toHaveLength(1);
    const p = JSON.parse(await decrypt((mine[0] as Sent).body, b));
    expect(p.body).toBe(DEFAULT_UPDATE_BODY);
    expect(p.tag).toBe("updates");
    expect(JSON.stringify(p)).not.toContain("Ship the draft");
    // This browser's Updates off: queued only if some browser wants it, so nothing.
    await patch(E, u.cookie, (await subOf(E, u.cookie)).id, { updates: false });
    await queueUpdatePush(E, u.userId, item("reply:2"), T0 + BUNDLE_MS * 2);
    expect(await pendingCount(u.userId)).toBe(0);
    // Member-wide off: nothing either.
    await patch(E, u.cookie, (await subOf(E, u.cookie)).id, { updates: true });
    await putPrefs(
      E,
      u.userId,
      prefs({ updates: { inApp: true, browser: false } }),
    );
    await queueUpdatePush(E, u.userId, item("reply:3"), T0 + BUNDLE_MS * 3);
    expect(await pendingCount(u.userId)).toBe(0);
    expect(sent.filter((x) => x.url === b.body.endpoint)).toHaveLength(1);
  });

  it("Updates use the same bundle and quiet hours as Needs-you, and a bundle of both is one notification", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      updates: { inApp: true, browser: true },
      quietHours: { start: "22:00", end: "07:30" },
    });
    await patch(E, u.cookie, (await subOf(E, u.cookie)).id, { updates: true });
    const { sent } = fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    await queueUpdatePush(E, u.userId, item("c:1"), night);
    await queuePush(
      E,
      [u.userId],
      item("ask:q", { kind: "ask" }),
      night + 1000,
    );
    await drainPush(E, night + 3_600_000);
    expect(sent).toHaveLength(0);
    await drainPush(E, Date.UTC(2026, 10, 19, 7, 30));
    expect(sent).toHaveLength(1);
    const p = JSON.parse(await decrypt((sent[0] as Sent).body, b));
    expect(p.count).toBe(2);
    expect(p.tag).toBe("needs-you");
    expect(p.body).toBe(DEFAULT_BODY);
  });

  it("a browser with only Updates off gets only the Needs-you part", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      updates: { inApp: true, browser: true },
    });
    const second = await browser();
    await subscribe(E, u.cookie, second.body);
    const subs = (
      (await (
        await api(app, R.mePushSubscriptions, u.cookie, {}, E)
      ).json()) as {
        items: { id: string }[];
      }
    ).items;
    // First browser: Needs-you only. Second: Updates only.
    await patch(E, u.cookie, subs[0]?.id as string, {
      needsYou: true,
      updates: false,
    });
    await patch(E, u.cookie, subs[1]?.id as string, {
      needsYou: false,
      updates: true,
    });
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:s", { kind: "ask" }), T0);
    await queueUpdatePush(E, u.userId, item("u:s"), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(2);
    const first = sent.find((x) => x.url === b.body.endpoint) as Sent;
    const secondSent = sent.find((x) => x.url === second.body.endpoint) as Sent;
    expect(JSON.parse(await decrypt(first.body, b)).body).toBe(DEFAULT_BODY);
    expect(JSON.parse(await decrypt(secondSent.body, second)).body).toBe(
      DEFAULT_UPDATE_BODY,
    );
  });

  it("a muted page and a muted agent are not pushed (asks and updates), the rest still are", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      updates: { inApp: true, browser: true },
    });
    await patch(E, u.cookie, (await subOf(E, u.cookie)).id, { updates: true });
    await env.DB.prepare(
      `insert into inbox_mutes (user_id, kind, target_id, name, created_at) values (?, 'page', '${MUTED}', null, ?), (?, 'agent', 'idn-muted', 'Scout', ?)`,
    )
      .bind(u.userId, T0, u.userId, T0)
      .run();
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:m1", { artifactId: MUTED }), T0);
    await queuePush(
      E,
      [u.userId],
      item("ask:m2", { agentKey: "idn-muted", askerRef: u.userId }),
      T0,
    );
    await queueUpdatePush(E, u.userId, item("u:m3", { artifactId: MUTED }), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);
    await queuePush(E, [u.userId], item("ask:m4"), T0 + BUNDLE_MS);
    await drainPush(E, T0 + BUNDLE_MS);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(await decrypt((sent[0] as Sent).body, b)).href).toContain(
      PUB,
    );
  });

  it("writing an Update item queues its push for a member who turned Updates on", async () => {
    const { E } = await world();
    const { u } = await enroll(E, { updates: { inApp: true, browser: true } });
    await env.DB.prepare(
      "update push_subscriptions set updates = 1 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    const owner = await mk("own-pub");
    const member = await getUser(E, owner.userId);
    const mine = await getUser(E, u.userId);
    const { id } = await publish(
      E,
      member as never,
      { title: "Roadmap", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(id, (mine as { email: string }).email, owner.userId, Date.now())
      .run();
    await recordShareItem(E, {
      artifactId: id,
      title: "Roadmap",
      email: (mine as { email: string }).email,
      sharer: owner.userId,
      sharerName: "Ann",
      createdAt: Date.now(),
    });
    expect(await pendingCount(u.userId)).toBe(1);
  });

  it("a put-off item whose time has come is pushed once; a closed ask, an old return and a returned one are not", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    const later = (id: string, until: number) =>
      env.DB.prepare(
        "insert into inbox_later (user_id, item_id, until, used, created_at) values (?, ?, ?, 1, ?)",
      )
        .bind(u.userId, `ask:${id}`, until, T0 - 3_600_000)
        .run();
    const ask = (id: string, open: number) =>
      env.DB.prepare(
        `insert or replace into artifact_asks (artifact_id, thread_id, comment_id, addressee, open, answered, question, asker, asked_at, confirm)
         values (?, 'thl', ?, ?, ?, 0, 'Still there?', '{"kind":"user","ref":"x","name":"Scout"}', '2026-11-18T10:00:00Z', 0)`,
      )
        .bind(PUB, id, u.userId, open)
        .run();
    await ask("l-ok", 1);
    await ask("l-closed", 0);
    await ask("l-old", 1);
    await ask("l-future", 1);
    await later("l-ok", T0 - 1000);
    await later("l-closed", T0 - 1000);
    await later("l-old", T0 - 7 * 3600_000);
    await later("l-future", T0 + 3_600_000);
    await drainPush(E, T0);
    const mine = () => sent.filter((x) => x.url === b.body.endpoint);
    expect(mine()).toHaveLength(1);
    expect(JSON.parse(await decrypt((mine()[0] as Sent).body, b)).href).toBe(
      `/a/${PUB}?thread=thl`,
    );
    // Once: the next tick does not queue it again.
    await drainPush(E, T0 + 2 * BUNDLE_MS);
    expect(mine()).toHaveLength(1);
    const claimed = await env.DB.prepare(
      "select item_id from inbox_later where user_id = ? and pushed_at is not null",
    )
      .bind(u.userId)
      .all<{ item_id: string }>();
    expect(claimed.results.map((r) => r.item_id).sort()).toEqual([
      "ask:l-closed",
      "ask:l-ok",
    ]);
    // The future one goes when its time comes.
    await drainPush(E, T0 + 3_600_000 + 1000);
    expect(mine()).toHaveLength(2);
  });

  it("Back from later is queued like an ask and kept by the waiting-only filter, which is for asks", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    const lx = item(`later:ask:lx2:${T0}`);
    await seed([u.userId], { ...lx, kind: "later" });
    await queueBackFromLater(E, u.userId, lx, T0);
    await drainPush(E, T0);
    const mine = sent.filter((x) => x.url === b.body.endpoint);
    expect(mine).toHaveLength(1);
    expect(JSON.parse(await decrypt((mine[0] as Sent).body, b)).tag).toBe(
      "needs-you",
    );
  });
});

describe("checked again at send time", () => {
  const detail = { lockScreenDetail: true } as const;
  /** A page only this member can read, shared to them. */
  async function privateShared(E: Env, userId: string) {
    const owner = await mk(`own-${newId().slice(0, 4)}`);
    const om = await getUser(E, owner.userId);
    const me = await getUser(E, userId);
    const { id } = await publish(
      E,
      om as never,
      { title: "Private", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(id, (me as { email: string }).email, owner.userId, Date.now())
      .run();
    return id;
  }
  const mineOf = (sent: Sent[], b: { body: { endpoint: string } }) =>
    sent.filter((x) => x.url === b.body.endpoint);

  it("access revoked while queued: nothing is sent, the words never leave", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, detail);
    const art = await privateShared(E, u.userId);
    const { sent } = fakePush();
    await queuePush(
      E,
      [u.userId],
      item("ask:rv1", { artifactId: art, excerpt: "Secret question" }),
      T0,
    );
    await env.DB.prepare("delete from shares where artifact_id = ?")
      .bind(art)
      .run();
    await drainPush(E, T0);
    expect(mineOf(sent, b)).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("an ask answered while queued is not sent; a still-open one carries its current question", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, detail);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:an1"), T0);
    await env.DB.prepare(
      "update artifact_asks set open = 0, answered = 1 where comment_id = 'an1'",
    ).run();
    await drainPush(E, T0);
    expect(mineOf(sent, b)).toHaveLength(0);
    // Open, but the question was replaced while queued.
    await queuePush(
      E,
      [u.userId],
      item("ask:an2", { excerpt: "Old words" }),
      T0 + BUNDLE_MS * 2,
    );
    await env.DB.prepare(
      "update artifact_asks set question = 'New words' where comment_id = 'an2'",
    ).run();
    await drainPush(E, T0 + BUNDLE_MS * 2);
    const m = mineOf(sent, b);
    expect(m).toHaveLength(1);
    const body = JSON.parse(await decrypt((m[0] as Sent).body, b)).body;
    expect(body).toContain("New words");
    expect(body).not.toContain("Old words");
  });

  it("a comment deleted while queued is not sent; one edited shows the new words, at send time and in the queue", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      ...detail,
      updates: { inApp: true, browser: true },
    });
    await env.DB.prepare(
      "update push_subscriptions set updates = 1 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    const { sent } = fakePush();
    // Deleted.
    await queueUpdatePush(
      E,
      u.userId,
      item("comment:dl1", { excerpt: "Oops" }),
      T0,
    );
    await forgetCommentItems(E, {
      artifactId: PUB,
      threadId: "th1",
      commentId: "dl1",
      root: false,
    });
    expect(await pendingCount(u.userId)).toBe(0);
    // Removed from the inbox but still queued (a race): dropped at send time.
    await queueUpdatePush(
      E,
      u.userId,
      item("comment:dl2", { excerpt: "Gone" }),
      T0,
    );
    await env.DB.prepare(
      "delete from inbox_items where key = 'comment:dl2'",
    ).run();
    await drainPush(E, T0);
    expect(mineOf(sent, b)).toHaveLength(0);
    // Edited while queued.
    await queueUpdatePush(
      E,
      u.userId,
      item("comment:ed1", { excerpt: "Typo" }),
      T0 + BUNDLE_MS * 2,
    );
    await refreshCommentItems(E, {
      artifactId: PUB,
      commentId: "ed1",
      body: "Fixed words",
    });
    const row = await env.DB.prepare(
      "select excerpt from push_pending where key = 'comment:ed1'",
    ).first<{
      excerpt: string;
    }>();
    expect(row?.excerpt).toBe("Fixed words");
    await drainPush(E, T0 + BUNDLE_MS * 2);
    const m = mineOf(sent, b);
    expect(m).toHaveLength(1);
    expect(JSON.parse(await decrypt((m[0] as Sent).body, b)).body).toContain(
      "Fixed words",
    );
    // A deleted thread takes its queued items too.
    await queueUpdatePush(
      E,
      u.userId,
      item("reply:th9", { threadId: "thX" }),
      T0 + BUNDLE_MS * 5,
    );
    await forgetCommentItems(E, {
      artifactId: PUB,
      threadId: "thX",
      commentId: "r",
      root: true,
    });
    expect(await pendingCount(u.userId)).toBe(0);
  });
});

describe("the topic and bad keys", () => {
  it("the topic follows the payload's tag, so Updates can't replace a waiting Needs-you push", async () => {
    const { E } = await world();
    const { u } = await enroll(E, { updates: { inApp: true, browser: true } });
    await env.DB.prepare(
      "update push_subscriptions set updates = 1 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:tp1"), T0);
    await drainPush(E, T0);
    await queueUpdatePush(E, u.userId, item("comment:tp2"), T0 + BUNDLE_MS);
    await drainPush(E, T0 + BUNDLE_MS);
    const mine = sent.filter((x) => x.url.includes("/fcm/send/")).slice(-2);
    expect(mine.map((x) => x.headers.get("topic"))).toEqual([
      "needs-you",
      "updates",
    ]);
  });

  it("subscribing with keys that can't be encrypted to is a 400: off the curve, wrong length, bad auth", async () => {
    const { E } = await world();
    const u = await mk("badkeys");
    const good = await browser();
    const offCurve = new Uint8Array(65);
    offCurve[0] = 4;
    offCurve.fill(7, 1);
    for (const keys of [
      { p256dh: b64u(offCurve), auth: good.body.keys.auth },
      { p256dh: b64u(good.raw.slice(0, 33)), auth: good.body.keys.auth },
      { p256dh: good.body.keys.p256dh, auth: b64u(new Uint8Array(8)) },
      { p256dh: "!!!", auth: good.body.keys.auth },
    ]) {
      const r = await subscribe(E, u.cookie, {
        endpoint: good.body.endpoint,
        keys,
      });
      expect(r.status, JSON.stringify(keys)).toBe(400);
    }
    expect((await subscribe(E, u.cookie, good.body)).status).toBe(201);
  });

  it("a stored subscription that can't be encrypted to is deleted and the member's other browsers still get theirs", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const bad = await browser();
    expect((await subscribe(E, u.cookie, bad.body)).status).toBe(201);
    await env.DB.prepare(
      "update push_subscriptions set p256dh = ? where endpoint = ?",
    )
      .bind(b64u(new Uint8Array(65).fill(7)), bad.body.endpoint)
      .run();
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:bk1"), T0);
    await drainPush(E, T0);
    expect(sent.filter((x) => x.url === b.body.endpoint)).toHaveLength(1);
    expect(sent.filter((x) => x.url === bad.body.endpoint)).toHaveLength(0);
    const left = (await (
      await api(app, R.mePushSubscriptions, u.cookie, {}, E)
    ).json()) as {
      items: unknown[];
    };
    expect(left.items).toHaveLength(1);
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

describe("a person's @-mention of the member (#2781)", () => {
  /** The Needs-you item #2770 writes for a mentioned person, through the real writer. */
  const mention = (
    E: Env,
    userId: string,
    id: string,
    over: { artifactId?: string; excerpt?: string; name?: string } = {},
  ) =>
    writeInboxItems(E, [
      {
        userId,
        kind: "mention",
        level: "needs_you",
        key: `person:${id}`,
        artifactId: over.artifactId ?? PUB,
        threadId: "th-m",
        commentId: id,
        actor: { kind: "user", ref: "someone-else", name: over.name ?? "Ann" },
        excerpt: over.excerpt ?? "Can you check the yearly numbers?",
        at: T0,
      },
    ]);
  /** This browser's own notifications: the queue is shared, so other members' pushes may be due too. */
  const mineOf = (sent: Sent[], b: { body: { endpoint: string } }) =>
    sent.filter((x) => x.url === b.body.endpoint);
  const bodyOf = async (
    sent: Sent[],
    b: Awaited<ReturnType<typeof browser>>,
    n = 0,
  ) => JSON.parse(await decrypt((mineOf(sent, b)[n] as Sent).body, b));

  it("writing the item queues a Needs-you push; the lock screen says only that someone mentioned you", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await mention(E, u.userId, "pm1");
    expect(await pendingCount(u.userId)).toBe(1);
    const row = await env.DB.prepare(
      "select kind, key from push_pending where user_id = ?",
    )
      .bind(u.userId)
      .first<{ kind: string; key: string }>();
    expect(row).toEqual({ kind: "ask", key: "person:pm1" });
    await drainPush(E, Date.now());
    expect(mineOf(sent, b)).toHaveLength(1);
    const p = await bodyOf(sent, b);
    expect(p.body).toBe(DEFAULT_MENTION_BODY);
    expect(p.tag).toBe("needs-you");
    expect(p.href).toBe(`/a/${PUB}?thread=th-m`);
    expect(JSON.stringify(p)).not.toContain("Ann");
    expect(JSON.stringify(p)).not.toContain("yearly");
    // Not also queued as an Update.
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("with lock-screen detail: who and the words, written by the server", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { lockScreenDetail: true });
    const { sent } = fakePush();
    await mention(E, u.userId, "pm2", {
      name: "Ann‮\u0000",
      excerpt: "Can you check the yearly numbers?",
    });
    await drainPush(E, Date.now());
    const p = await bodyOf(sent, b);
    expect(p.body).toBe("Ann mentioned you: Can you check the yearly numbers?");
  });

  it("not queued with the Needs-you switch off or no browser", async () => {
    const { E } = await world();
    const off = await enroll(E, { needsYou: { inApp: true, browser: false } });
    await mention(E, off.u.userId, "pm3");
    expect(await pendingCount(off.u.userId)).toBe(0);
    const none = await mk(`nb-${newId().slice(0, 5)}`);
    await putPrefs(E, none.userId, prefs());
    await mention(E, none.userId, "pm3b");
    expect(await pendingCount(none.userId)).toBe(0);
  });

  it("quiet hours hold it; the waiting-asks-only filter is for asks and never drops it", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      browserAllAsks: false,
      quietHours: { start: "22:00", end: "07:00" },
    });
    const { sent } = fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    await mention(E, u.userId, "pm4");
    await env.DB.prepare(
      "update push_pending set send_after = ? where user_id = ?",
    )
      .bind(night, u.userId)
      .run();
    // Quiet: held to when quiet hours end.
    await drainPush(E, night);
    expect(mineOf(sent, b)).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(1);
    const morning = Date.UTC(2026, 10, 19, 7, 0, 5);
    await drainPush(E, morning);
    expect(mineOf(sent, b)).toHaveLength(1);
    expect((await bodyOf(sent, b)).body).toBe(DEFAULT_MENTION_BODY);
  });

  it("mutes: the page only. A muted page is not pushed; a person has no agent to mute", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    await env.DB.prepare(
      `insert into inbox_mutes (user_id, kind, target_id, name, created_at) values (?, 'page', '${MUTED}', null, ?), (?, 'agent', 'idn-ann', 'Ann', ?)`,
    )
      .bind(u.userId, T0, u.userId, T0)
      .run();
    const { sent } = fakePush();
    await mention(E, u.userId, "pm5", { artifactId: MUTED });
    await drainPush(E, Date.now());
    expect(mineOf(sent, b)).toHaveLength(0);
    // The agent mute is not for people: a mention on another page still goes.
    await mention(E, u.userId, "pm5b");
    await env.DB.prepare(
      "update push_pending set send_after = 0 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    await drainPush(E, Date.now() + BUNDLE_MS);
    expect(mineOf(sent, b)).toHaveLength(1);
  });

  it("checked at send time: the item deleted, or the page no longer readable, sends nothing; an edited mention shows the new words", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { lockScreenDetail: true });
    const art = await (async () => {
      const owner = await mk(`own-${newId().slice(0, 4)}`);
      const om = await getUser(E, owner.userId);
      const me = await getUser(E, u.userId);
      const { id } = await publish(
        E,
        om as never,
        { title: "Private", format: "markdown", content: "x" } as never,
        null,
        undefined,
        "create",
      );
      await env.DB.prepare(
        "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
      )
        .bind(id, (me as { email: string }).email, owner.userId, Date.now())
        .run();
      return id;
    })();
    const { sent } = fakePush();
    // The item is gone (its comment was deleted): nothing is sent.
    await mention(E, u.userId, "pm6", { artifactId: art });
    await forgetCommentItems(E, {
      artifactId: art,
      threadId: "th-m",
      commentId: "pm6",
      root: false,
    });
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, Date.now());
    expect(mineOf(sent, b)).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);
    // Access revoked while queued: nothing is sent.
    await mention(E, u.userId, "pm7", { artifactId: art });
    await env.DB.prepare("delete from shares where artifact_id = ?")
      .bind(art)
      .run();
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, Date.now());
    expect(mineOf(sent, b)).toHaveLength(0);
    // Edited while queued: the current words.
    await mention(E, u.userId, "pm8", { excerpt: "first words" });
    await refreshCommentItems(E, {
      artifactId: PUB,
      commentId: "pm8",
      body: "edited words",
    });
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, Date.now());
    expect((await bodyOf(sent, b)).body).toBe(
      "Ann mentioned you: edited words",
    );
  });

  it("a mention and an ask due together go as one notification, counted, with no detail", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:pm9a"), T0);
    await mention(E, u.userId, "pm9");
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, Date.now());
    expect(mineOf(sent, b)).toHaveLength(1);
    const p = await bodyOf(sent, b);
    expect(p.body).toBe("2 things are waiting for your answer");
  });
});

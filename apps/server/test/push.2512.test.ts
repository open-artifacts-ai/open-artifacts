// #2512 S5, #3024: browser push. Keys are generated here, per run; none is committed.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
  DEFAULT_HELD_BODY,
  DEFAULT_MENTION_BODY,
  deliverMemberPush,
  HELD_PUSH_PREFIX,
  MAX_SUBSCRIPTIONS,
  queueAskPush,
  queueLaterReturns,
  queuePush as rawQueuePush,
} from "../src/services/push.js";
import { getUser } from "../src/services/users.js";
import {
  b64u,
  encryptPayload,
  pushEndpointOk,
  pushOn,
  unb64u,
  vapidHeader,
  vapidKeys,
} from "../src/services/web-push.js";
import { hubOf } from "./bus/helpers.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const enc = new TextEncoder();
const dec = new TextDecoder();

// ------------------------------------------------------------------ keys

// The instance's VAPID pair derives from SESSION_SECRET (#3024); the test only
// reads the public half, as a verify key.
async function verifyKeys(e: Env) {
  const { publicKey: VAPID_PUBLIC_KEY } = await vapidKeys(e);
  return {
    VAPID_PUBLIC_KEY,
    publicKey: await crypto.subtle.importKey(
      "raw",
      unb64u(VAPID_PUBLIC_KEY),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    ),
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
  const E = { ...(env as Env), APP_HOST: "app.localhost" } as Env;
  return { E, keys: await verifyKeys(E) };
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
  }
}
/** Drive the queued fixture members at the test clock's exact deadline. */
async function drainPush(e: Env, now: number) {
  if (!pushOn(e)) return 0;
  const { results } =
    await e.DB.prepare(`select user_id from push_pending where send_after <= ?1
    union select user_id from inbox_later where pushed_at is null and until <= ?1`)
      .bind(now)
      .all<{ user_id: string }>();
  let sent = 0;
  for (const { user_id } of results)
    sent += (await deliverMemberPush(e, user_id, now)).sent;
  return sent;
}

async function lastSent(userId: string, at: number | null = Date.now()) {
  await env.DB.prepare(
    "update push_subscriptions set last_sent_at = ? where user_id = ?",
  )
    .bind(at, userId)
    .run();
}

const queuePush = async (e: Env, users: string[], it: QItem, now?: number) => {
  await seed(users, it);
  return rawQueuePush(e, users, it, now);
};
/** A row queued before Updates stopped pushing (what the 0053 migration also deletes). */
const legacyUpdateRow = (userId: string, key: string, sendAfter: number) =>
  env.DB.prepare(
    `insert into push_pending (id, user_id, key, kind, artifact_id, thread_id, asker_name, excerpt, send_after, created_at)
     values (?, ?, ?, 'update', ?, 'th1', 'Scout', 'Ship the draft?', ?, ?)`,
  )
    .bind(newId(), userId, key, PUB, sendAfter, sendAfter)
    .run();
/** `userId`'s hub holds a live agent of theirs with this identity that says it waits on them. */
async function waitingAgent(userId: string, identityId: string) {
  await env.DB.prepare(
    "insert or ignore into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, 0, 1)",
  )
    .bind(`m-${userId}`, userId, `h-${userId}`)
    .run();
  await runInDurableObject(await hubOf(userId), (_i, st) => {
    st.storage.sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at, status, status_at, identity_id)
       values (?, 'owner', 'ns', 'Scout', 'claude-code', ?, ?, 1, ?, 'waiting_on_owner', ?, ?)`,
      `ag-${identityId}`,
      `m-${userId}`,
      `ref-${identityId}`,
      T0,
      T0,
      identityId,
    );
  });
}
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

  it("reuses a VAPID JWT for one hour across devices of one audience", async () => {
    const { E } = await world();
    const url = "https://web.push.apple.com/device";
    const header = (e: Env, endpoint: string, at: number) =>
      vapidHeader(e, endpoint, at);
    const [first, concurrent] = await Promise.all([
      header(E, url, T0),
      header(E, `${url}-other`, T0),
    ]);
    expect(concurrent).toBe(first);
    expect(await header(E, "https://fcm.googleapis.com/x", T0)).not.toBe(first);
    expect(await header(E, url, T0 + 3_599_999)).toBe(first);
    expect(await header(E, url, T0 + 3_600_000)).not.toBe(first);
    expect(
      await header({ ...E, APP_HOST: "other.example" }, url, T0 + 3_600_000),
    ).not.toBe(await header(E, url, T0 + 3_600_000));
    expect(
      await header(
        { ...E, SESSION_SECRET: "different-rotation-secret" },
        url,
        T0,
      ),
    ).not.toBe(first);
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

describe("the derived VAPID key (#3024)", () => {
  const S1 = { SESSION_SECRET: "synthetic-secret-one-0123456789abcdef" } as Env;
  const S2 = { SESSION_SECRET: "synthetic-secret-two-0123456789abcdef" } as Env;

  it("is stable for one secret and differs for another", async () => {
    const a = (await vapidKeys(S1)).publicKey;
    expect((await vapidKeys({ ...S1 } as Env)).publicKey).toBe(a);
    expect((await vapidKeys(S2)).publicKey).not.toBe(a);
    // Rotation takes effect in a warm worker: back to S1 is the same key again.
    expect((await vapidKeys(S1)).publicKey).toBe(a);
  });

  it("the public key is a 65-byte uncompressed point, and the general key API refuses its label", async () => {
    const { deriveKey } = await import("../src/auth/keys.js");
    const pub = (await vapidKeys(S1)).publicKey;
    expect(unb64u(pub)).toHaveLength(65);
    expect(unb64u(pub)[0]).toBe(4);
    await expect(deriveKey(S1, "oa:push-vapid" as never)).rejects.toThrow(
      "is not a SESSION_SECRET label",
    );
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
  it("with no SESSION_SECRET push is off and no key derives", async () => {
    for (const s of [undefined, ""]) {
      const off = { ...(env as Env), SESSION_SECRET: s } as unknown as Env;
      expect(pushOn(off)).toBe(false);
      await expect(vapidKeys(off)).rejects.toThrow("SESSION_SECRET is not set");
    }
    expect(pushOn(env as Env)).toBe(true);
  });

  it("the key route answers 200 with the derived key and no legacy VAPID env at all (#3024)", async () => {
    const E = { ...(env as Env) } as Env;
    expect(E.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(E.VAPID_PRIVATE_KEY).toBeUndefined();
    const u = await mk("derived");
    const r = await api(app, R.mePushKey, u.cookie, {}, E);
    expect(r.status).toBe(200);
    const { publicKey } = (await r.json()) as { publicKey: string };
    expect(publicKey).toBe((await vapidKeys(E)).publicKey);
    expect(unb64u(publicKey)).toHaveLength(65);
    // Legacy values are ignored, not echoed.
    const legacy = {
      ...E,
      VAPID_PUBLIC_KEY: "legacy-pub",
      VAPID_PRIVATE_KEY: "legacy-priv",
    } as Env;
    const r2 = await api(app, R.mePushKey, u.cookie, {}, legacy);
    expect(await r2.json()).toEqual({ publicKey });
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
  it("delivers a new ask on creation and arms one alarm for the next ask", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    const asker = JSON.stringify({
      kind: "user",
      ref: u.userId,
      agent: { name: "Scout" },
    });
    const create = async (id: string) => {
      await seed([u.userId], item(`ask:${id}`));
      await queueAskPush(E, [u.userId], new Set(), PUB, "th1", id, {
        question: "Ship?",
        asker,
      });
    };
    await create("event-first");
    expect(sentTo(sent, b)).toHaveLength(1);
    await create("event-second");
    expect(sentTo(sent, b)).toHaveLength(1);
    const device = await E.DB.prepare(
      "select last_sent_at from push_subscriptions where user_id = ?",
    )
      .bind(u.userId)
      .first<number>("last_sent_at");
    const stub = E.ARTIFACT_RUNTIME.getByName(`push:${u.userId}`);
    expect(
      await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm()),
    ).toBe(Number(device) + BUNDLE_MS);
    vi.spyOn(Date, "now").mockReturnValue(Number(device) + BUNDLE_MS);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sentTo(sent, b)).toHaveLength(2);
    expect(
      await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm()),
    ).toBeNull();
  });

  it("quiet hours arm one alarm for the exact local end and deliver the bundle once", async () => {
    const night = Date.UTC(2099, 0, 1, 23);
    const morning = Date.UTC(2099, 0, 2, 6, 30);
    const clock = vi.spyOn(Date, "now").mockReturnValue(night);
    const { E } = await world();
    const { u, b } = await enroll(E, {
      quietHours: { start: "22:00", end: "07:30" },
      timeZone: "Europe/Paris",
    });
    const { sent } = fakePush();
    for (const id of ["quiet-a", "quiet-b"]) {
      await seed([u.userId], item(`ask:${id}`));
      await queueAskPush(E, [u.userId], new Set(), PUB, "th1", id, {
        question: "Ship?",
        asker: JSON.stringify({ ref: u.userId, agent: { name: "Scout" } }),
      });
    }
    const stub = E.ARTIFACT_RUNTIME.getByName(`push:${u.userId}`);
    expect(sentTo(sent, b)).toHaveLength(0);
    expect(
      await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm()),
    ).toBe(morning);
    clock.mockReturnValue(morning);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sentTo(sent, b)).toHaveLength(1);
    expect(
      JSON.parse(await decrypt((sentTo(sent, b)[0] as Sent).body, b)).count,
    ).toBe(2);
    expect(
      await runInDurableObject(stub, (_obj, state) => state.storage.getAlarm()),
    ).toBeNull();
  });

  it.each([403, 410])(
    "logs the provider's HTTP %i and a bounded, redacted error preview",
    async (status) => {
      const { E } = await world();
      const { u } = await enroll(E);
      const body =
        '{"reason":"BadJwtToken","token":"short-secret","url":"https://example.com/private","detail":"' +
        "BadJwtToken ".repeat(30) +
        '"}';
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response(body, { status }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await queuePush(E, [u.userId], item("ask:provider-log"), T0);
      await drainPush(E, T0);
      const record = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .find((line) => line.evt === "push_send_failed");
      expect(record).toMatchObject({
        status,
        providerBody: expect.stringContaining("BadJwtToken"),
      });
      expect(record.providerBody.length).toBeLessThanOrEqual(200);
      expect(JSON.stringify(record)).not.toMatch(
        /short-secret|example\.com|private/,
      );
    },
  );

  it("the default text hides the question: one fixed line, a link to the ask, no actions", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:c1"), T0);
    expect(await drainPush(E, T0)).toBe(1);
    expect(sent).toHaveLength(1);
    const s = sent[0] as Sent;
    expect(s.url).toBe(b.body.endpoint);
    expect(s.headers.get("urgency")).toBe("high");
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
    expect(p.title).toBe("2 things need you");
    expect(p.body).toBe("2 asks");
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

  it("in quiet hours a legacy Update is dropped with one push_dropped line and the live ask is held, not dropped", async () => {
    const { E } = await world();
    const { u } = await enroll(E);
    fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    await queuePush(E, [u.userId], item("ask:q1"), night);
    await legacyUpdateRow(u.userId, "update:q", night);
    // Quiet hours begin after both were queued, so both are due at drain time.
    await putPrefs(
      E,
      u.userId,
      prefs({ quietHours: { start: "22:00", end: "07:30" } }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainPush(E, night);
    const lines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("push_dropped") && l.includes(u.userId))
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([expect.objectContaining({ update: 1 })]);
    expect(lines[0]).not.toHaveProperty("needs_you_off");
    expect(await pendingCount(u.userId)).toBe(1);
    // Held rows would otherwise send in a later test's drain.
    await env.DB.prepare("delete from push_pending where user_id = ?")
      .bind(u.userId)
      .run();
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

  it("with browserAllAsks false, a plain ask (nobody waiting) is still sent: Needs you interrupts for every ask (#3024)", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:other"), T0);
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(1);
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("a member with a device and no prefs row gets a plain ask from another member's agent", async () => {
    const { E } = await world();
    const u = await mk(`norow-${newId().slice(0, 5)}`);
    const b = await browser();
    expect((await subscribe(E, u.cookie, b.body)).status).toBe(201);
    const { sent } = fakePush();
    await queuePush(
      E,
      [u.userId],
      item("ask:norow", { askerRef: "someone-else", agentKey: "idn-theirs" }),
      T0,
    );
    expect(await pendingCount(u.userId)).toBe(1);
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(1);
  });

  it("Needs you explicitly off sends nothing and one push_dropped line counts the drop; no line when nothing drops", async () => {
    const { E } = await world();
    const off = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [off.u.userId], item("ask:off1"), T0);
    await queuePush(E, [off.u.userId], item("ask:off2"), T0);
    await putPrefs(
      E,
      off.u.userId,
      prefs({ needsYou: { inApp: true, browser: false } }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainPush(E, T0);
    expect(sent).toHaveLength(0);
    const drops = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("push_dropped") && l.includes(off.u.userId));
    expect(drops).toHaveLength(1);
    expect(JSON.parse(drops[0] as string)).toMatchObject({
      evt: "push_dropped",
      userId: off.u.userId,
      needs_you_off: 2,
    });
    // A member whose rows all send logs nothing.
    const on = await enroll(E);
    await queuePush(E, [on.u.userId], item("ask:on1"), T0);
    log.mockClear();
    await drainPush(E, T0);
    expect(
      log.mock.calls.filter((c) => String(c[0]).includes("push_dropped")),
    ).toHaveLength(0);
  });

  it("when no device takes the send, one push_dropped line counts send_failed and the devices removed", async () => {
    const { E } = await world();
    const gone = await enroll(E);
    const flaky = await enroll(E);
    fakePush((url) => (url === gone.b.body.endpoint ? 410 : 500));
    await queuePush(E, [gone.u.userId, flaky.u.userId], item("ask:sf"), T0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await drainPush(E, T0);
    const lineOf = (id: string) =>
      log.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("push_dropped") && l.includes(id))
        .map((l) => JSON.parse(l));
    expect(lineOf(gone.u.userId)).toEqual([
      expect.objectContaining({ send_failed: 1, devices_removed: 1 }),
    ]);
    expect(lineOf(flaky.u.userId)).toEqual([
      expect.objectContaining({ send_failed: 1 }),
    ]);
  });

  it("a recipient event discards and logs even a stale row with a future deadline", async () => {
    const { E } = await world();
    const stale = await enroll(E);
    fakePush();
    await env.DB.prepare(
      `insert into push_pending (id, user_id, key, kind, artifact_id, thread_id, asker_name, excerpt, send_after, created_at)
       values (?, ?, 'ask:old', 'ask', ?, 'th1', 'Scout', 'x', ?, ?)`,
    )
      .bind(newId(), stale.u.userId, PUB, T0 + 10 ** 9, T0 - 25 * 3600_000)
      .run();
    await queuePush(E, [stale.u.userId], item("ask:fresh"), T0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await deliverMemberPush(E, stale.u.userId, T0);
    expect(await pendingCount(stale.u.userId)).toBe(1); // the fresh ask shares the pre-existing future deadline
    const lines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("push_dropped") && l.includes(stale.u.userId));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ stale: 1 }),
    ]);
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
    const bare = { ...E, SESSION_SECRET: undefined } as unknown as Env;
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
    await lastSent(waiter.u.userId);
    await lastSent(typer.u.userId);
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

describe("devices, one set of account choices, Updates, mutes and Back from later (#3024)", () => {
  const patch = (E: Env, cookie: string, id: string, body: unknown) =>
    api(app, R.mePushSubscription(id), cookie, { method: "PATCH", body }, E);
  type SubItem = { id: string; needsYou: boolean; updates: boolean };
  const subsOf = async (E: Env, cookie: string) =>
    (
      (await (await api(app, R.mePushSubscriptions, cookie, {}, E)).json()) as {
        items: SubItem[];
      }
    ).items;
  const prefsOf = async (cookie: string) =>
    (await (
      await api(app, R.meNotificationPrefs, cookie)
    ).json()) as NotificationPrefs;

  it("enrolling a device never changes the account choices; the list projects Needs you on and Updates off", async () => {
    const { E } = await world();
    const u = await mk("sw");
    const before = await prefsOf(u.cookie);
    expect(before).toEqual(DEFAULT_PREFS);
    await subscribe(E, u.cookie, (await browser()).body);
    await subscribe(E, u.cookie, (await browser()).body);
    expect(await prefsOf(u.cookie)).toEqual(before);
    expect(
      (await subsOf(E, u.cookie)).map((i) => [i.needsYou, i.updates]),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
    // Even a member who has Updates saved on (an old row) sees it off, and a new device is not on for it.
    await env.DB.prepare(
      "update notification_prefs set updates_browser = 1 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    await subscribe(E, u.cookie, (await browser()).body);
    expect((await prefsOf(u.cookie)).updates.browser).toBe(false);
    expect((await subsOf(E, u.cookie)).every((i) => !i.updates)).toBe(true);
  });

  it("PATCH needsYou: false removes only this caller's device; true and updates change nothing", async () => {
    const { E } = await world();
    const u = await mk("pt");
    const other = await mk("pt-other");
    await subscribe(E, u.cookie, (await browser()).body);
    await subscribe(E, u.cookie, (await browser()).body);
    await subscribe(E, other.cookie, (await browser()).body);
    const [a, b] = await subsOf(E, u.cookie);
    const accountBefore = await prefsOf(u.cookie);
    // Nothing to switch on a device: Needs you stays on, Updates stay off.
    for (const body of [
      { needsYou: true },
      { updates: true },
      { updates: false },
      { needsYou: true, updates: true },
    ]) {
      const r = await patch(E, u.cookie, (a as SubItem).id, body);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ needsYou: true, updates: false });
    }
    expect(await subsOf(E, u.cookie)).toHaveLength(2);
    // Off removes that device alone.
    const off = await patch(E, u.cookie, (a as SubItem).id, {
      needsYou: false,
    });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ needsYou: false, updates: false });
    expect((await subsOf(E, u.cookie)).map((i) => i.id)).toEqual([
      (b as SubItem).id,
    ]);
    expect(await subsOf(E, other.cookie)).toHaveLength(1);
    expect(await prefsOf(u.cookie)).toEqual(accountBefore);
    // Gone: a second off is 404, and nobody else's device can be removed.
    expect(
      (await patch(E, u.cookie, (a as SubItem).id, { needsYou: false })).status,
    ).toBe(404);
    const theirs = (await subsOf(E, other.cookie))[0] as SubItem;
    expect(
      (await patch(E, u.cookie, theirs.id, { needsYou: false })).status,
    ).toBe(404);
    expect(await subsOf(E, other.cookie)).toHaveLength(1);
  });

  it("PATCH is the owner's, in a browser: another person or a token gets 404; an empty body is 400", async () => {
    const { E } = await world();
    const a = await mk("pa");
    const b2 = await mk("pb");
    await subscribe(E, a.cookie, (await browser()).body);
    const id = ((await subsOf(E, a.cookie))[0] as SubItem).id;
    expect((await patch(E, b2.cookie, id, { updates: true })).status).toBe(404);
    const pat = (await createPat(E, a.userId, "p")).token;
    expect((await patch(E, pat, id, { needsYou: false })).status).toBe(404);
    expect((await patch(E, a.cookie, id, {})).status).toBe(400);
    expect((await patch(E, a.cookie, "nope", { updates: true })).status).toBe(
      404,
    );
    expect(await subsOf(E, a.cookie)).toHaveLength(1);
  });

  it("an Update is never queued or sent, whatever was saved; a row queued before the upgrade is dropped unsent", async () => {
    const { E } = await world();
    // Updates browser sent as on is not saved; the member has Needs you on.
    const { u, b } = await enroll(E, {
      updates: { inApp: true, browser: true },
    });
    expect((await prefsOf(u.cookie)).updates.browser).toBe(false);
    // An old stored value is no switch either.
    await env.DB.prepare(
      "update notification_prefs set updates_browser = 1 where user_id = ?",
    )
      .bind(u.userId)
      .run();
    const { sent } = fakePush();
    // Writing an Update item for them: written and visible, nothing queued.
    const owner = await mk("upd-owner");
    const om = await getUser(E, owner.userId);
    const { id: art } = await publish(
      E,
      om as never,
      { title: "Roadmap", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    const email = ((await getUser(E, u.userId)) as { email: string }).email;
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(art, email, owner.userId, Date.now())
      .run();
    await recordShareItem(E, {
      artifactId: art,
      title: "Roadmap",
      email,
      sharer: owner.userId,
      sharerName: "Ann",
      createdAt: Date.now(),
    });
    const written = await env.DB.prepare(
      "select level from inbox_items where user_id = ? and artifact_id = ?",
    )
      .bind(u.userId, art)
      .all<{ level: string }>();
    expect(written.results.map((r) => r.level)).toEqual(["update"]);
    expect(await pendingCount(u.userId)).toBe(0);
    // A row created before the upgrade, already due: never sent, and gone.
    await legacyUpdateRow(u.userId, "reply:old", T0);
    expect(await pendingCount(u.userId)).toBe(1);
    await drainPush(E, T0);
    expect(sent.filter((x) => x.url === b.body.endpoint)).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("a legacy Update row due with a Needs-you item goes out as the Needs-you item alone", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      quietHours: { start: "22:00", end: "07:30" },
    });
    const { sent } = fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    await legacyUpdateRow(u.userId, "comment:c1", night);
    await queuePush(E, [u.userId], item("ask:q"), night + 1000);
    await drainPush(E, night + 3_600_000);
    expect(sent).toHaveLength(0);
    await drainPush(E, Date.UTC(2026, 10, 19, 7, 30));
    expect(sent).toHaveLength(1);
    const p = JSON.parse(await decrypt((sent[0] as Sent).body, b));
    expect(p.count).toBeUndefined();
    expect(p.tag).toBe("needs-you");
    expect(p.body).toBe(DEFAULT_BODY);
    expect(await pendingCount(u.userId)).toBe(0);
  });

  it("every device of a member gets the notification; each stays enrolled", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const second = await browser();
    await subscribe(E, u.cookie, second.body);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:s"), T0);
    await drainPush(E, T0);
    expect(sent).toHaveLength(2);
    for (const x of [b, second]) {
      const s = sent.find((y) => y.url === x.body.endpoint) as Sent;
      expect(JSON.parse(await decrypt(s.body, x)).body).toBe(DEFAULT_BODY);
    }
    expect(await subsOf(E, u.cookie)).toHaveLength(2);
  });

  it("a muted page and a muted agent are not pushed, the rest still are", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
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
});

/** The Needs-you item #2770 writes for a mentioned person, through the real writer. */
const writePersonMention = (
  E: Env,
  userId: string,
  id: string,
  over: { artifactId?: string; excerpt?: string; name?: string } = {},
) =>
  writeInboxItems(E, [
    {
      userId,
      kind: "mention",
      key: `person:${id}`,
      artifactId: over.artifactId ?? PUB,
      threadId: "th-m",
      commentId: id,
      actor: { kind: "user", ref: "someone-else", name: over.name ?? "Ann" },
      excerpt: over.excerpt ?? "Can you check the yearly numbers?",
      at: T0,
    },
  ]);
const inboxIdOf = async (userId: string, commentId: string) =>
  (
    await env.DB.prepare(
      "select id from inbox_items where user_id = ? and key = ?",
    )
      .bind(userId, `person:${commentId}`)
      .first<{ id: string }>()
  )?.id as string;
const sentTo = (sent: Sent[], b: { body: { endpoint: string } }) =>
  sent.filter((x) => x.url === b.body.endpoint);

describe("what interrupts under Needs you (#3024)", () => {
  /** Enrolls a member, lets `setup` queue something (resolving to the time to drain), and says how many notifications went to their device. */
  async function sends(
    over: Partial<NotificationPrefs>,
    setup: (E: Env, userId: string) => Promise<number>,
  ) {
    const { E } = await world();
    const { u, b } = await enroll(E, over);
    const { sent } = fakePush();
    const at = await setup(E, u.userId);
    await drainPush(E, at);
    return sentTo(sent, b).length;
  }
  const waitingOnly = { browserAllAsks: false } as const;

  it("a plain ask goes whether browserAllAsks is off or on", async () => {
    const plain = async (E: Env, userId: string) => {
      await queuePush(E, [userId], item(`ask:${newId()}`), T0);
      return T0;
    };
    expect(await sends(waitingOnly, plain)).toBe(1);
    expect(await sends({ browserAllAsks: true }, plain)).toBe(1);
  });

  it("an ask from the person's own agent goes whether or not the agent is waiting", async () => {
    expect(
      await sends(waitingOnly, async (E, userId) => {
        await waitingAgent(userId, `idn-w-${userId}`);
        await queuePush(
          E,
          [userId],
          item(`ask:${newId()}`, {
            askerRef: userId,
            agentKey: `idn-w-${userId}`,
          }),
          T0,
        );
        return T0;
      }),
    ).toBe(1);
    expect(
      await sends(waitingOnly, async (E, userId) => {
        await queuePush(
          E,
          [userId],
          item(`ask:${newId()}`, { askerRef: userId, agentKey: "idn-idle" }),
          T0,
        );
        return T0;
      }),
    ).toBe(1);
  });

  it("an open approval (artifact_asks.confirm) goes without 'every ask'; once answered, it does not", async () => {
    const approval = (answer: boolean) => async (E: Env, userId: string) => {
      const cid = newId();
      await queuePush(E, [userId], item(`ask:${cid}`), T0);
      await env.DB.prepare(
        "update artifact_asks set confirm = 1 where comment_id = ?",
      )
        .bind(cid)
        .run();
      if (answer)
        await env.DB.prepare(
          "update artifact_asks set open = 0, answered = 1 where comment_id = ?",
        )
          .bind(cid)
          .run();
      return T0;
    };
    expect(await sends(waitingOnly, approval(false))).toBe(1);
    expect(await sends(waitingOnly, approval(true))).toBe(0);
  });

  it("a held request goes to every device without 'every ask', with the fixed text; once nothing is held, it does not", async () => {
    const held = (stillHeld: boolean) => async (E: Env, userId: string) => {
      const sender = await mk(`hs-${newId().slice(0, 5)}`);
      const rid = newId();
      await env.DB.prepare(
        "insert into held_requests (id, receiver_id, sender_id, artifact_id, created_at, last_at) values (?, ?, ?, ?, ?, ?)",
      )
        .bind(rid, userId, sender.userId, PUB, T0, T0)
        .run();
      await env.DB.prepare(
        `insert into held_request_items (id, request_id, thread_id, comment_id, agent_key, way, state, created_at, expires_at)
         values (?, ?, 'th1', ?, 'k1', 'mention', ?, ?, ?)`,
      )
        .bind(
          newId(),
          rid,
          newId(),
          stillHeld ? "held" : "allowed",
          T0,
          Date.now() + 86_400_000,
        )
        .run();
      await rawQueuePush(
        E,
        [userId],
        {
          key: `${HELD_PUSH_PREFIX}${rid}`,
          kind: "ask",
          artifactId: PUB,
          threadId: "",
          askerName: "Someone",
          excerpt: "A request is waiting for you to allow it",
        },
        T0,
      );
      return T0;
    };
    expect(await sends(waitingOnly, held(true))).toBe(1);
    expect(await sends(waitingOnly, held(false))).toBe(0);
    // Two devices, both told, never the words.
    const { E } = await world();
    const { u, b } = await enroll(E, {
      ...waitingOnly,
      lockScreenDetail: true,
    });
    const second = await browser();
    await subscribe(E, u.cookie, second.body);
    const { sent } = fakePush();
    const at = await held(true)(E, u.userId);
    await drainPush(E, at);
    for (const x of [b, second]) {
      const s = sentTo(sent, x)[0] as Sent;
      expect(JSON.parse(await decrypt(s.body, x)).body).toBe(DEFAULT_HELD_BODY);
    }
  });

  it("a person's @mention goes without 'every ask', to every device", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, waitingOnly);
    const second = await browser();
    await subscribe(E, u.cookie, second.body);
    const { sent } = fakePush();
    await writePersonMention(E, u.userId, "cat-m1");
    await drainPush(E, Date.now() + 1000);
    for (const x of [b, second]) {
      expect(sentTo(sent, x)).toHaveLength(1);
      expect(
        JSON.parse(await decrypt((sentTo(sent, x)[0] as Sent).body, x)).body,
      ).toBe(DEFAULT_MENTION_BODY);
    }
  });

  it("with the account's Needs you off nothing goes, for any category", async () => {
    expect(
      await sends(
        { needsYou: { inApp: true, browser: false } },
        async (E, userId) => {
          await writePersonMention(E, userId, "cat-off");
          await queuePush(E, [userId], item(`ask:${newId()}`), T0);
          return Date.now() + 1000;
        },
      ),
    ).toBe(0);
  });
});

describe("a person's @mention back from Later (#3024)", () => {
  const putOff = (userId: string, itemId: string, until: number) =>
    env.DB.prepare(
      "insert into inbox_later (user_id, item_id, until, used, created_at) values (?, ?, ?, 1, ?)",
    )
      .bind(userId, `mention:${itemId}`, until, until - 3_600_000)
      .run();
  const pendingKeys = async (userId: string) =>
    (
      await env.DB.prepare(
        "select key, kind, artifact_id, thread_id, send_after from push_pending where user_id = ?",
      )
        .bind(userId)
        .all<{
          key: string;
          kind: string;
          artifact_id: string;
          thread_id: string;
          send_after: number;
        }>()
    ).results;
  /** A member with a mention written, its original push row cleared (the member had put it off). */
  async function putOffMention(over: Partial<NotificationPrefs> = {}) {
    const { E } = await world();
    const e = await enroll(E, { browserAllAsks: false, ...over });
    const cid = `lm-${newId().slice(0, 6)}`;
    await lastSent(e.u.userId);
    await writePersonMention(E, e.u.userId, cid);
    await lastSent(e.u.userId, null);
    await env.DB.prepare("delete from push_pending where user_id = ?")
      .bind(e.u.userId)
      .run();
    return { E, ...e, cid, id: await inboxIdOf(e.u.userId, cid) };
  }

  it("is queued once under the original item id and its page and thread, and sent without 'every ask'", async () => {
    const { E, u, b, id } = await putOffMention();
    const { sent } = fakePush();
    await putOff(u.userId, id, T0 - 1000);
    await queueLaterReturns(E, T0);
    expect(await pendingKeys(u.userId)).toEqual([
      expect.objectContaining({
        key: `later:mention:${id}:${T0 - 1000}`,
        kind: "later",
        artifact_id: PUB,
        thread_id: "th-m",
      }),
    ]);
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(1);
    const p = JSON.parse(await decrypt((sentTo(sent, b)[0] as Sent).body, b));
    expect(p.body).toBe(DEFAULT_MENTION_BODY);
    expect(p.href).toBe(`/a/${PUB}?thread=th-m`);
    // One claim: the next ticks queue and send nothing more.
    await drainPush(E, T0 + 2 * BUNDLE_MS);
    await queueLaterReturns(E, T0 + 3 * BUNDLE_MS);
    expect(sentTo(sent, b)).toHaveLength(1);
    expect(await pendingKeys(u.userId)).toEqual([]);
    expect(
      (
        await env.DB.prepare(
          "select pushed_at from inbox_later where user_id = ? and item_id = ?",
        )
          .bind(u.userId, `mention:${id}`)
          .first<{ pushed_at: number }>()
      )?.pushed_at,
    ).toBe(T0);
  });

  it("is claimed once even with two ticks at the same moment", async () => {
    const { E, u, b, id } = await putOffMention();
    const { sent } = fakePush();
    await putOff(u.userId, id, T0 - 1000);
    await Promise.all([queueLaterReturns(E, T0), queueLaterReturns(E, T0)]);
    expect(await pendingKeys(u.userId)).toHaveLength(1);
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(1);
  });

  it("while it is put off, its first push row does not send; only the return does", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await lastSent(u.userId);
    await writePersonMention(E, u.userId, "lm-away");
    const id = await inboxIdOf(u.userId, "lm-away");
    const until = Date.now() + 3_600_000;
    await putOff(u.userId, id, until);
    await drainPush(E, Date.now() + BUNDLE_MS);
    expect(sentTo(sent, b)).toHaveLength(0);
    expect(await pendingKeys(u.userId)).toEqual([]);
    await drainPush(E, until + 1000);
    expect(sentTo(sent, b)).toHaveLength(1);
  });

  it("retries the Later return if its transaction fails after inserting the notification", async () => {
    const { E, u, id } = await putOffMention();
    await putOff(u.userId, id, T0);
    await env.DB.prepare(`create trigger test_later_retry before update of pushed_at on inbox_later
      begin select raise(abort, 'simulated transaction failure'); end`).run();
    try {
      await queueLaterReturns(E, T0);
      expect(await pendingKeys(u.userId)).toEqual([]);
    } finally {
      await env.DB.prepare("drop trigger test_later_retry").run();
    }
    await queueLaterReturns(E, T0 + 1);
    expect(await pendingKeys(u.userId)).toHaveLength(1);
  });

  it("sends one return when the original is still queued and two ticks overlap", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await lastSent(u.userId);
    await writePersonMention(E, u.userId, "delayed");
    const id = await inboxIdOf(u.userId, "delayed");
    const until = Date.now() + 3_600_000;
    await putOff(u.userId, id, until);
    await queueLaterReturns(E, until);
    expect(await pendingKeys(u.userId)).toHaveLength(2);
    await Promise.all([drainPush(E, until), drainPush(E, until)]);
    const deliveries = sentTo(sent, b);
    expect(deliveries).toHaveLength(1);
    const payload = JSON.parse(await decrypt((deliveries[0] as Sent).body, b));
    expect(payload.body).toBe(DEFAULT_MENTION_BODY);
    expect(payload.count).toBeUndefined();
  });

  it("is not queued when the item is read, gone, another member's, an agent mention, or not Needs you", async () => {
    const { E, u, id } = await putOffMention();
    const { sent } = fakePush();
    // Read.
    await env.DB.prepare("update inbox_items set read_at = ? where id = ?")
      .bind(T0, id)
      .run();
    await putOff(u.userId, id, T0 - 1000);
    // Gone.
    await putOff(u.userId, "no-such-item", T0 - 1000);
    // Another member's item id in this member's Later row.
    const other = await enroll(E);
    await lastSent(other.u.userId);
    await writePersonMention(E, other.u.userId, "lm-theirs");
    const theirs = await inboxIdOf(other.u.userId, "lm-theirs");
    await env.DB.prepare("delete from push_pending where user_id = ?")
      .bind(other.u.userId)
      .run();
    await putOff(u.userId, theirs, T0 - 1000);
    // An agent's mention (not a person's) and an Update.
    for (const [iid, kind, level, key] of [
      ["lm-agent", "mention", "update", "mention:lm-agent-c"],
      ["lm-upd", "comment", "update", "comment:lm-upd-c"],
      ["lm-nn", "mention", "needs_you", "mention:lm-nn-c"],
    ])
      await env.DB.prepare(
        `insert into inbox_items (id, user_id, kind, level, key, artifact_id, thread_id, comment_id, actor, excerpt, created_at)
         values (?, ?, ?, ?, ?, ?, 'th-m', 'c', '{"kind":"user","ref":"x"}', 'x', ?)`,
      )
        .bind(iid, u.userId, kind, level, key, PUB, T0)
        .run()
        .then(() => putOff(u.userId, iid as string, T0 - 1000));
    await drainPush(E, T0);
    expect(await pendingKeys(u.userId)).toEqual([]);
    expect(await pendingKeys(other.u.userId)).toEqual([]);
    expect(sent).toHaveLength(0);
    // Every one was claimed: none is retried.
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from inbox_later where user_id = ? and pushed_at is null",
        )
          .bind(u.userId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });

  it("is dropped at send time when the item was read, deleted, or the page stopped being readable meanwhile", async () => {
    const { E, u, b, id } = await putOffMention();
    const { sent } = fakePush();
    // Queued (an hour from sending), then read before it goes.
    await putOff(u.userId, id, T0 - 1000);
    await queueLaterReturns(E, T0);
    expect(await pendingKeys(u.userId)).toHaveLength(1);
    await env.DB.prepare("update inbox_items set read_at = ? where id = ?")
      .bind(T0, id)
      .run();
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(0);
    expect(await pendingCount(u.userId)).toBe(0);

    // Deleted while queued.
    const two = await putOffMention();
    await putOff(two.u.userId, two.id, T0 - 1000);
    await queueLaterReturns(two.E, T0);
    await env.DB.prepare("delete from inbox_items where id = ?")
      .bind(two.id)
      .run();
    await drainPush(two.E, T0);
    expect(sentTo(sent, two.b)).toHaveLength(0);
    expect(await pendingCount(two.u.userId)).toBe(0);

    // The page is no longer readable.
    const three = await putOffMention();
    const owner = await mk(`own-${newId().slice(0, 4)}`);
    const om = await getUser(three.E, owner.userId);
    const me = await getUser(three.E, three.u.userId);
    const { id: priv } = await publish(
      three.E,
      om as never,
      { title: "Private", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    await env.DB.prepare(
      "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
    )
      .bind(priv, (me as { email: string }).email, owner.userId, Date.now())
      .run();
    await env.DB.prepare("update inbox_items set artifact_id = ? where id = ?")
      .bind(priv, three.id)
      .run();
    await putOff(three.u.userId, three.id, T0 - 1000);
    await queueLaterReturns(three.E, T0);
    expect(await pendingKeys(three.u.userId)).toHaveLength(1);
    await env.DB.prepare("delete from shares where artifact_id = ?")
      .bind(priv)
      .run();
    await drainPush(three.E, T0);
    expect(sentTo(sent, three.b)).toHaveLength(0);
    expect(await pendingCount(three.u.userId)).toBe(0);
  });

  it("is dropped at send time when the item's page changed from the queued one", async () => {
    const { E, u, b, id } = await putOffMention();
    const { sent } = fakePush();
    await putOff(u.userId, id, T0 - 1000);
    await queueLaterReturns(E, T0);
    await env.DB.prepare("update inbox_items set artifact_id = ? where id = ?")
      .bind(MUTED, id)
      .run();
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(0);
  });

  it("returns during quiet hours are held to when they end, then re-checked: read meanwhile sends nothing, still unread sends once", async () => {
    const night = Date.UTC(2026, 10, 18, 23, 0);
    const morning = Date.UTC(2026, 10, 19, 7, 30);
    const quiet = { quietHours: { start: "22:00", end: "07:30" } };
    const { sent } = fakePush();

    const unread = await putOffMention(quiet);
    await putOff(unread.u.userId, unread.id, night - 1000);
    await drainPush(unread.E, night);
    expect(await pendingKeys(unread.u.userId)).toEqual([
      expect.objectContaining({
        key: `later:mention:${unread.id}:${night - 1000}`,
        send_after: morning,
      }),
    ]);
    expect(sentTo(sent, unread.b)).toHaveLength(0);
    await drainPush(unread.E, morning - 1);
    expect(sentTo(sent, unread.b)).toHaveLength(0);
    await drainPush(unread.E, morning);
    expect(sentTo(sent, unread.b)).toHaveLength(1);

    const read = await putOffMention(quiet);
    await putOff(read.u.userId, read.id, night - 1000);
    await drainPush(read.E, night);
    expect(await pendingKeys(read.u.userId)).toHaveLength(1);
    await env.DB.prepare("update inbox_items set read_at = ? where id = ?")
      .bind(night + 1000, read.id)
      .run();
    await drainPush(read.E, morning);
    expect(sentTo(sent, read.b)).toHaveLength(0);
    expect(await pendingKeys(read.u.userId)).toEqual([]);
  });

  it("an ask put off and back still uses its own path and 'later' handling", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await env.DB.prepare(
      `insert or replace into artifact_asks (artifact_id, thread_id, comment_id, addressee, open, answered, question, asker, asked_at, confirm)
       values (?, 'thl', 'lm-ask', ?, 1, 0, 'Still there?', '{"kind":"user","ref":"x","name":"Scout"}', '2026-11-18T10:00:00Z', 0)`,
    )
      .bind(PUB, u.userId)
      .run();
    await env.DB.prepare(
      "insert into inbox_later (user_id, item_id, until, used, created_at) values (?, 'ask:lm-ask', ?, 1, ?)",
    )
      .bind(u.userId, T0 - 1000, T0 - 3_600_000)
      .run();
    await queueLaterReturns(E, T0);
    expect((await pendingKeys(u.userId)).map((r) => r.key)).toEqual([
      `later:ask:lm-ask:${T0 - 1000}`,
    ]);
    await drainPush(E, T0);
    expect(sentTo(sent, b)).toHaveLength(1);
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

  it("a comment deleted while queued takes its queued ask, and a deleted thread takes its queued items", async () => {
    const { E } = await world();
    const { u } = await enroll(E, detail);
    await queuePush(E, [u.userId], item("ask:dl1", { excerpt: "Oops" }), T0);
    expect(await pendingCount(u.userId)).toBe(1);
    await forgetCommentItems(E, {
      artifactId: PUB,
      threadId: "th1",
      commentId: "dl1",
      root: false,
    });
    expect(await pendingCount(u.userId)).toBe(0);
    // A deleted thread takes its queued items too.
    await queuePush(
      E,
      [u.userId],
      item("ask:th9", { threadId: "thX" }),
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
  it("the topic follows the payload's tag: Needs you only", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await queuePush(E, [u.userId], item("ask:tp1"), T0);
    await drainPush(E, T0);
    const mine = sent.filter((x) => x.url === b.body.endpoint);
    expect(mine.map((x) => x.headers.get("topic"))).toEqual(["needs-you"]);
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
  it("self-host recovery does not drain notifications", async () => {
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
    const off = { ...E, SESSION_SECRET: undefined } as unknown as Env;
    const base = await run(off, T0);
    await queuePush(E, [u.userId], item("ask:cr"), T0);
    // Push off: the due item stays.
    const mine = () => sent.filter((x) => x.url === b.body.endpoint);
    expect(await run(off, T0)).toBe(base);
    expect(mine()).toHaveLength(0);
    expect(await run(E, T0)).toBe(base);
    expect(mine()).toHaveLength(0);
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
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await mention(E, u.userId, "pm1");
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

  it("quiet hours hold it, and one push goes when they end", async () => {
    const { E } = await world();
    const { u, b } = await enroll(E, {
      quietHours: { start: "22:00", end: "07:00" },
    });
    const { sent } = fakePush();
    const night = Date.UTC(2026, 10, 18, 23, 0);
    vi.spyOn(Date, "now").mockReturnValue(night);
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

  it("'Interrupt me for': a person's mention pushes under either choice, it is Needs you", async () => {
    const { E } = await world();
    const every = await enroll(E, { browserAllAsks: true });
    const waiting = await enroll(E, { browserAllAsks: false });
    const { sent } = fakePush();
    await mention(E, every.u.userId, "pm4e");
    await mention(E, waiting.u.userId, "pm4w");
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, Date.now());
    expect(mineOf(sent, every.b)).toHaveLength(1);
    expect(mineOf(sent, waiting.b)).toHaveLength(1);
    expect(await pendingCount(waiting.u.userId)).toBe(0);
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
    await lastSent(u.userId);
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

  it("a bundle that holds a mention: 'N things need you', 'X asks, Y mentions', counts only, even with lock-screen detail", async () => {
    vi.spyOn(Date, "now").mockReturnValue(T0);
    const { E } = await world();
    for (const lockScreenDetail of [false, true]) {
      const { u, b } = await enroll(E, { lockScreenDetail });
      const { sent } = fakePush();
      await lastSent(u.userId, T0);
      await queuePush(E, [u.userId], item("ask:pm9a"), T0);
      await queuePush(E, [u.userId], item("ask:pm9b"), T0);
      await queuePush(E, [u.userId], item("ask:pm9c"), T0);
      await mention(E, u.userId, "pm9", { name: "Ann" });
      await env.DB.prepare("update push_pending set send_after = 0").run();
      await drainPush(E, T0);
      expect(mineOf(sent, b)).toHaveLength(1);
      const p = await bodyOf(sent, b);
      expect(p.title).toBe("4 things need you");
      expect(p.body).toBe("3 asks, 1 mention");
      expect(JSON.stringify(p)).not.toContain("Ann");
      expect(JSON.stringify(p)).not.toContain("waiting for your answer");
    }
  });

  it("singular and mention-only bundles read right; an asks-only bundle uses the same format", async () => {
    vi.spyOn(Date, "now").mockReturnValue(T0);
    const { E } = await world();
    const { u, b } = await enroll(E);
    const { sent } = fakePush();
    await lastSent(u.userId, T0);
    await queuePush(E, [u.userId], item("ask:pm10a"), T0);
    await mention(E, u.userId, "pm10");
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, T0);
    let p = await bodyOf(sent, b, 0);
    expect([p.title, p.body]).toEqual([
      "2 things need you",
      "1 ask, 1 mention",
    ]);
    await mention(E, u.userId, "pm11");
    await mention(E, u.userId, "pm12");
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, T0 + BUNDLE_MS);
    p = await bodyOf(sent, b, 1);
    expect([p.title, p.body]).toEqual(["2 things need you", "2 mentions"]);
    // Asks alone are as before.
    await queuePush(E, [u.userId], item("ask:pm13a"), T0);
    await queuePush(E, [u.userId], item("ask:pm13b"), T0);
    await env.DB.prepare("update push_pending set send_after = 0").run();
    await drainPush(E, T0 + 2 * BUNDLE_MS);
    p = await bodyOf(sent, b, 2);
    expect([p.title, p.body]).toEqual(["2 things need you", "2 asks"]);
  });
});

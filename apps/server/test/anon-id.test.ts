import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ANON_ID_HEADER,
  AnonViewerSchema,
  DataDocSchema,
  LIMITS,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  ANON_TOKEN_MAX_AGE_S,
  issueAnonToken,
  resolveAnonId,
} from "../src/runtime/anon-id.js";
import {
  type ArtifactRuntime,
  anonWritesPerMin,
  publicActor,
  runtimeStub,
} from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { b64urlEncode } from "../src/util/crypto.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; member: Member };
const TOKEN_RE = /^[A-Za-z0-9_-]{22}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{43}$/;
const BY_RE = /^anon:[A-Za-z0-9_-]{8}$/;

beforeAll(async () => {
  const l = await login(`anonid-${tag}@x.com`, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
});

const pub = async (extra: Record<string, unknown>) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "game",
        format: "html",
        content: "<p>hi</p>",
        capabilities: { db: true, viewer: true, storage: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const optIn = () => pub({ visibility: "public", allowAnonymousWrites: true });

let ipSeq = 0;
const uniqueIp = () =>
  `198.18.${Math.floor(Math.random() * 256)}.${(++ipSeq % 254) + 1}`;

/** Anonymous call (a fresh IP each, unless given) carrying `token`, if any. */
const anon = (
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; ip?: string } = {},
) =>
  api(app, path, null, {
    ...init,
    headers: {
      "cf-connecting-ip": init.ip ?? uniqueIp(),
      ...(token ? { [ANON_ID_HEADER]: token } : {}),
    },
  });
const write = (id: string, doc: string, token: string | null, ip?: string) =>
  anon(R.dataDoc(id, "c", doc), token, { method: "PUT", body: 1, ip });
const byOf = async (r: Response) =>
  DataDocSchema.parse(await r.json()).updatedBy;

/** A token minted for one browser (the artifact only picks the short id). */
const mintToken = async (artifactId: string) =>
  (await resolveAnonId(env, artifactId, undefined, true))?.issued ?? "";
/** This browser's public id on `artifactId`, via GET anon-id. */
const shortOn = async (artifactId: string, token: string | null) => {
  const r = await anon(R.anonId(artifactId), token);
  expect(r.status).toBe(200);
  return {
    short: AnonViewerSchema.parse(await r.json()).anonId,
    issued: r.headers.get(ANON_ID_HEADER),
  };
};

/** GET anon-id from one IP with a limiter that counts and denies everything. */
const viaDeny = async (id: string, token: string | null) => {
  const keys: string[] = [];
  const deny = {
    async limit({ key }: { key: string }) {
      keys.push(key);
      return { success: false };
    },
  };
  const r = await app.fetch(
    new Request(`http://app.localhost${R.anonId(id)}`, {
      headers: {
        "cf-connecting-ip": "192.0.2.10",
        ...(token ? { [ANON_ID_HEADER]: token } : {}),
      },
    }),
    { ...env, RL_ANON: deny },
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
  return { r, keys };
};

describe("anonId issuance", () => {
  it('is never issued on an artifact with dataWriters "editors"', async () => {
    const id = await pub({ visibility: "public", dataWriters: "editors" });
    const r = await anon(R.dataCollection(id, "c"), null);
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    const g = await anon(R.anonId(id), null);
    expect(g.status).toBe(401);
    expect(g.headers.get(ANON_ID_HEADER)).toBeNull();
  });

  it("reads never mint or echo a token", async () => {
    const id = await optIn();
    for (const t of [null, await mintToken(id), "garbage"]) {
      const r = await anon(R.dataCollection(id, "c"), t);
      expect(r.status).toBe(200);
      expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    }
  });

  it("GET anon-id mints once, then the short id is stable on that artifact", async () => {
    const id = await optIn();
    const first = await shortOn(id, null);
    const token = first.issued ?? "";
    expect(token).toMatch(TOKEN_RE);
    expect(first.short).toMatch(/^[A-Za-z0-9_-]{8}$/);
    // Not derived in the open from the token.
    expect(token.startsWith(first.short)).toBe(false);

    const again = await shortOn(id, token);
    expect(again).toEqual({ short: first.short, issued: null });
    const w1 = await write(id, "a", token);
    expect(w1.headers.get(ANON_ID_HEADER)).toBeNull();
    expect(await byOf(w1)).toBe(`anon:${first.short}`);
    // Another IP, same browser: same id.
    const w2 = await anon(R.dataDoc(id, "c", "b"), token, {
      method: "PATCH",
      body: { x: 1 },
    });
    expect(await byOf(w2)).toBe(`anon:${first.short}`);
  });

  it("the same browser has a different short id on each artifact", async () => {
    const [a, b] = [await optIn(), await optIn()];
    const { issued } = await shortOn(a, null);
    const token = issued ?? "";
    const sa = (await shortOn(a, token)).short;
    const sb = await shortOn(b, token);
    expect(sb.issued).toBeNull();
    expect(sb.short).not.toBe(sa);
    expect(await byOf(await write(a, "x", token))).toBe(`anon:${sa}`);
    expect(await byOf(await write(b, "x", token))).toBe(`anon:${sb.short}`);
  });

  it("a token-less write mints one and uses it", async () => {
    const id = await optIn();
    const w = await write(id, "a", null);
    expect(w.status).toBe(200);
    const token = w.headers.get(ANON_ID_HEADER) ?? "";
    expect(token).toMatch(TOKEN_RE);
    const { short } = await shortOn(id, token);
    expect(await byOf(w)).toBe(`anon:${short}`);
  });

  it("a forged or tampered token is never accepted: a new one is minted", async () => {
    const id = await optIn();
    const good = await mintToken(id);
    const goodShort = (await shortOn(id, good)).short;
    const [gid = "", giat = "", gsig = ""] = good.split(".");
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    const forged = [
      `${flip(gid, 0)}.${giat}.${gsig}`, // claims another id
      `${gid}.${giat}.${flip(gsig, 5)}`, // bad signature
      `${gid}.${(Number.parseInt(giat, 36) - 1).toString(36)}.${gsig}`, // tampered iat
      `${gid}.0${giat}.${gsig}`, // non-canonical iat
      `${gid}.${giat}.${"A".repeat(43)}`,
      `${gid}.${gsig}`, // v2 sig as a v1 token
      `${gid}`,
      `${gid}.${giat}.${gsig}x`,
      "garbage",
      `${gid}..${gsig}`,
      `${gsig}.${giat}.${gid}`,
    ];
    for (const f of forged) {
      const w = await write(id, "f", f);
      expect(w.status).toBe(200);
      const fresh = w.headers.get(ANON_ID_HEADER) ?? "";
      expect(fresh).toMatch(TOKEN_RE);
      expect(fresh).not.toBe(f);
      const by = await byOf(w);
      expect(by).not.toBe(`anon:${goodShort}`);
      expect(by).toBe(`anon:${(await shortOn(id, fresh)).short}`);
    }
    // A token signed with another key is refused too.
    const other =
      (
        await resolveAnonId(
          { SESSION_SECRET: "x".repeat(40) },
          id,
          undefined,
          true,
        )
      )?.issued ?? "";
    const w = await write(id, "g", other);
    const fresh = w.headers.get(ANON_ID_HEADER);
    expect(fresh).toMatch(TOKEN_RE);
    expect(fresh).not.toBe(other);
  });

  it("two browsers get distinct ids", async () => {
    const id = await optIn();
    const a = await shortOn(id, null);
    const b = await shortOn(id, null);
    expect(a.issued).toMatch(TOKEN_RE);
    expect(b.issued).toMatch(TOKEN_RE);
    expect(a.issued?.slice(0, 22)).not.toBe(b.issued?.slice(0, 22));
    expect(a.short).not.toBe(b.short);
    const [ba, bb] = [
      await byOf(await write(id, "a", a.issued)),
      await byOf(await write(id, "b", b.issued)),
    ];
    expect(ba).toBe(`anon:${a.short}`);
    expect(bb).toBe(`anon:${b.short}`);
    expect(ba).toMatch(BY_RE);
  });

  it("signed-in callers are unchanged: no token, updatedBy u:{id}", async () => {
    const id = await optIn();
    const token = await mintToken(id);
    const r = await api(app, R.dataDoc(id, "c", "s"), owner.cookie, {
      method: "PUT",
      body: 1,
      headers: { [ANON_ID_HEADER]: token },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    expect(await byOf(r)).toBe(`u:${owner.member.id}`);
    expect((await api(app, R.anonId(id), owner.cookie)).status).toBe(401);
  });

  it("GET anon-id needs the viewer capability and is rate limited per IP", async () => {
    const noViewer = await pub({
      visibility: "public",
      allowAnonymousWrites: true,
      capabilities: { db: true, viewer: false, storage: false },
    });
    expect((await anon(R.anonId(noViewer), null)).status).toBe(403);
    const id = await optIn();
    const keys: string[] = [];
    const deny = {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: false };
      },
    };
    const r = await app.fetch(
      new Request(`http://app.localhost${R.anonId(id)}`, {
        headers: { "cf-connecting-ip": "192.0.2.9" },
      }),
      { ...env, RL_ANON: deny },
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(r.status).toBe(429);
    expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
    expect(keys).toEqual(["anonid:ip:192.0.2.9"]);
  });

  it("GET anon-id with a valid token never spends the per-IP limit", async () => {
    const id = await optIn();
    const token = await mintToken(id);
    const { short } = await shortOn(id, token);
    // Well past 30 a minute from one IP, with the limiter refusing everything.
    for (let i = 0; i < 40; i++) {
      const { r, keys } = await viaDeny(id, token);
      expect(r.status).toBe(200);
      expect(AnonViewerSchema.parse(await r.json()).anonId).toBe(short);
      expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
      expect(keys).toEqual([]);
    }
  });

  it("GET anon-id with a forged or expired token still counts against the limit", async () => {
    const id = await optIn();
    const good = await mintToken(id);
    const [gid = "", giat = "", gsig = ""] = good.split(".");
    // Flip the first character: all 6 of its bits count, so the forgery can
    // never equal the real signature (the last ones carry padding bits).
    const forged = `${gid}.${giat}.${gsig[0] === "A" ? "B" : "A"}${gsig.slice(1)}`;
    const expired = await issueAnonToken(
      env,
      gid,
      Math.floor(Date.now() / 1000) - ANON_TOKEN_MAX_AGE_S - 60,
    );
    for (const t of [forged, expired]) {
      const { r, keys } = await viaDeny(id, t);
      expect(r.status).toBe(429);
      expect(r.headers.get(ANON_ID_HEADER)).toBeNull();
      expect(keys).toEqual(["anonid:ip:192.0.2.10"]);
    }
  });

  it("embed mode (X-OA-Embed: 1) with a cookie runs anonymously and mints", async () => {
    const id = await optIn();
    const r = await api(app, R.anonId(id), owner.cookie, {
      headers: { "x-oa-embed": "1", "cf-connecting-ip": uniqueIp() },
    });
    expect(r.status).toBe(200);
    const token = r.headers.get(ANON_ID_HEADER) ?? "";
    expect(token).toMatch(TOKEN_RE);
    const { anonId } = AnonViewerSchema.parse(await r.json());
    // The same browser's id outside embed mode.
    expect((await shortOn(id, token)).short).toBe(anonId);
    // A write with the cookie in embed mode is anonymous too.
    const w = await api(app, R.dataDoc(id, "c", "e"), owner.cookie, {
      method: "PUT",
      body: 1,
      headers: {
        "x-oa-embed": "1",
        "cf-connecting-ip": uniqueIp(),
        [ANON_ID_HEADER]: token,
      },
    });
    expect(await byOf(w)).toBe(`anon:${anonId}`);
  });

  it("anonymous storage never mints", async () => {
    const id = await optIn();
    const s = await anon(R.storageKey(id, "k"), null);
    expect(s.status).toBe(401);
    expect(s.headers.get(ANON_ID_HEADER)).toBeNull();
  });
});

/** A legacy v1 token ("<id>.<sig>", info "oa/anon-id/v1") for `id`. */
async function v1Token(id: string): Promise<string> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const k = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode("oa/anon-id/v1"),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(`anon:${id}`),
  );
  return `${id}.${b64urlEncode(new Uint8Array(sig))}`;
}

describe("anonId token expiry", () => {
  const DAY = 86_400;
  const nowS = Math.floor(Date.now() / 1000);
  const freshId = () =>
    b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const idOf = (t: string | null | undefined) => (t ?? "").split(".")[0];

  it("a v2 token within 30 days is accepted as is", async () => {
    const id = await optIn();
    const t = await issueAnonToken(env, freshId(), nowS - 29 * DAY);
    expect(t).toMatch(TOKEN_RE);
    const r = await shortOn(id, t);
    expect(r.issued).toBeNull();
    expect(await byOf(await write(id, "a", t))).toBe(`anon:${r.short}`);
  });

  it("an expired token is re-minted with the same id and short id", async () => {
    const id = await optIn();
    const bid = freshId();
    const fresh = await issueAnonToken(env, bid, nowS);
    const short = (await shortOn(id, fresh)).short;
    const old = await issueAnonToken(env, bid, nowS - ANON_TOKEN_MAX_AGE_S - 1);
    const w = await write(id, "a", old);
    expect(w.status).toBe(200);
    const renewed = w.headers.get(ANON_ID_HEADER);
    expect(renewed).toMatch(TOKEN_RE);
    expect(renewed).not.toBe(old);
    expect(idOf(renewed)).toBe(bid);
    expect(await byOf(w)).toBe(`anon:${short}`);
    // The renewed token is accepted without another re-mint.
    expect(await shortOn(id, renewed)).toEqual({ short, issued: null });
    // Exactly at the limit is still valid.
    const edge = await resolveAnonId(
      env,
      id,
      await issueAnonToken(env, bid, nowS - ANON_TOKEN_MAX_AGE_S),
      true,
      nowS * 1000,
    );
    expect(edge).toEqual({ short, issued: null });
  });

  it("a v1 token is upgraded to v2 with the same id and short id", async () => {
    const id = await optIn();
    const bid = freshId();
    const v1 = await v1Token(bid);
    const first = await shortOn(id, v1);
    const up = first.issued;
    expect(up).toMatch(TOKEN_RE);
    expect(idOf(up)).toBe(bid);
    expect(first.short).toBe(
      (await shortOn(id, await issueAnonToken(env, bid, nowS))).short,
    );
    expect(await shortOn(id, up)).toEqual({
      short: first.short,
      issued: null,
    });
    // A forged v1 token gets a new id.
    const w = await write(id, "f", `${freshId()}.${v1.split(".")[1]}`);
    expect(idOf(w.headers.get(ANON_ID_HEADER))).not.toBe(bid);
  });

  it("GET anon-id with a v1 token counts against the limit (it re-mints)", async () => {
    const id = await optIn();
    const { r, keys } = await viaDeny(id, await v1Token(freshId()));
    expect(r.status).toBe(429);
    expect(keys).toEqual(["anonid:ip:192.0.2.10"]);
  });

  it("a future iat (beyond 5 min of skew) is rejected: a new id is minted", async () => {
    const id = await optIn();
    const bid = freshId();
    const skewed = await issueAnonToken(env, bid, nowS + 4 * 60);
    expect((await shortOn(id, skewed)).issued).toBeNull();
    const future = await issueAnonToken(env, bid, nowS + 10 * 60);
    const w = await write(id, "a", future);
    expect(w.status).toBe(200);
    const fresh = w.headers.get(ANON_ID_HEADER);
    expect(fresh).toMatch(TOKEN_RE);
    expect(idOf(fresh)).not.toBe(bid);
    expect(await resolveAnonId(env, id, future, false)).toBeNull();
  });
});

describe("publicActor", () => {
  it("maps anonymous actors to anon / anon:{short}", () => {
    expect(publicActor("ip:1.2.3.4")).toBe("anon");
    expect(publicActor("ip:1.2.3.4|AbCd_-12")).toBe("anon:AbCd_-12");
    expect(publicActor("ip:2001:db8:1:2::/64|AbCd_-12")).toBe("anon:AbCd_-12");
    expect(publicActor("ip:1.2.3.4|short")).toBe("anon");
    expect(publicActor("u:abc")).toBe("u:abc");
  });
});

describe("ANON_WRITES_PER_MIN", () => {
  it("defaults to LIMITS.anonWritesPerMinPerIp and clamps to 1..600", () => {
    expect(anonWritesPerMin(undefined)).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("abc")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("-5")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("2.5")).toBe(LIMITS.anonWritesPerMinPerIp);
    expect(anonWritesPerMin("0")).toBe(1);
    expect(anonWritesPerMin("45")).toBe(45);
    expect(anonWritesPerMin(" 45 ")).toBe(45);
    expect(anonWritesPerMin("600")).toBe(600);
    expect(anonWritesPerMin("100000")).toBe(600);
  });

  /** One anonymous write from a fixed IP with stubbed limiters; returns the keys each was asked for. */
  const writeVia = async (id: string, extra: Record<string, unknown>) => {
    const calls: string[] = [];
    const lim = (name: string, ok: boolean) => ({
      async limit({ key }: { key: string }) {
        calls.push(`${name}:${key}`);
        return { success: ok };
      },
    });
    const e: Record<string, unknown> = { ...env, RL_ANON: lim("anon", true) };
    for (const [k, v] of Object.entries(extra))
      e[k] =
        typeof v === "object" && v && "ok" in v
          ? lim(k, (v as { ok: boolean }).ok)
          : v;
    const r = await app.fetch(
      new Request(`http://app.localhost${R.dataDoc(id, "c", "d")}`, {
        method: "PUT",
        body: "1",
        headers: {
          "cf-connecting-ip": "192.0.2.44",
          "content-type": "application/json",
        },
      }),
      e,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return { r, calls };
  };

  it("by default anonymous writes still spend RL_ANON per IP (review item 38)", async () => {
    const id = await optIn();
    const { r, calls } = await writeVia(id, {});
    expect(r.status).toBe(200);
    expect(calls).toEqual(["anon:ip:192.0.2.44"]);
  });

  it("RL_ANON_WRITES, when bound, replaces RL_ANON for writes so a raised ANON_WRITES_PER_MIN works", async () => {
    const id = await optIn();
    const ok = await writeVia(id, {
      RL_ANON_WRITES: { ok: true },
      RL_ANON: undefined,
    });
    expect(ok.r.status).toBe(200);
    expect(ok.calls).toEqual(["RL_ANON_WRITES:ip:192.0.2.44"]);
    const denied = await writeVia(id, { RL_ANON_WRITES: { ok: false } });
    expect(denied.r.status).toBe(429);
    expect(denied.calls).toEqual(["RL_ANON_WRITES:ip:192.0.2.44"]);
  });

  it("with HOSTED=1 both limiters apply (hosted only tightens)", async () => {
    const id = await optIn();
    const { calls } = await writeVia(id, {
      RL_ANON_WRITES: { ok: true },
      HOSTED: "1",
    });
    expect(calls).toEqual([
      "anon:ip:192.0.2.44",
      "RL_ANON_WRITES:ip:192.0.2.44",
    ]);
  });

  it("the DO applies it per IP, across anonIds", async () => {
    const id = await optIn();
    await runInDurableObject(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) => {
        i.now = () => Date.UTC(2026, 0, 1, 12, 0, 30);
        (i as unknown as { env: object }).env = {
          ...(i as unknown as { env: object }).env,
          ANON_WRITES_PER_MIN: "3",
        };
      },
    );
    const ip = uniqueIp();
    for (let n = 0; n < 3; n++)
      expect((await write(id, `d${n}`, null, ip)).status).toBe(200);
    // A fresh anonId from the same IP doesn't reset the per-IP count.
    const r = await write(id, "x", null, ip);
    expect(r.status).toBe(429);
    expect((await write(id, "y", null, uniqueIp())).status).toBe(200);
  });
});

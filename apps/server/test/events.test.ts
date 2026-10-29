// R.events: live version updates (hello / version / gone) on the artifact's DO.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ArtifactEvent,
  ArtifactEventSchema,
  EVENTS_GONE_CLOSE,
  type Member,
  newId,
  PRESENCE_COOKIE,
  PRESENCE_KEY_RE,
  type PresenceFrame,
  PresenceFrameSchema,
  R,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { appOrigin } from "../src/http/errors.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { anonIpKey } from "../src/runtime/routes.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { connect, tool } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
let guest: U;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      { title: "ev", format: "html", content: "<p>1</p>", ...extra } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const UP = { upgrade: "websocket" };
let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 250) + 1}`;

type Sock = {
  ws: WebSocket;
  /** Every frame except presence (those are in `presence`). */
  frames: ArtifactEvent[];
  /** Presence frames only, in order. */
  presence: PresenceFrame[];
  /** Raw JSON text of every frame, presence included. */
  raw: string[];
  /** The next non-presence frame. */
  next: () => Promise<ArtifactEvent>;
  /** The next presence frame (skips the others). */
  nextOf: (type: "presence") => Promise<PresenceFrame>;
  closed: Promise<number>;
};

function wrap(ws: WebSocket): Sock {
  const frames: ArtifactEvent[] = [];
  const presence: PresenceFrame[] = [];
  const raw: string[] = [];
  const waiters: ((f: ArtifactEvent) => void)[] = [];
  const pWaiters: ((f: PresenceFrame) => void)[] = [];
  let read = 0;
  let pRead = 0;
  ws.addEventListener("message", (e) => {
    const text = String(e.data);
    raw.push(text);
    const j = JSON.parse(text);
    if (j.type === "presence") {
      const f = PresenceFrameSchema.parse(j);
      presence.push(f);
      pWaiters.shift()?.(f);
      return;
    }
    const f = ArtifactEventSchema.parse(j);
    frames.push(f);
    waiters.shift()?.(f);
  });
  const closed = new Promise<number>((res) =>
    ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
  );
  ws.accept();
  return {
    ws,
    frames,
    presence,
    raw,
    closed,
    next: () => {
      const i = read++;
      const f = frames[i];
      if (f) return Promise.resolve(f);
      return new Promise((res) => waiters.push(res));
    },
    nextOf: () => {
      const i = pRead++;
      const f = presence[i];
      if (f) return Promise.resolve(f);
      return new Promise((res) => pWaiters.push(res));
    },
  };
}

/** Opens R.events as `u` (null: anonymous), returning the response if not 101. */
async function open(
  id: string,
  u: U | null,
  headers: Record<string, string> = {},
  path = R.events(id),
): Promise<Sock | Response> {
  const r = await api(app, path, u?.cookie ?? null, {
    headers: { ...UP, "cf-connecting-ip": ip(), ...headers },
  });
  return r.webSocket ? wrap(r.webSocket) : r;
}
async function sock(
  id: string,
  u: U | null,
  headers: Record<string, string> = {},
  path?: string,
): Promise<Sock> {
  const s = await open(id, u, headers, path);
  if (s instanceof Response) throw new Error(`no websocket (${s.status})`);
  return s;
}

/** The version row's user attribution (name, else email). */
const ownerName = () => owner.member.name ?? owner.email;

const restPublish = async (id: string, u: U, content: string) => {
  const r = await api(app, R.versions(id), u.cookie, {
    method: "POST",
    body: { format: "html", content },
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { version: number }).version;
};

beforeAll(async () => {
  owner = await mk("ev-owner", "member");
  viewer = await mk("ev-viewer", "member");
  guest = await mk("ev-guest", "guest");
});

describe("events socket", () => {
  it("connect gives hello with the current version; 426 without Upgrade", async () => {
    const id = await pub({ visibility: "team" });
    await restPublish(id, owner, "<p>2</p>");
    const s = await sock(id, viewer);
    expect(await s.next()).toEqual({
      type: "hello",
      version: 2,
      you: expect.stringMatching(PRESENCE_KEY_RE),
    });
    const no = await api(app, R.events(id), viewer.cookie);
    expect(no.status).toBe(426);
    s.ws.close();
  });

  it("a REST publish sends a version event to every socket; names only to members", async () => {
    const id = await pub({ visibility: "public" });
    const socks = [
      await sock(id, owner),
      await sock(id, viewer),
      await sock(id, null),
    ];
    for (const s of socks) expect((await s.next()).type).toBe("hello");
    const v = await restPublish(id, owner, "<p>2</p>");
    const [o, m, a] = await Promise.all(socks.map((s) => s.next()));
    const by = { kind: "user", name: ownerName() };
    expect(o).toMatchObject({ type: "version", version: v, by });
    expect(m).toMatchObject({ type: "version", version: v, by });
    expect(a).toEqual({
      type: "version",
      version: v,
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      by: { kind: "user" },
    });
    expect(JSON.stringify(a)).not.toContain("ev-owner");
    expect(Object.keys(o as object)).toEqual(["type", "version", "at", "by"]);
    for (const s of socks) s.ws.close();
  });

  it("embed sockets and guests on a public link never see names", async () => {
    const id = await pub({ visibility: "public" });
    const e = await sock(id, owner, {}, `${R.events(id)}?embed=1`);
    const g = await sock(id, guest);
    await e.next();
    await g.next();
    await restPublish(id, owner, "<p>2</p>");
    expect((await e.next()) as object).toMatchObject({ by: { kind: "user" } });
    expect(e.frames[1]).not.toHaveProperty("by.name");
    expect(await g.next()).not.toHaveProperty("by.name");
    e.ws.close();
    g.ws.close();
  });

  it("a guest with a share on a private artifact sees names", async () => {
    const id = await pub({ visibility: "private" });
    const sh = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: guest.email, role: "viewer" },
    });
    expect(sh.status).toBe(200);
    const g = await sock(id, guest);
    await g.next();
    await restPublish(id, owner, "<p>2</p>");
    expect(await g.next()).toMatchObject({
      by: { kind: "user", name: ownerName() },
    });
    g.ws.close();
  });

  describe("MCP", () => {
    let client: Awaited<ReturnType<typeof connect>>;
    beforeAll(async () => {
      client = await connect((await createPat(env, owner.userId, "ev")).token, {
        clientInfo: { name: "ev-agent", version: "1.0.0" },
      });
    });
    afterAll(() => client.close());

    it("an MCP publish and restore send version events (agent, restoredFrom)", async () => {
      const id = await pub({ visibility: "public" });
      const m = await sock(id, viewer);
      const a = await sock(id, null);
      await m.next();
      await a.next();
      const r = await tool(client, "publish_artifact", {
        id,
        format: "html",
        content: "<p>2</p>",
      });
      expect(r.isError).toBeFalsy();
      expect(await m.next()).toMatchObject({
        type: "version",
        version: 2,
        by: { kind: "agent", name: "ev" },
      });
      expect(await a.next()).toMatchObject({
        type: "version",
        version: 2,
        by: { kind: "agent" },
      });
      expect(a.frames[1]).not.toHaveProperty("by.name");

      const rr = await tool(client, "restore_version", { id, version: 1 });
      expect(rr.isError).toBeFalsy();
      expect(await m.next()).toMatchObject({
        type: "version",
        version: 3,
        restoredFrom: 1,
        by: { kind: "agent", name: "ev" },
      });
      expect(await a.next()).toMatchObject({ version: 3, restoredFrom: 1 });
      m.ws.close();
      a.ws.close();
    });
  });

  it("a REST restore sends a version event with restoredFrom", async () => {
    const id = await pub({ visibility: "team" });
    await restPublish(id, owner, "<p>2</p>");
    const s = await sock(id, viewer);
    expect(await s.next()).toEqual({
      type: "hello",
      version: 2,
      you: expect.stringMatching(PRESENCE_KEY_RE),
    });
    const r = await api(app, R.restoreVersion(id, 1), owner.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(201);
    expect(await s.next()).toMatchObject({
      type: "version",
      version: 3,
      restoredFrom: 1,
    });
    s.ws.close();
  });

  it("delete sends gone then closes 4403", async () => {
    const id = await pub({ visibility: "team" });
    const s = await sock(id, viewer);
    await s.next();
    const d = await api(app, R.artifact(id), owner.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    expect(await s.next()).toEqual({ type: "gone", reason: "deleted" });
    expect(await s.closed).toBe(EVENTS_GONE_CLOSE);
    // Reconnect re-checks access.
    expect(((await open(id, viewer)) as Response).status).toBe(404);
  });

  it("making it private closes an anonymous socket with gone", async () => {
    const id = await pub({ visibility: "public" });
    const s = await sock(id, null);
    await s.next();
    const p = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { visibility: "private" },
    });
    expect(p.status).toBe(200);
    expect(await s.next()).toEqual({ type: "gone", reason: "changed" });
    expect(await s.closed).toBe(4403);
    expect(((await open(id, null)) as Response).status).toBe(404);
  });

  it("a non-reader gets 404; a bad id 404", async () => {
    const id = await pub({ visibility: "team" });
    expect(((await open(id, guest)) as Response).status).toBe(404);
    expect(((await open(id, null)) as Response).status).toBe(404);
    const priv = await pub({ visibility: "private" });
    expect(((await open(priv, viewer)) as Response).status).toBe(404);
    expect(
      ((await open("nope", viewer, {}, R.events("nope"))) as Response).status,
    ).toBe(404);
  });

  it("a foreign Origin is refused; the app Origin is accepted", async () => {
    const id = await pub({ visibility: "team" });
    const r = (await open(id, viewer, {
      origin: "https://evil.example",
    })) as Response;
    expect(r.status).toBe(403);
    const ok = await sock(id, viewer, {
      origin: appOrigin(env),
    });
    expect((await ok.next()).type).toBe("hello");
    ok.ws.close();
  });

  it("embed=1 plus a cookie on a private artifact gives 404; X-OA-Embed too", async () => {
    const id = await pub({ visibility: "private" });
    const r = await open(id, owner, {}, `${R.events(id)}?embed=1`);
    expect((r as Response).status).toBe(404);
    const h = await open(id, owner, { "x-oa-embed": "1" });
    expect((h as Response).status).toBe(404);
    expect((await sock(id, owner)).ws.readyState).toBe(1);
  });

  it("a public artifact with embed=1 works", async () => {
    const id = await pub({ visibility: "public" });
    const s = await sock(id, null, {}, `${R.events(id)}?embed=1`);
    expect(await s.next()).toEqual({ type: "hello", version: 1 });
    s.ws.close();
  });

  it("works without the db capability; data reset leaves event sockets open", async () => {
    const id = await pub({
      visibility: "team",
      capabilities: { db: true, viewer: false, storage: false },
    });
    const s = await sock(id, viewer);
    await s.next();
    const reset = await api(app, R.dataReset(id), owner.cookie, {
      method: "PUT",
      body: { collections: {} },
    });
    expect(reset.status).toBe(200);
    await restPublish(id, owner, "<p>2</p>");
    expect(await s.next()).toMatchObject({ type: "version", version: 2 });
    expect(s.ws.readyState).toBe(1);
    s.ws.close();
  });

  it("any client message closes the socket (1008)", async () => {
    const id = await pub({ visibility: "team" });
    const s = await sock(id, viewer);
    await s.next();
    s.ws.send("hi");
    expect(await s.closed).toBe(1008);
  });

  it("uses the hibernation API: tagged by viewer class, attachment survives", async () => {
    // The pool can't force a hibernation; this checks what hibernation keeps:
    // sockets accepted via ctx.acceptWebSocket with their tags and attachment.
    const id = await pub({ visibility: "public" });
    const m = await sock(id, viewer);
    const a = await sock(id, null);
    await m.next();
    await a.next();
    await runInDurableObject(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        expect(state.getWebSockets("~ev")).toHaveLength(2);
        const named = state.getWebSockets("~ev:named");
        expect(named).toHaveLength(1);
        expect(named[0]?.deserializeAttachment()).toMatchObject({
          named: true,
        });
        expect(state.getWebSockets("~ev:anon")).toHaveLength(1);
      },
    );
    m.ws.close();
    a.ws.close();
  });
});

describe("events socket: access changes and budgets", () => {
  const status = async (p: Promise<Sock | Response>) => {
    const s = await p;
    if (s instanceof Response) return s.status;
    s.ws.close();
    return 101;
  };

  it("a publish that makes it private sends anonymous sockets gone, never the version", async () => {
    const id = await pub({ visibility: "public" });
    const s = await sock(id, null);
    await s.next();
    const r = await api(app, R.versions(id), owner.cookie, {
      method: "POST",
      body: { format: "html", content: "<p>2</p>", visibility: "private" },
    });
    expect(r.status).toBe(201);
    expect(await s.next()).toEqual({ type: "gone", reason: "changed" });
    expect(await s.closed).toBe(4403);
    expect(s.frames.some((f) => f.type === "version")).toBe(false);
  });

  it("an actor is required: no IP at the route is refused, no actor at the DO is 400", async () => {
    const id = await pub({ visibility: "public" });
    // The route never forwards an anonymous caller without an IP key (as
    // data-subscribe: 429 rate_limited "Anonymous access is unavailable").
    const r = await app.fetch(
      new Request(`http://app.localhost${R.events(id)}`, { headers: UP }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(r.status).toBe(429);
    // Defensively, the DO itself refuses an events upgrade with no actor.
    const d = await runtimeStub(env, id).fetch(
      "https://runtime.invalid/events",
      {
        headers: { Upgrade: "websocket", "X-OA-Version": "1" },
      },
    );
    expect(d.status).toBe(400);
    expect(await d.text()).toBe("Missing actor");
  });

  it("anonIpKey: IPv4 as is, IPv6 by /56", () => {
    expect(anonIpKey("203.0.113.7")).toBe("203.0.113.7");
    expect(anonIpKey("2001:db8:1:1ff:a::1")).toBe("2001:db8:1:100::/56");
    expect(anonIpKey("2001:db8:1:ff::1")).toBe("2001:db8:1:0::/56");
    expect(anonIpKey("junk")).toBeNull();
  });

  it("3 anonymous events sockets per /56; a 4th from another /64 in it is refused", async () => {
    const id = await pub({ visibility: "public" });
    const at = (ip: string) => ({ "cf-connecting-ip": ip });
    const held = [
      await sock(id, null, at("2001:db8:5:100::1")),
      await sock(id, null, at("2001:db8:5:1ff::1")),
      await sock(id, null, at("2001:db8:5:150::9")),
    ];
    expect(await status(open(id, null, at("2001:db8:5:1aa::1")))).toBe(429);
    expect(await status(open(id, null, at("2001:db8:5:200::1")))).toBe(101);
    // Members aren't limited by the anonymous caps.
    for (let i = 0; i < 5; i++)
      expect(await status(open(id, viewer))).toBe(101);
    for (const s of held) s.ws.close();
  });

  it("anonymous events sockets at the pool cap starve neither data sockets nor members", async () => {
    const id = await pub({
      visibility: "public",
      capabilities: { db: true, viewer: false, storage: false },
    });
    const held: Sock[] = [];
    // 34 IPv4 actors × 3 = 102, over the 100-socket anonymous pool.
    let refused = 0;
    for (let a = 0; a < 34; a++)
      for (let k = 0; k < 3; k++) {
        const s = await open(id, null, {
          "cf-connecting-ip": `192.0.2.${a + 1}`,
        });
        if (s instanceof Response) {
          expect(s.status).toBe(429);
          refused++;
        } else held.push(s);
      }
    expect(held).toHaveLength(100);
    expect(refused).toBe(2);
    // Live data still connects (its own pool), anonymously and signed in.
    for (const [cookie, ip] of [
      [null, "192.0.2.200"],
      [viewer.cookie, "192.0.2.201"],
    ] as const) {
      const d = await api(app, R.dataSubscribe(id, "c"), cookie, {
        headers: { ...UP, "cf-connecting-ip": ip },
      });
      expect(d.status).toBe(101);
      d.webSocket?.accept();
      d.webSocket?.close();
    }
    // Members' events sockets have their own pool.
    expect(await status(open(id, viewer))).toBe(101);
    expect(await status(open(id, owner))).toBe(101);
    for (const s of held) s.ws.close();
  }, 60_000); // ~100 upgrades: slow when the whole suite shares the CPU
});

describe("events socket: presence", () => {
  const pid = (n: string) => `${n}${"x".repeat(20)}`;
  const viewersOf = (f: PresenceFrame) => f.viewers.map((v) => v.name);
  /** A third viewer's first roster, once `n` sockets are already open. */
  const rosterSeenBy = async (id: string, u: U | null, h = {}) => {
    const s = await sock(id, u, h);
    return { s, roster: await s.nextOf("presence") };
  };

  it("two tabs of one signed-in person show once to a third viewer", async () => {
    const id = await pub({ visibility: "team" });
    const a1 = await sock(id, viewer);
    const a2 = await sock(id, viewer);
    await a1.next();
    await a2.next();
    const { s: c, roster } = await rosterSeenBy(id, owner);
    // The person (two tabs) and the third viewer: two faces, three sockets.
    expect(roster.viewers).toHaveLength(2);
    expect(new Set(roster.viewers.map((v) => v.key)).size).toBe(2);
    expect(roster.total).toBe(2);
    for (const x of [a1, a2, c]) x.ws.close();
  });

  it("an anonymous viewer shows as Anonymous <Animal>; two tabs with one oa_pid show once", async () => {
    const id = await pub({ visibility: "public" });
    const cookie = { cookie: `${PRESENCE_COOKIE}=${pid("same")}` };
    const a1 = await sock(id, null, cookie);
    const a2 = await sock(id, null, cookie);
    const { s: c, roster } = await rosterSeenBy(id, owner);
    const anon = roster.viewers.filter((v) => v.kind === "anon");
    expect(anon).toHaveLength(1);
    expect(anon[0]?.name).toMatch(/^Anonymous [A-Z][a-z]+/);
    for (const x of [a1, a2, c]) x.ws.close();
  });

  it("the anonymous frame never carries the anonId, the oa_pid or the IP", async () => {
    const id = await pub({ visibility: "public" });
    const addr = "198.51.100.77";
    const secret = pid("secret");
    const a = await sock(id, null, {
      "cf-connecting-ip": addr,
      cookie: `${PRESENCE_COOKIE}=${secret}; oa_anon=anon-${tag}`,
    });
    const { s: c } = await rosterSeenBy(id, owner);
    await a.nextOf("presence");
    for (const x of [a, c]) {
      const all = x.raw.join("\n");
      expect(all).not.toContain(secret);
      expect(all).not.toContain("198.51.100.");
      expect(all).not.toContain(`anon-${tag}`);
      expect(all).not.toContain(owner.email);
      expect(all).not.toContain(owner.userId);
    }
    a.ws.close();
    c.ws.close();
  });

  it("a guest and a stranger on a public link see names but never emails", async () => {
    const id = await pub({ visibility: "public" });
    const o = await sock(id, owner);
    const g = await sock(id, guest);
    const { s: z, roster } = await rosterSeenBy(id, null);
    await o.nextOf("presence");
    await g.nextOf("presence");
    for (const x of [o, g, z]) {
      const all = x.raw.join("\n");
      for (const u of [owner, guest, viewer])
        expect(all).not.toContain(u.email);
    }
    // Neither has a real name: "Member" and "Guest", never the email.
    expect(viewersOf(roster)).toEqual(
      expect.arrayContaining(["Member", "Guest"]),
    );
    for (const x of [o, g, z]) x.ws.close();
  });

  it("the presence key differs per artifact for the same person", async () => {
    const [i1, i2] = [
      await pub({ visibility: "team" }),
      await pub({ visibility: "team" }),
    ];
    const a = await sock(i1, viewer);
    const b = await sock(i2, viewer);
    const youA = (await a.next()) as { you?: string };
    const youB = (await b.next()) as { you?: string };
    expect(youA.you).toMatch(PRESENCE_KEY_RE);
    expect(youB.you).toMatch(PRESENCE_KEY_RE);
    expect(youA.you).not.toBe(youB.you);
    a.ws.close();
    b.ws.close();
  });

  it("a malformed or 65-char oa_pid gives a per-socket face, not an error", async () => {
    const id = await pub({ visibility: "public" });
    const bad = ["short", "x".repeat(65), `${"x".repeat(15)}!`];
    const socks: Sock[] = [];
    for (const v of bad)
      socks.push(await sock(id, null, { cookie: `${PRESENCE_COOKIE}=${v}` }));
    const { s: c, roster } = await rosterSeenBy(id, owner);
    expect(roster.viewers.filter((v) => v.kind === "anon")).toHaveLength(3);
    for (const x of [...socks, c]) x.ws.close();
  });

  it("embed sockets (?embed=1 alone, X-OA-Embed alone, and both) are not counted and get no presence frames", async () => {
    const id = await pub({ visibility: "public" });
    const e1 = await sock(id, null, {}, `${R.events(id)}?embed=1`);
    const e2 = await sock(id, null, { "x-oa-embed": "1" });
    const e3 = await sock(
      id,
      null,
      { "x-oa-embed": "1" },
      `${R.events(id)}?embed=1`,
    );
    const { s: c, roster } = await rosterSeenBy(id, owner);
    expect(roster.total).toBe(1);
    expect(viewersOf(roster)).toHaveLength(1);
    for (const x of [e1, e2, e3]) {
      expect(await x.next()).toEqual({ type: "hello", version: 1 });
      expect(x.raw.filter((r) => r.includes('"presence"'))).toHaveLength(0);
      x.ws.close();
    }
    c.ws.close();
  });

  it("?ping=1 reaches the DO as X-OA-Ping; any other value is treated as not pinging", async () => {
    const pinging = async (q: string) => {
      const id = await pub({ visibility: "team" });
      const s = await sock(id, viewer, {}, `${R.events(id)}${q}`);
      await s.nextOf("presence");
      // The seat's flag is the DO's private state; the sweep alarm it arms
      // is the only other trace, and other work shares that alarm.
      const n = await runInDurableObject(
        runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
        (i: ArtifactRuntime) =>
          (
            i as unknown as {
              viewerPresenceSockets: () => { p: { ping: boolean } }[];
            }
          )
            .viewerPresenceSockets()
            .filter(({ p }) => p.ping).length,
      );
      s.ws.close();
      return n;
    };
    expect(await pinging("?ping=1")).toBe(1);
    for (const q of ["", "?ping=0", "?ping=2", "?ping=true"])
      expect(await pinging(q)).toBe(0);
  });
});

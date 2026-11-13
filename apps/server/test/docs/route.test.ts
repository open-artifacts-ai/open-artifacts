// R.doc (#1100): the doc room socket through the live-socket checks.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId, R, retryAfterFromClose } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import {
  DOC_ROLE_HEADER,
  DOC_VERSION_HEADER,
  type DocRoom,
  MAX_EDIT_SOCKETS,
} from "../../src/docs/room.js";
import { appOrigin } from "../../src/http/errors.js";
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../../src/runtime/do.js";
import { revokeUserLive } from "../../src/runtime/revoke.js";
import { publish } from "../../src/services/artifacts.js";
import { DOC_SWITCH } from "../../src/services/doc-switch.js";
import { deleteShare, putShare } from "../../src/services/shares.js";
import { getUser } from "../../src/services/users.js";
import { api, errOf, login } from "../helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let editor: U;
let viewer: U;
let teamMember: U;
let guest: U;
let ownerPat: string;
let viewerPat: string;

const savedPlan = (env as { PLAN?: string }).PLAN;
DOC_SWITCH.creation = true;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

beforeAll(async () => {
  (env as { PLAN?: string }).PLAN = "paid";
  owner = await mk("dr-owner", "member");
  editor = await mk("dr-editor", "member");
  viewer = await mk("dr-viewer", "member");
  teamMember = await mk("dr-team", "member");
  guest = await mk("dr-guest", "guest");
  ownerPat = (await createPat(env, owner.userId, "dr owner")).token;
  viewerPat = (await createPat(env, viewer.userId, "dr viewer")).token;
});
afterAll(() => {
  (env as { PLAN?: string }).PLAN = savedPlan;
  DOC_SWITCH.creation = false;
});

const mkDoc = async (visibility: "private" | "team" | "public" = "private") => {
  const r = await api(app, R.artifacts, owner.cookie, {
    method: "POST",
    body: { title: "d", format: "doc", content: "# Hi\n", visibility },
  });
  expect(r.status).toBe(201);
  const id = ((await r.json()) as { id: string }).id;
  await putShare(env, owner.member, id, {
    email: editor.email,
    role: "editor",
  });
  await putShare(env, owner.member, id, {
    email: viewer.email,
    role: "viewer",
  });
  return id;
};

type Hello = {
  type: string;
  role: string;
  reason?: string;
  bytes: number;
  cap: number;
  version: number;
};
type Sock = {
  ws: WebSocket;
  hello: Promise<Hello>;
  /** Every message in order (string or binary). */
  all: unknown[];
  closed: Promise<{ code: number; reason: string }>;
};

function wrap(ws: WebSocket): Sock {
  const all: unknown[] = [];
  let resolve: (h: Hello) => void = () => {};
  const hello = new Promise<Hello>((r) => {
    resolve = r;
  });
  ws.addEventListener("message", (e) => {
    all.push(e.data);
    if (all.length === 1 && typeof e.data === "string")
      resolve(JSON.parse(e.data) as Hello);
  });
  const closed = new Promise<{ code: number; reason: string }>((res) =>
    ws.addEventListener("close", (e) => {
      const ev = e as CloseEvent;
      res({ code: ev.code, reason: ev.reason });
    }),
  );
  ws.accept();
  return { ws, hello, all, closed };
}

let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 250) + 1}`;

async function open(
  id: string,
  auth: string | null,
  headers: Record<string, string> = {},
): Promise<Sock | Response> {
  const r = await api(app, R.doc(id), auth, {
    headers: { upgrade: "websocket", "cf-connecting-ip": ip(), ...headers },
  });
  return r.webSocket ? wrap(r.webSocket) : r;
}
async function sock(
  id: string,
  auth: string | null,
  headers: Record<string, string> = {},
): Promise<Sock> {
  const s = await open(id, auth, headers);
  if (s instanceof Response) throw new Error(`no websocket (${s.status})`);
  return s;
}

describe("roles by caller", () => {
  const cases: [string, () => string | null, "edit" | "read"][] = [
    ["owner", () => owner.cookie, "edit"],
    ["editor", () => editor.cookie, "edit"],
    ["viewer", () => viewer.cookie, "read"],
    ["owner's PAT (an agent acts as the person)", () => ownerPat, "edit"],
    ["viewer's PAT", () => viewerPat, "read"],
  ];
  for (const [name, auth, role] of cases)
    it(`${name}: ${role}`, async () => {
      const id = await mkDoc();
      const s = await sock(id, auth());
      const h = await s.hello;
      expect(h).toMatchObject({ type: "hello", role, cap: 2 * 1024 * 1024 });
      expect(h.version).toBeGreaterThanOrEqual(1);
      expect(h.bytes).toBe(0);
      // A viewer reads by access, not because the room is full.
      expect(h.reason).toBe(role === "read" ? "access" : undefined);
      s.ws.close();
    });

  it("a team member (team visibility), a guest and an anonymous caller on a public link: read", async () => {
    const team = await mkDoc("team");
    const t = await sock(team, teamMember.cookie);
    expect(await t.hello).toMatchObject({ role: "read" });
    t.ws.close();
    const pub = await mkDoc("public");
    for (const who of [guest.cookie, null]) {
      const s = await sock(pub, who);
      expect(await s.hello).toMatchObject({ role: "read", reason: "access" });
      s.ws.close();
    }
  });

  it("embed mode downgrades an owner to an anonymous reader", async () => {
    const pub = await mkDoc("public");
    const s = await sock(pub, owner.cookie, { "x-oa-embed": "1" });
    expect(await s.hello).toMatchObject({ role: "read" });
    s.ws.close();
  });

  it("the hello frame is the first frame, before any sync frame", async () => {
    const id = await mkDoc();
    const s = await sock(id, owner.cookie);
    await s.hello;
    expect(s.all[0]).toBeTypeOf("string");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.all.length).toBeGreaterThanOrEqual(2);
    expect(s.all[1]).not.toBeTypeOf("string");
    s.ws.close();
  });
});

describe("refusals", () => {
  it("no access is 404; a foreign Origin is 403", async () => {
    const id = await mkDoc();
    const stranger = await mk("dr-stranger", "member");
    expect(((await open(id, stranger.cookie)) as Response).status).toBe(404);
    expect(((await open(id, null)) as Response).status).toBe(404);
    const r = (await open(id, owner.cookie, {
      origin: "https://evil.example",
    })) as Response;
    expect(r.status).toBe(403);
    const ok = await sock(id, owner.cookie, { origin: appOrigin(env) });
    ok.ws.close();
  });

  it("a non-doc artifact is 400 with the next step", async () => {
    const a = await publish(
      env,
      owner.member,
      { title: "h", format: "html", content: "<p>1</p>" } as never,
      null,
      undefined,
      "create",
    );
    const r = (await open(a.id, owner.cookie)) as Response;
    expect(r.status).toBe(400);
    expect((await errOf(r)).message).toContain("not a doc");
  });

  it("426 without an Upgrade header", async () => {
    const id = await mkDoc();
    const r = await api(app, R.doc(id), owner.cookie);
    expect(r.status).toBe(426);
  });

  it("the docs gate off (self-host on Workers Free) refuses", async () => {
    const id = await mkDoc();
    (env as { PLAN?: string }).PLAN = "free";
    try {
      const r = (await open(id, owner.cookie)) as Response;
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("docs_need_paid");
    } finally {
      (env as { PLAN?: string }).PLAN = "paid";
    }
  });
});

describe("spoofed client headers are ignored", () => {
  it("a viewer sending the DO's trusted headers stays a read-only viewer", async () => {
    const id = await mkDoc();
    const s = await sock(id, viewer.cookie, {
      [DOC_ROLE_HEADER]: "edit",
      [ACTOR_HEADER]: "u:somebody-else",
      [AUTHZ_AT_HEADER]: "1",
      [DOC_VERSION_HEADER]: "999",
    });
    const h = await s.hello;
    expect(h.role).toBe("read");
    expect(h.version).not.toBe(999);
    const ns = env.DOC_ROOM;
    if (!ns) throw new Error("DOC_ROOM unbound");
    await runInDurableObject(
      ns.get(ns.idFromName(id)),
      (_r: DocRoom, state) => {
        const held = (t: string) => state.getWebSockets(t).length;
        expect(held("a:u:somebody-else")).toBe(0);
        expect(held(`a:u:${viewer.userId}`)).toBe(1);
        expect(held("role:edit")).toBe(0);
      },
    );
    s.ws.close();
  });
});

describe("room full, TTL, access change, delete", () => {
  const roomOf = (id: string) => {
    const ns = env.DOC_ROOM;
    if (!ns) throw new Error("DOC_ROOM unbound");
    return ns.get(ns.idFromName(id));
  };
  const direct = async (
    id: string,
    actor: string,
    role: "edit" | "read" = "edit",
  ) => {
    const res = await roomOf(id).fetch("https://room/doc", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: actor,
        [DOC_ROLE_HEADER]: role,
        [AUTHZ_AT_HEADER]: String(Date.now()),
        [DOC_VERSION_HEADER]: "3",
      },
    });
    if (res.status !== 101) throw new Error(`status ${res.status}`);
    return wrap(res.webSocket as WebSocket);
  };

  it("the 26th editor joins read-only with reason room_full", async () => {
    const id = newId();
    const socks: Sock[] = [];
    for (let i = 0; i < MAX_EDIT_SOCKETS; i++) {
      const s = await direct(id, `u:full-${i}`);
      expect(await s.hello).toMatchObject({ role: "edit", version: 3 });
      socks.push(s);
    }
    const last = await direct(id, "u:full-extra");
    expect(await last.hello).toMatchObject({
      type: "hello",
      role: "read",
      reason: "room_full",
    });
    for (const s of [...socks, last]) s.ws.close();
  });

  it("the socket TTL closes 4401 auth_expired", async () => {
    const id = newId();
    const s = await direct(id, "u:ttl-1");
    await s.hello;
    // Age the socket past its TTL, then fire the alarm.
    await runInDurableObject(roomOf(id), (_r: DocRoom, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { t: number };
        ws.serializeAttachment({ ...att, t: Date.now() - 11 * 60_000 });
      }
    });
    expect(await runDurableObjectAlarm(roomOf(id))).toBe(true);
    expect(await s.closed).toEqual({ code: 4401, reason: "auth_expired" });
  });

  it("a fresh socket is not closed by the alarm, and the alarm is armed for its TTL", async () => {
    const id = newId();
    const s = await direct(id, "u:ttl-2");
    await s.hello;
    await runInDurableObject(roomOf(id), async (_r: DocRoom, state) => {
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
    });
    await runDurableObjectAlarm(roomOf(id));
    let closed = false;
    void s.closed.then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    s.ws.close();
  });

  it("narrowing a share closes the socket 4403", async () => {
    const id = await mkDoc();
    const u = await mk("dr-narrow", "member");
    await putShare(env, owner.member, id, { email: u.email, role: "editor" });
    const s = await sock(id, u.cookie);
    expect(await s.hello).toMatchObject({ role: "edit" });
    await putShare(env, owner.member, id, { email: u.email, role: "viewer" });
    expect((await s.closed).code).toBe(4403);
    // A reconnect inside the skew window of the change is refused too, with
    // a retry hint, like the live sockets.
    const again = await sock(id, u.cookie);
    const c = await again.closed;
    expect(c.code).toBe(4403);
    expect(retryAfterFromClose(c.reason)).toBeGreaterThan(0);
  });

  it("removing a share closes the socket 4403; a reconnect is 404", async () => {
    const id = await mkDoc();
    const u = await mk("dr-remove", "member");
    await putShare(env, owner.member, id, { email: u.email, role: "viewer" });
    const s = await sock(id, u.cookie);
    await s.hello;
    await deleteShare(env, owner.member, id, u.email);
    expect((await s.closed).code).toBe(4403);
    expect(((await open(id, u.cookie)) as Response).status).toBe(404);
  });

  it("making a doc private closes an anonymous reader 4403", async () => {
    const id = await mkDoc("public");
    const s = await sock(id, null);
    await s.hello;
    const r = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { visibility: "private" },
    });
    expect(r.status).toBe(200);
    expect((await s.closed).code).toBe(4403);
  });

  it("deleting the doc closes every socket 4404 not_found", async () => {
    const id = await mkDoc();
    const a = await sock(id, owner.cookie);
    const b = await sock(id, viewer.cookie);
    await a.hello;
    await b.hello;
    const d = await api(app, R.artifact(id), owner.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    expect(await a.closed).toEqual({ code: 4404, reason: "not_found" });
    expect((await b.closed).code).toBe(4404);
  });

  it("revoking a user closes their doc sockets (presence) and no one else's", async () => {
    const id = await mkDoc();
    const u = await mk("dr-revoke", "member");
    await putShare(env, owner.member, id, { email: u.email, role: "editor" });
    const mine = await sock(id, u.cookie);
    const other = await sock(id, owner.cookie);
    await mine.hello;
    await other.hello;
    await revokeUserLive(env, u.userId, "member removed");
    expect((await mine.closed).code).toBe(4403);
    let otherClosed = false;
    void other.closed.then(() => {
      otherClosed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(otherClosed).toBe(false);
    other.ws.close();
  });

  it("a socket authorized before the last access change is refused 4403", async () => {
    const id = newId();
    await runInDurableObject(roomOf(id), (r: DocRoom) => {
      r.closeSockets("access changed");
    });
    const res = await roomOf(id).fetch("https://room/doc", {
      headers: {
        Upgrade: "websocket",
        [ACTOR_HEADER]: "u:stale-1",
        [DOC_ROLE_HEADER]: "edit",
        [AUTHZ_AT_HEADER]: String(Date.now() - 10_000),
      },
    });
    const s = wrap(res.webSocket as WebSocket);
    expect((await s.closed).code).toBe(4403);
  });
  it("anonymous and PAT callers authorized before an access change are refused 4403", async () => {
    const id = await mkDoc("public");
    await runInDurableObject(roomOf(id), (r: DocRoom) => {
      r.closeSockets("access changed");
    });
    // The route stamps authzAt = now, inside the skew window of the change.
    for (const auth of [null, ownerPat, viewerPat]) {
      const s = await sock(id, auth);
      expect((await s.closed).code).toBe(4403);
    }
  });
});

// edit_doc (#1100): agents edit a doc through its room, over MCP and REST.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { docFragment, docToYXmlFragment, markdownToDoc } from "@oa/doc-schema";
import { type Member, newId, R } from "@oa/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp } from "../../src/app.js";
import { withCap, withPlan } from "../../src/auth/authz.js";
import { createPat } from "../../src/auth/pat.js";
import {
  AUTOSAVE_IDLE_MS,
  DOC_MAX_BYTES,
  DOC_ROLE_HEADER,
  type DocRoom,
} from "../../src/docs/room.js";
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../../src/runtime/do.js";
import { publish } from "../../src/services/artifacts.js";
import { editDoc } from "../../src/services/doc-edit.js";
import { DOC_SWITCH } from "../../src/services/doc-switch.js";
import { putShare } from "../../src/services/shares.js";
import { getUser } from "../../src/services/users.js";
import { api, errOf, login } from "../helpers.js";
import { E, connect as mcpConnect, textOf, tool } from "../mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string; member: Member };
let viewer: { cookie: string; userId: string; member: Member; email: string };
let ownerPat: string;
let viewerPat: string;
let ownerPatId: string;
DOC_SWITCH.creation = true;
const savedPlan = (env as { PLAN?: string }).PLAN;
beforeAll(async () => {
  (env as { PLAN?: string }).PLAN = "paid";
  const o = await login(`ed-o-${tag}@x.com`);
  const v = await login(`ed-v-${tag}@x.com`);
  const om = await getUser(env, o.userId);
  const vm = await getUser(env, v.userId);
  if (!om || !vm) throw new Error("no user");
  owner = { ...o, member: om };
  viewer = { ...v, member: vm, email: `ed-v-${tag}@x.com` };
  const p = await createPat(env, owner.userId, "Edit Bot");
  ownerPat = p.token;
  ownerPatId = p.id;
  viewerPat = (await createPat(env, viewer.userId, "View Bot")).token;
});
afterAll(() => {
  (env as { PLAN?: string }).PLAN = savedPlan;
  DOC_SWITCH.creation = false;
});

const T0 = 1_800_000_000_000;

/** A fresh doc artifact, shared with the viewer, and its room (fake clock). */
async function fresh(content = "# Plan\n\nShip it on Friday.\n") {
  const r = await api(app, R.artifacts, owner.cookie, {
    method: "POST",
    body: { title: "Notes", format: "doc", content },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  await putShare(env, owner.member, id, {
    email: viewer.email,
    role: "viewer",
  });
  const ns = env.DOC_ROOM;
  if (!ns) throw new Error("DOC_ROOM unbound");
  const stub = ns.get(ns.idFromName(id));
  const clock = { t: T0 };
  await runInDurableObject(stub, (r: DocRoom) => {
    const x = r as unknown as { now: () => number };
    x.now = () => clock.t;
    r.budgetCap = 1_000_000;
  });
  return { id, stub, clock };
}
type Room = Awaited<ReturnType<typeof fresh>>;

interface Client {
  ws: WebSocket;
  doc: Y.Doc;
  frames: { type: string; [k: string]: unknown }[];
  until: (pred: () => boolean) => Promise<void>;
  ping: () => Promise<void>;
  closed: Promise<void>;
}

async function connect(
  room: Room,
  o: { actor?: string; role?: "edit" | "read"; name?: string } = {},
): Promise<Client> {
  const res = await room.stub.fetch("https://room/ws", {
    headers: {
      Upgrade: "websocket",
      [ACTOR_HEADER]: o.actor ?? `u:${owner.userId}`,
      [DOC_ROLE_HEADER]: o.role ?? "edit",
      [AUTHZ_AT_HEADER]: String(Date.now()),
      ...(o.name ? { "X-OA-Doc-Name": o.name } : {}),
    },
  });
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const doc = new Y.Doc();
  const frames: Client["frames"] = [];
  const checks = new Set<() => void>();
  let pongs = 0;
  let step1 = 0;
  const closed = new Promise<void>((r) =>
    ws.addEventListener("close", () => r()),
  );
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") frames.push(JSON.parse(e.data));
    else {
      const dec = decoding.createDecoder(new Uint8Array(e.data as ArrayBuffer));
      if (decoding.readVarUint(dec) === 0) {
        const sub = decoding.peekVarUint(dec);
        if (sub === 0) step1++;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, doc, "remote");
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
        if (sub === 1) pongs++;
      }
    }
    for (const c of [...checks]) c();
  });
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    ws.send(encoding.toUint8Array(enc));
  });
  const until = (pred: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (pred()) {
          checks.delete(check);
          resolve();
        }
      };
      checks.add(check);
      check();
    });
  const ping = async () => {
    const want = pongs + 1;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeSyncStep1(enc, new Y.Doc());
    ws.send(encoding.toUint8Array(enc));
    await until(() => pongs >= want);
  };
  const c = { ws, doc, frames, until, ping, closed };
  await c.until(() => step1 > 0);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
  await c.until(() => pongs >= 1);
  return c;
}

const mdOf = (c: Client) =>
  docFragment(c.doc)
    .toArray()
    .map((n) => n.toString())
    .join("");
const write = (c: Client, md: string) =>
  c.doc.transact(() => {
    const f = docFragment(c.doc);
    f.delete(0, f.length);
    docToYXmlFragment(markdownToDoc(md).doc, f);
  });
const inRoom = <T>(room: Room, f: (r: DocRoom) => T | Promise<T>) =>
  runInDurableObject(room.stub, (r: DocRoom) => f(r));
const versions = async (id: string) =>
  (
    await env.DB.prepare(
      "select version, message from versions where artifact_id = ? order by version",
    )
      .bind(id)
      .all<{ version: number; message: string | null }>()
  ).results;
const contributors = async (id: string, v: number) =>
  (
    await env.DB.prepare(
      "select kind, key, user_id, agent_name from version_contributors where artifact_id = ? and version = ? order by kind, key",
    )
      .bind(id, v)
      .all<{
        kind: string;
        key: string;
        user_id: string | null;
        agent_name: string | null;
      }>()
  ).results;
const post = (
  id: string,
  body: unknown,
  who: { cookie?: string; bearer?: string } = { bearer: ownerPat },
) =>
  api(app, R.docOps(id), who.bearer ?? who.cookie ?? null, {
    method: "POST",
    body,
  });
const REPLACE = [{ op: "replace", quote: "Friday", with: "Monday" }];

describe("applying operations", () => {
  it("applies the ops and a connected socket receives the update", async () => {
    const room = await fresh();
    const a = await connect(room);
    const r = await post(room.id, { ops: REPLACE });
    expect(r.status).toBe(200);
    const out = (await r.json()) as {
      id: string;
      version: number;
      bytes: number;
      applied: number;
    };
    expect(out).toMatchObject({ id: room.id, applied: 1 });
    expect(out.bytes).toBeGreaterThan(0);
    await a.until(() => mdOf(a).includes("Monday"));
    expect(mdOf(a)).not.toContain("Friday");
    await a.ping();
    a.ws.close();
  });

  it("works over MCP, and get_artifact reads the room's unsaved text", async () => {
    const room = await fresh();
    const c = await mcpConnect(ownerPat);
    try {
      const r = await tool(c, "edit_doc", { id: room.id, ops: REPLACE });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ id: room.id, applied: 1 });
      const g = await tool(c, "get_artifact", {
        id: room.id,
        includeContent: true,
      });
      expect(g.structuredContent?.content).toContain("Monday");
    } finally {
      await c.close();
    }
  });

  it("saves a version first when people have unsaved edits", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nShip it on Friday.\n\nPerson wrote this.\n");
    await a.ping();
    expect(await versions(room.id)).toHaveLength(1);
    const r = await post(room.id, { ops: REPLACE });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { savedVersion?: number };
    expect(out.savedVersion).toBe(2);
    expect((await versions(room.id)).map((v) => v.version)).toEqual([1, 2]);
    a.ws.close();
  });

  it("keeps a person's concurrent socket edit", async () => {
    const room = await fresh();
    const a = await connect(room);
    const b = await connect(room);
    // The person types at the end while the agent replaces a word.
    a.doc.transact(() => {
      const f = docFragment(a.doc);
      docToYXmlFragment(markdownToDoc("Typed by a person.\n").doc, f);
    });
    const r = await post(room.id, { ops: REPLACE });
    expect(r.status).toBe(200);
    await b.until(() => mdOf(b).includes("Monday"));
    await b.until(() => mdOf(b).includes("Typed by a person."));
    await a.until(() => mdOf(a).includes("Monday"));
    expect(mdOf(a)).toContain("Typed by a person.");
    a.ws.close();
    b.ws.close();
  });

  it("shows the agent as a contributor of the version that follows", async () => {
    const room = await fresh();
    const r = await post(room.id, { ops: REPLACE });
    expect(r.status).toBe(200);
    room.clock.t = T0 + AUTOSAVE_IDLE_MS + 1;
    await runDurableObjectAlarm(room.stub);
    const v = await versions(room.id);
    expect(v.length).toBe(2);
    expect(await contributors(room.id, 2)).toEqual([
      {
        kind: "agent",
        key: `agent:t:${ownerPatId}`,
        user_id: owner.userId,
        agent_name: "Edit Bot",
      },
    ]);
  });
});

describe("refusals apply nothing", () => {
  it("an invalid anchor: 400 with the reason", async () => {
    const room = await fresh();
    const a = await connect(room);
    const r = await post(room.id, {
      ops: [
        { op: "replace", quote: "Friday", with: "Monday" },
        { op: "replace", quote: "no such text", with: "x" },
      ],
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.details).toMatchObject({
      reason: "quote_not_found",
      opIndex: 1,
    });
    await a.ping();
    expect(mdOf(a)).toContain("Friday");
    const md = await inRoom(room, (x) => x.markdown());
    expect(md).toContain("Friday");
    expect(md).not.toContain("Monday");
    a.ws.close();
  });

  it("over the 2 MB cap: too_large doc_too_large, doc unchanged", async () => {
    const room = await fresh();
    const big = "word ".repeat(DOC_MAX_BYTES / 4);
    const r = await post(room.id, {
      ops: [{ op: "insert", at: "end", markdown: big }],
    });
    expect(r.status).toBe(413);
    const e = await errOf(r);
    expect(e.details).toMatchObject({ reason: "doc_too_large" });
    expect(await inRoom(room, (x) => x.markdown())).not.toContain("word word");
  });

  it("a stale expectedVersion: 409 version_conflict", async () => {
    const room = await fresh();
    const r = await post(room.id, { ops: REPLACE, expectedVersion: 7 });
    expect(r.status).toBe(409);
    expect(await inRoom(room, (x) => x.markdown())).toContain("Friday");
  });

  it("a viewer (token and session) is refused", async () => {
    const room = await fresh();
    for (const who of [{ bearer: viewerPat }, { cookie: viewer.cookie }]) {
      const r = await post(room.id, { ops: REPLACE }, who);
      expect(r.status).toBe(404);
    }
    const c = await mcpConnect(viewerPat);
    try {
      const r = await tool(c, "edit_doc", { id: room.id, ops: REPLACE });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^not_found/);
    } finally {
      await c.close();
    }
    expect(await inRoom(room, (x) => x.markdown())).toContain("Friday");
  });

  it("a capped token (restricted or guest) is refused", async () => {
    const room = await fresh();
    for (const cap of ["restricted", "guest"] as const) {
      await expect(
        editDoc(env, withCap({ ...owner.member }, cap), null, room.id, {
          ops: REPLACE,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await inRoom(room, (x) => x.markdown())).toContain("Friday");
  });

  it("a plan lock refuses", async () => {
    const room = await fresh();
    const locked = withPlan({ ...owner.member }, {
      status: "suspended",
      lock: { mode: "viewOnly" },
    } as never);
    await expect(
      editDoc(env, locked, null, room.id, { ops: REPLACE }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^plan_/) });
    expect(await inRoom(room, (x) => x.markdown())).toContain("Friday");
  });

  it("a non-doc is refused with 400", async () => {
    const p = await publish(
      env,
      owner.member,
      { title: "Page", format: "markdown", content: "# Hi\n" },
      null,
    );
    const r = await post(p.id, { ops: REPLACE });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ reason: "not_a_doc" });
  });

  it("a malformed body is a 400", async () => {
    const room = await fresh();
    expect((await post(room.id, { ops: [] })).status).toBe(400);
    expect((await post(room.id, { nope: 1 })).status).toBe(400);
  });
});

describe("availability", () => {
  it("the tool is hidden when docs are unavailable, offered when they are", async () => {
    const on = await mcpConnect(ownerPat);
    try {
      const names = (await on.listTools()).tools.map((t) => t.name);
      expect(names).toContain("edit_doc");
    } finally {
      await on.close();
    }
    const off = await mcpConnect(ownerPat, { env: E({ PLAN: "free" }) });
    try {
      const names = (await off.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("edit_doc");
    } finally {
      await off.close();
    }
  });
});

describe("how a version was saved (docSave)", () => {
  const list = async (id: string) =>
    (await (await api(app, R.versions(id), owner.cookie)).json()) as {
      version: number;
      docSave?: { kind: string; by?: { name?: string; id?: string } };
    }[];
  const byV = (l: Awaited<ReturnType<typeof list>>, v: number) =>
    l.find((x) => x.version === v)?.docSave;

  it("records before_agent (by the agent), auto, named and restore", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nShip it on Friday.\n\nPerson wrote this.\n");
    await a.ping();
    // v2: people's edits saved before the agent edits.
    expect((await post(room.id, { ops: REPLACE })).status).toBe(200);
    // v3: the agent's edit, saved by the idle autosave.
    room.clock.t = T0 + AUTOSAVE_IDLE_MS + 1;
    await runDurableObjectAlarm(room.stub);
    // v4: named.
    await inRoom(room, (r) =>
      r.saveVersion({
        name: "Milestone",
        by: { kind: "person", key: owner.userId, userId: owner.userId },
      }),
    );
    // v5: restore of v1.
    await inRoom(room, (r) =>
      r.restore({
        version: 1,
        by: { kind: "person", key: owner.userId, userId: owner.userId },
      }),
    );
    const l = await list(room.id);
    expect(byV(l, 1)).toBeUndefined();
    expect(byV(l, 2)).toMatchObject({
      kind: "before_agent",
      by: { name: "Edit Bot" },
    });
    expect(byV(l, 3)?.kind).toBe("auto");
    expect(byV(l, 4)).toMatchObject({
      kind: "named",
      by: { id: owner.userId },
    });
    expect(byV(l, 5)).toMatchObject({
      kind: "restore",
      by: { id: owner.userId },
    });
    a.ws.close();
    // MCP list_versions returns it too.
    const c = await mcpConnect(ownerPat);
    try {
      const r = await tool(c, "list_versions", { id: room.id });
      const items = (r.structuredContent?.items ?? []) as {
        version: number;
        docSave?: { kind: string };
      }[];
      expect(items.find((x) => x.version === 2)?.docSave?.kind).toBe(
        "before_agent",
      );
    } finally {
      await c.close();
    }
  });

  it("is absent for a version of a non-doc", async () => {
    const p = await publish(
      env,
      owner.member,
      { title: "Page", format: "markdown", content: "# Hi\n" },
      null,
    );
    const l = await list(p.id);
    expect(l[0]?.docSave).toBeUndefined();
  });
});

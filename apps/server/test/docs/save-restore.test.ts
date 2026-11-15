// Save a named version and restore, through the room (#2496, #2140).
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
import {
  restoreDocVersion,
  saveDocVersion,
} from "../../src/services/doc-edit.js";
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

const post = (
  id: string,
  path: string,
  body: unknown,
  who: { cookie?: string; bearer?: string } = { cookie: owner.cookie },
) =>
  api(app, `${R.artifact(id)}${path}`, who.bearer ?? who.cookie ?? null, {
    method: "POST",
    body,
  });

describe("save a named version", () => {
  it("with a name, and without (Version n)", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nNew text.\n");
    await a.ping();
    const r = await post(room.id, "/doc/versions", { name: "Draft one" });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ version: 2 });
    write(a, "# Plan\n\nMore text.\n");
    await a.ping();
    const r2 = await post(room.id, "/doc/versions", {});
    expect(await r2.json()).toEqual({ version: 3 });
    expect((await versions(room.id)).map((v) => v.message)).toEqual([
      null,
      "Draft one",
      "Version 3",
    ]);
    const row = await env.DB.prepare(
      "select doc_save from versions where artifact_id = ? and version = 2",
    )
      .bind(room.id)
      .first<{ doc_save: string }>();
    expect(JSON.parse(row?.doc_save ?? "{}").kind).toBe("named");
    a.ws.close();
  });

  it("refuses an empty name", async () => {
    const room = await fresh();
    expect((await post(room.id, "/doc/versions", { name: "  " })).status).toBe(
      400,
    );
  });
});

describe("restore", () => {
  it("reaches a connected socket live, as Restored v1", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nChanged.\n");
    await a.ping();
    await post(room.id, "/doc/versions", { name: "Changed" }); // v2
    const r = await post(room.id, "/doc/versions/1/restore", {});
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ version: 3 });
    await a.until(() => mdOf(a).includes("Friday"));
    expect(mdOf(a)).not.toContain("Changed");
    const vs = await versions(room.id);
    expect(vs.at(-1)).toMatchObject({ version: 3, message: "Restored v1" });
    a.ws.close();
  });

  it("saves unsaved edits as an automatic version first", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nUnsaved words.\n");
    await a.ping();
    const r = await post(room.id, "/doc/versions/1/restore", {});
    expect(await r.json()).toEqual({ version: 3 });
    const vs = await versions(room.id);
    expect(vs.map((v) => v.message)).toEqual([null, null, "Restored v1"]);
    const v2 = await env.DB.prepare(
      "select doc_save from versions where artifact_id = ? and version = 2",
    )
      .bind(room.id)
      .first<{ doc_save: string }>();
    expect(JSON.parse(v2?.doc_save ?? "{}").kind).toBe("auto");
    a.ws.close();
  });

  it("restores a publish-created v1 from doc.md", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nEdited.\n");
    await a.ping();
    // Publish-created: its manifest has doc.md only.
    const v1 = await env.DB.prepare(
      "select manifest from versions where artifact_id = ? and version = 1",
    )
      .bind(room.id)
      .first<{ manifest: string }>();
    const files = (
      JSON.parse(v1?.manifest ?? "[]") as { path: string }[]
    ).filter((f) => f.path !== "doc.json" && f.path !== "doc.yjs");
    await env.DB.prepare(
      "update versions set manifest = ? where artifact_id = ? and version = 1",
    )
      .bind(JSON.stringify(files), room.id)
      .run();
    const r = await post(room.id, "/doc/versions/1/restore", {});
    expect(r.status).toBe(201);
    await a.until(() => mdOf(a).includes("Friday"));
    a.ws.close();
  });

  it("an unknown version is 404", async () => {
    const room = await fresh();
    expect((await post(room.id, "/doc/versions/9/restore", {})).status).toBe(
      404,
    );
  });

  it("restore_version on a doc goes through the room (MCP and REST)", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Plan\n\nChanged.\n");
    await a.ping();
    const c = await mcpConnect(ownerPat);
    try {
      const r = await tool(c, "restore_version", { id: room.id, version: 1 });
      expect(r.isError).toBeFalsy();
    } finally {
      await c.close();
    }
    await a.until(() => mdOf(a).includes("Friday"));
    const rest = await api(app, R.restoreVersion(room.id, 1), owner.cookie, {
      method: "POST",
      body: {},
    });
    expect(rest.status).toBe(201);
    const msgs = (await versions(room.id)).map((v) => v.message);
    expect(msgs.filter((m) => m === "Restored v1")).toHaveLength(2);
    a.ws.close();
  });
});

describe("access", () => {
  it("a viewer (session and token) is refused", async () => {
    const room = await fresh();
    for (const who of [{ bearer: viewerPat }, { cookie: viewer.cookie }]) {
      expect((await post(room.id, "/doc/versions", {}, who)).status).toBe(404);
      expect(
        (await post(room.id, "/doc/versions/1/restore", {}, who)).status,
      ).toBe(404);
    }
    expect(await versions(room.id)).toHaveLength(1);
  });

  it("a capped token is refused", async () => {
    const room = await fresh();
    for (const cap of ["restricted", "guest"] as const) {
      const m = withCap({ ...owner.member }, cap);
      await expect(
        saveDocVersion(env, m, null, room.id, {}),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        restoreDocVersion(env, m, null, room.id, 1),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await versions(room.id)).toHaveLength(1);
  });

  it("a plan lock refuses", async () => {
    const room = await fresh();
    const locked = withPlan({ ...owner.member }, {
      status: "suspended",
      lock: { mode: "viewOnly" },
    } as never);
    await expect(
      saveDocVersion(env, locked, null, room.id, {}),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^plan_/) });
    await expect(
      restoreDocVersion(env, locked, null, room.id, 1),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^plan_/) });
    expect(await versions(room.id)).toHaveLength(1);
  });

  it("a non-doc is refused with 400", async () => {
    const p = await publish(
      env,
      owner.member,
      { title: "Page", format: "markdown", content: "# Hi\n" },
      null,
    );
    for (const path of ["/doc/versions", "/doc/versions/1/restore"]) {
      const r = await post(p.id, path, {});
      expect(r.status).toBe(400);
      expect((await errOf(r)).details).toMatchObject({ reason: "not_a_doc" });
    }
  });
});

describe("rate and size (#2591)", () => {
  const postV = (path: string, bearer = ownerPat) =>
    api(app, path, bearer, { method: "POST", body: {} });

  it("save and restore share edit_doc's per-actor limit", async () => {
    const room = await fresh();
    // Unknown versions are 404 but still count against the limit.
    for (let i = 0; i < 100; i++) {
      const r = await postV(R.docRestore(room.id, 99));
      expect(r.status).toBe(404);
    }
    const over = await postV(R.docRestore(room.id, 99));
    expect(over.status).toBe(429);
    expect((await errOf(over)).code).toBe("rate_limited");
    // A save is over the same limit, and so is edit_doc.
    expect((await postV(R.docSaveVersion(room.id))).status).toBe(429);
    const e = await api(app, R.docOps(room.id), ownerPat, {
      method: "POST",
      body: { ops: [{ op: "delete", quote: "none" }] },
    });
    expect(e.status).toBe(429);
    // The next minute starts again.
    room.clock.t = T0 + 61_000;
    expect((await postV(R.docRestore(room.id, 99))).status).toBe(404);
  });

  it("repeated restores do not fill the cap; the doc stays editable", async () => {
    const para = (i: number) =>
      `Paragraph ${i}: ${"lorem ipsum dolor sit amet ".repeat(8)}\n\n`;
    const content = Array.from({ length: 1100 }, (_, i) => para(i)).join("");
    const room = await fresh(`# Big\n\n${content}`);
    const a = await connect(room);
    await a.until(() => mdOf(a).includes("Paragraph 1099"));
    for (let i = 0; i < 12; i++) {
      const r = await postV(R.docRestore(room.id, 1));
      expect(r.status, `restore ${i}`).toBe(201);
      room.clock.t += 1_000;
    }
    const size = await inRoom(room, (x) => x.size());
    expect(size).toBeLessThan(DOC_MAX_BYTES);
    // Still editable: a socket edit lands and an edit_doc call applies.
    write(a, `# Big\n\n${content}Typed after restores.\n`);
    await a.ping();
    expect(a.frames.some((f) => f.code === "doc_too_large")).toBe(false);
    const e = await api(app, R.docOps(room.id), ownerPat, {
      method: "POST",
      body: { ops: [{ op: "replace", quote: "Paragraph 0:", with: "First:" }] },
    });
    expect(e.status).toBe(200);
    a.ws.close();
  });
});

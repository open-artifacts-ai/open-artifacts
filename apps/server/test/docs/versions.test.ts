// Doc versions from the room (#1100 step 6): automatic saves (2-minute pause,
// 30 minutes, last editor leaves, before an agent edit), named saves,
// R2-then-row ordering, contributors, restore, frames. Fake clock, no sleeps.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { docFragment, docToYXmlFragment, markdownToDoc } from "@oa/doc-schema";
import { newId, R } from "@oa/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { createApp } from "../../src/app.js";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_MS,
  DOC_ROLE_HEADER,
  type DocRoom,
  SAVE_RETRY_MS,
} from "../../src/docs/room.js";
import { ACTOR_HEADER, AUTHZ_AT_HEADER } from "../../src/runtime/do.js";
import { DOC_SWITCH } from "../../src/services/doc-switch.js";
import { api, login, runIndex } from "../helpers.js";

const app = createApp();
let owner: { cookie: string; userId: string };
let other: { cookie: string; userId: string };
DOC_SWITCH.creation = true;
const savedPlan = (env as { PLAN?: string }).PLAN;
beforeAll(async () => {
  (env as { PLAN?: string }).PLAN = "paid";
  owner = await login(`ver-${newId().slice(0, 6).toLowerCase()}@x.com`);
  other = await login(`ver2-${newId().slice(0, 6).toLowerCase()}@x.com`);
});
afterAll(() => {
  (env as { PLAN?: string }).PLAN = savedPlan;
  DOC_SWITCH.creation = false;
});

const T0 = 1_800_000_000_000;

/** A fresh doc artifact (version 1) and its room, with a fake clock at T0. */
async function fresh() {
  const r = await api(app, R.artifacts, owner.cookie, {
    method: "POST",
    body: { title: "Notes", format: "doc", content: "# Start\n" },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
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

/** Replaces the client's doc content with Markdown (one transaction). */
const write = (c: Client, md: string) =>
  c.doc.transact(() => {
    const f = docFragment(c.doc);
    f.delete(0, f.length);
    docToYXmlFragment(markdownToDoc(md).doc, f);
  });
const mdOf = (c: Client) => {
  const f = docFragment(c.doc);
  return f
    .toArray()
    .map((n) => n.toString())
    .join("");
};

const versions = async (id: string) =>
  (
    await env.DB.prepare(
      "select version, message, agent_name, created_by from versions where artifact_id = ? order by version",
    )
      .bind(id)
      .all<{
        version: number;
        message: string | null;
        agent_name: string | null;
        created_by: string;
      }>()
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
const r2Count = async (id: string) =>
  (await env.FILES.list({ prefix: `files/${id}/` })).objects.length;
const fileText = async (id: string, v: number, path: string) => {
  const row = await env.DB.prepare(
    "select manifest from versions where artifact_id = ? and version = ?",
  )
    .bind(id, v)
    .first<{ manifest: string }>();
  const f = (
    JSON.parse(row?.manifest ?? "[]") as { path: string; key: string }[]
  ).find((e) => e.path === path);
  return f ? await (await env.FILES.get(f.key))?.text() : undefined;
};
const inRoom = <T>(room: Room, f: (r: DocRoom) => T | Promise<T>) =>
  runInDurableObject(room.stub, (r: DocRoom) => f(r));
const tick = async (room: Room, to: number) => {
  room.clock.t = to;
  await runDurableObjectAlarm(room.stub);
};
const last = (c: Client, type: string) =>
  [...c.frames].reverse().find((f) => f.type === type);

describe("automatic saves", () => {
  it("saves after a 2-minute pause, not before", async () => {
    const room = await fresh();
    const a = await connect(room);
    const watch = await connect(room, { role: "read", actor: "u:watcher" });
    write(a, "# Hello\n\nworld\n");
    await a.ping();
    await tick(room, T0 + 1_000); // flush; not due
    expect((await versions(room.id)).length).toBe(1);
    await tick(room, T0 + AUTOSAVE_IDLE_MS - 1);
    expect((await versions(room.id)).length).toBe(1);
    await tick(room, T0 + AUTOSAVE_IDLE_MS);
    const vs = await versions(room.id);
    expect(vs.map((v) => v.version)).toEqual([1, 2]);
    expect(vs[1]?.message).toBeNull();
    expect(vs[1]?.created_by).toBe(owner.userId);
    await watch.until(() => last(watch, "saved") !== undefined);
    expect(last(watch, "saved")).toEqual({
      type: "saved",
      version: 2,
      auto: true,
      by: { kind: "person", name: null },
    });
    // Four files, R2 first; doc.md is the entry.
    expect(await fileText(room.id, 2, "doc.md")).toContain("# Hello");
    expect(await fileText(room.id, 2, "index.html")).toContain(
      "<h1>Hello</h1>",
    );
    expect(
      JSON.parse((await fileText(room.id, 2, "doc.json")) ?? "{}").type,
    ).toBe("doc");
    expect(await fileText(room.id, 2, "doc.yjs")).toBeTruthy();
    expect(await contributors(room.id, 2)).toEqual([
      {
        kind: "person",
        key: owner.userId,
        user_id: owner.userId,
        agent_name: null,
      },
    ]);
    // Compacted; nothing unsaved: the next tick saves nothing.
    await tick(room, T0 + AUTOSAVE_IDLE_MS * 3);
    expect((await versions(room.id)).length).toBe(2);
  });

  it("saves at least every 30 minutes while editing continues", async () => {
    const room = await fresh();
    const a = await connect(room);
    let t = T0;
    let n = 0;
    // An edit every 90 s: never a 2-minute pause.
    while (t + 90_000 < T0 + AUTOSAVE_MAX_MS) {
      t += 90_000;
      room.clock.t = t;
      write(a, `# Edit ${++n}\n`);
      await a.ping();
      await tick(room, t + 1_000);
      expect((await versions(room.id)).length).toBe(1);
    }
    // The 30 minutes run from the first unsaved edit (at T0 + 90 s).
    await tick(room, T0 + 90_000 + AUTOSAVE_MAX_MS);
    expect((await versions(room.id)).length).toBe(2);
  });

  it("saves when the last editor socket closes, not the first", async () => {
    const room = await fresh();
    const a = await connect(room, { actor: `u:${owner.userId}` });
    const b = await connect(room, { actor: `u:${other.userId}` });
    const watch = await connect(room, { role: "read", actor: "u:watcher" });
    write(a, "# By A\n");
    await a.ping();
    a.ws.close(1000);
    await a.closed;
    await watch.ping();
    expect((await versions(room.id)).length).toBe(1);
    write(b, "# By A and B\n");
    await b.ping();
    b.ws.close(1000);
    await watch.until(() => last(watch, "saved") !== undefined);
    expect((await versions(room.id)).length).toBe(2);
    const keys = (await contributors(room.id, 2)).map((c) => c.key).sort();
    expect(keys).toEqual([owner.userId, other.userId].sort());
  });

  it("before an agent edit, saves only if people edited since the last version", async () => {
    const room = await fresh();
    const agent = {
      kind: "agent" as const,
      key: "tok1",
      userId: owner.userId,
      agentName: "Claude",
    };
    // Only an agent edited: nothing to save.
    await inRoom(room, (r) => r.noteEdit(agent));
    expect(await inRoom(room, (r) => r.saveBeforeAgentEdit())).toBeNull();
    const a = await connect(room);
    write(a, "# Person typed\n");
    await a.ping();
    const saved = await inRoom(room, (r) => r.saveBeforeAgentEdit());
    expect(saved).toEqual({ version: 2 });
    expect(await inRoom(room, (r) => r.saveBeforeAgentEdit())).toBeNull();
    expect((await versions(room.id)).length).toBe(2);
  });
});

describe("named saves and contributors", () => {
  it("saveVersion names the version and broadcasts it", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Draft\n");
    await a.ping();
    const r = await inRoom(room, (x) =>
      x.saveVersion({
        name: "Sent to legal",
        by: { kind: "person", key: owner.userId, userId: owner.userId },
      }),
    );
    expect(r).toEqual({ version: 2 });
    expect((await versions(room.id))[1]?.message).toBe("Sent to legal");
    await a.until(() => last(a, "saved") !== undefined);
    expect(last(a, "saved")).toEqual({
      type: "saved",
      version: 2,
      name: "Sent to legal",
      auto: false,
      by: { kind: "person", name: null },
    });
    await expect(
      inRoom(room, (x) =>
        x.saveVersion({ name: "  ", by: { kind: "person", key: "k" } }),
      ),
    ).rejects.toThrow();
  });

  it("records people and agents since the last version, then clears them", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# One\n");
    await a.ping();
    await inRoom(room, (r) =>
      r.noteEdit({
        kind: "agent",
        key: "tok1",
        userId: owner.userId,
        agentName: "Claude",
        agentVersion: "2.1",
      }),
    );
    const anon = await connect(room, { actor: "ip:1.2.3.4" });
    write(anon, "# One\n\nanon\n");
    await anon.ping();
    await inRoom(room, (r) =>
      r.saveVersion({
        name: "v",
        by: {
          kind: "agent",
          key: "tok1",
          userId: owner.userId,
          agentName: "Claude",
          agentVersion: "2.1",
        },
      }),
    );
    const got = await contributors(room.id, 2);
    expect(got).toHaveLength(3);
    expect(got).toEqual(
      expect.arrayContaining([
        {
          kind: "agent",
          key: "tok1",
          user_id: owner.userId,
          agent_name: "Claude",
        },
        { kind: "person", key: "anon", user_id: null, agent_name: null },
        {
          kind: "person",
          key: owner.userId,
          user_id: owner.userId,
          agent_name: null,
        },
      ]),
    );
    expect((await versions(room.id))[1]?.agent_name).toBe("Claude");
    // The next version only has who edited after it.
    write(a, "# Two\n");
    await a.ping();
    await inRoom(room, (r) =>
      r.saveVersion({
        name: "w",
        by: { kind: "person", key: owner.userId, userId: owner.userId },
      }),
    );
    expect((await contributors(room.id, 3)).map((c) => c.key)).toEqual([
      owner.userId,
    ]);
  });

  it("indexes the snapshot's text for search", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Quokka\n\nzebrafinch rhapsody\n");
    await a.ping();
    await inRoom(room, (r) =>
      r.saveVersion({
        name: "s",
        by: { kind: "person", key: owner.userId, userId: owner.userId },
      }),
    );
    expect(await runIndex(room.id)).toBe(true);
    const row = await env.DB.prepare(
      "select body from artifact_search where artifact_id = ?",
    )
      .bind(room.id)
      .first<{ body: string }>();
    expect(row?.body).toContain("zebrafinch rhapsody");
  });
});

describe("R2 first, then the row", () => {
  const failing = (room: Room, what: "put" | "batch", log: string[]) =>
    inRoom(room, (r) => {
      const real = (r as unknown as { env: typeof env }).env;
      const FILES = new Proxy(real.FILES, {
        get(t, p) {
          const v = Reflect.get(t, p) as (...a: unknown[]) => unknown;
          if (p === "put")
            return (...a: unknown[]) => {
              log.push("put");
              return what === "put" &&
                log.filter((l) => l === "put").length === 3
                ? Promise.reject(new Error("r2 down"))
                : v.apply(t, a);
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      const DB = new Proxy(real.DB, {
        get(t, p) {
          const v = Reflect.get(t, p) as (...a: unknown[]) => unknown;
          if (p === "batch")
            return (...a: unknown[]) => {
              log.push("batch");
              return what === "batch"
                ? Promise.reject(new Error("d1 down"))
                : v.apply(t, a);
            };
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      (r as unknown as { env: object }).env = Object.create(real, {
        FILES: { value: FILES },
        DB: { value: DB },
      });
      (r as unknown as { realEnv: unknown }).realEnv = real;
    });
  const heal = (room: Room) =>
    inRoom(room, (r) => {
      (r as unknown as { env: unknown }).env = (
        r as unknown as { realEnv: unknown }
      ).realEnv;
    });

  it("an R2 failure writes no version row, leaves no files, and the retry succeeds", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Keep me\n");
    await a.ping();
    const before = await r2Count(room.id);
    const log: string[] = [];
    await failing(room, "put", log);
    room.clock.t = T0 + AUTOSAVE_IDLE_MS;
    await expect(
      inRoom(room, (r) =>
        r.saveVersion({
          name: "x",
          by: { kind: "person", key: owner.userId, userId: owner.userId },
        }),
      ),
    ).rejects.toThrow();
    expect(log).not.toContain("batch");
    expect((await versions(room.id)).length).toBe(1);
    expect(await r2Count(room.id)).toBe(before);
    // The edits are still in the room; an automatic retry waits SAVE_RETRY_MS.
    await heal(room);
    await tick(room, T0 + AUTOSAVE_IDLE_MS + SAVE_RETRY_MS - 1);
    expect((await versions(room.id)).length).toBe(1);
    await tick(room, T0 + AUTOSAVE_IDLE_MS + SAVE_RETRY_MS);
    expect((await versions(room.id)).length).toBe(2);
    expect(await fileText(room.id, 2, "doc.md")).toContain("# Keep me");
    expect((await contributors(room.id, 2)).length).toBe(1);
  });

  it("a D1 failure after the files cleans them up; no row; the retry succeeds", async () => {
    const room = await fresh();
    const a = await connect(room);
    write(a, "# Keep me too\n");
    await a.ping();
    const before = await r2Count(room.id);
    const log: string[] = [];
    await failing(room, "batch", log);
    await expect(
      inRoom(room, (r) =>
        r.saveVersion({
          name: "x",
          by: { kind: "person", key: owner.userId, userId: owner.userId },
        }),
      ),
    ).rejects.toThrow();
    // All four files were written before the single batch.
    expect(log).toEqual(["put", "put", "put", "put", "batch"]);
    expect((await versions(room.id)).length).toBe(1);
    expect(await r2Count(room.id)).toBe(before);
    await heal(room);
    await tick(room, T0 + SAVE_RETRY_MS + AUTOSAVE_IDLE_MS);
    expect((await versions(room.id)).length).toBe(2);
  });
});

describe("frames", () => {
  it("name an agent actor", async () => {
    const room = await fresh();
    const a = await connect(room);
    await inRoom(room, (r) =>
      r.saveVersion({
        name: "By agent",
        by: {
          kind: "agent",
          key: "tok1",
          userId: owner.userId,
          agentName: "Claude",
        },
      }),
    );
    await a.until(() => last(a, "saved") !== undefined);
    expect(last(a, "saved")).toEqual({
      type: "saved",
      version: 2,
      name: "By agent",
      auto: false,
      by: { kind: "agent", name: "Claude" },
    });
  });
});

describe("restore", () => {
  it("saves unsaved edits, replaces the content live, saves 'Restored vN'", async () => {
    const room = await fresh();
    const a = await connect(room);
    const b = await connect(room, { actor: `u:${other.userId}` });
    write(a, "# First draft\n");
    await a.ping();
    const by = {
      kind: "person" as const,
      key: owner.userId,
      userId: owner.userId,
    };
    await inRoom(room, (r) => r.saveVersion({ name: "draft", by })); // v2
    write(a, "# Second draft\n");
    await a.ping();
    await b.until(() => mdOf(b).includes("Second"));
    const r = await inRoom(room, (x) => x.restore({ version: 2, by }));
    expect(r).toEqual({ version: 4 }); // v3: the unsaved edits, v4: the restore
    const vs = await versions(room.id);
    expect(vs.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(vs[3]?.message).toBe("Restored v2");
    expect(await fileText(room.id, 3, "doc.md")).toContain("Second draft");
    expect(await fileText(room.id, 4, "doc.md")).toContain("First draft");
    // A live edit everyone sees; the frame names both versions.
    await b.until(() => mdOf(b).includes("First draft"));
    expect(mdOf(b)).not.toContain("Second");
    await b.until(() => last(b, "restored") !== undefined);
    expect(last(b, "restored")).toEqual({
      type: "restored",
      from: 2,
      version: 4,
      by: { kind: "person", name: null },
    });
    // Older versions are untouched.
    expect(await fileText(room.id, 2, "doc.md")).toContain("First draft");
    await expect(
      inRoom(room, (x) => x.restore({ version: 99, by })),
    ).rejects.toThrow();
  });
});

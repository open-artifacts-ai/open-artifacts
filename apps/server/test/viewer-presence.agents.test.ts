// Viewer presence, Task 6: AI agents on the roster. MCP and REST calls that
// reach the artifact's DO record the agent there; an agent read makes the
// one extra fire-and-forget DO call (touchViewerAgent).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  AGENT_PRESENT_MS,
  type Member,
  newId,
  type PresenceEntry,
  type PresenceFrame,
  PresenceFrameSchema,
  R,
} from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { ArtifactRuntime } from "../src/runtime/do.js";
import * as agentModule from "../src/runtime/viewer-presence-agent.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import {
  callWorker,
  connect,
  MCP_URL,
  oauthToken,
  type ToolResult,
  tool,
} from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
/** Far ahead of the wall clock: alarms armed on this clock never fire alone. */
const BASE = Date.now() + 30 * 86_400_000;
const LABEL = "label-7f3c secret";
const PRODUCT = "Claude Code";

type U = { cookie: string; userId: string; member: Member; email: string };
let alice: U & { grant: string };
let bob: U;
let guest: U;
let alicePat: string;
let alicePatId: string;

const member = async (l: { cookie: string; userId: string }, email: string) => {
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
};
async function mk(prefix: string, role: Member["role"] = "member") {
  const email = `${prefix}-${tag}@x.com`;
  return member(await login(email, role), email);
}
const setName = (userId: string, name: string) =>
  env.DB.prepare("update users set display_name = ? where id = ?")
    .bind(name, userId)
    .run();

const pub = async (owner: U, extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "agents",
        format: "html",
        content: "<p>1</p>",
        visibility: "public",
        capabilities: { db: true, viewer: false, storage: false },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

type Sock = {
  ws: WebSocket;
  raw: string[];
  presence: PresenceFrame[];
  /** The first presence frame from index `after` on (here or later) passing `ok`. */
  until: (
    ok: (f: PresenceFrame) => boolean,
    after?: number,
  ) => Promise<PresenceFrame>;
};

function wrap(ws: WebSocket): Sock {
  const raw: string[] = [];
  const presence: PresenceFrame[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    const text = String((e as MessageEvent).data);
    raw.push(text);
    const j = JSON.parse(text);
    if (j.type === "presence") presence.push(PresenceFrameSchema.parse(j));
    for (const w of waiters.splice(0)) w();
  });
  ws.accept();
  return {
    ws,
    raw,
    presence,
    until: (ok, after = 0) =>
      new Promise((res, rej) => {
        const timer = setTimeout(
          () => rej(new Error(`no matching frame: ${raw.join("\n")}`)),
          8_000,
        );
        const check = () => {
          const f = presence.slice(after).find(ok);
          if (f) {
            clearTimeout(timer);
            res(f);
          } else waiters.push(check);
        };
        check();
      }),
  };
}

let ipSeq = 0;
async function sock(id: string, u: U | null, path = R.events(id)) {
  const r = await api(app, path, u?.cookie ?? null, {
    headers: {
      upgrade: "websocket",
      "cf-connecting-ip": `198.51.100.${(++ipSeq % 250) + 1}`,
    },
  });
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  return wrap(r.webSocket);
}

const agents = (f: PresenceFrame) =>
  f.viewers.filter((v) => v.kind === "agent");
const hasAgents = (n: number) => (f: PresenceFrame) => agents(f).length === n;
const lastOf = (s: Sock) => s.presence.at(-1) as PresenceFrame;

const ok = (r: ToolResult) => {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r;
};

const stubOf = (id: string) =>
  env.ARTIFACT_RUNTIME.get(
    env.ARTIFACT_RUNTIME.idFromName(id),
  ) as unknown as DurableObjectStub<ArtifactRuntime>;
const agentRows = (id: string) =>
  runInDurableObject(stubOf(id), (_i, s) =>
    s.storage.sql
      .exec<{ n: number }>("select count(*) as n from viewer_presence_agent")
      .one(),
  ).then((r) => r.n);

const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
/** A raw tools/call with no Mcp-Session-Id. */
const rawCall = async (
  token: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const r = await callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: { ...H, authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).toContain('"result"');
  expect(text).not.toContain('"isError":true');
};

beforeAll(async () => {
  const email = `vpa-alice-${tag}@x.com`;
  const o = await oauthToken(email, PRODUCT);
  await setName(o.member.userId, "Alice Owner");
  alice = { ...(await member(o.member, email)), grant: o.accessToken };
  bob = await mk("vpa-bob");
  await setName(bob.userId, "Bob Viewer");
  bob = await member(bob, bob.email);
  guest = await mk("vpa-guest", "guest");
  const p = await createPat(env, alice.userId, LABEL);
  alicePat = p.token;
  alicePatId = p.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agents on the presence roster", () => {
  it('an MCP get_artifact puts the agent on an open viewer\'s roster as "<product>", owner name, Viewing', async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const later = vi.spyOn(agentModule, "touchViewerAgentLater");
    const c = await connect(alice.grant);
    ok(await tool(c, "get_artifact", { id, activity: "reading the page" }));
    expect(later).toHaveBeenCalledTimes(1);
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]).toMatchObject({
      kind: "agent",
      name: PRODUCT,
      named: true,
      agent: {
        owner: "Alice Owner",
        product: PRODUCT,
        state: "viewing",
        activity: "reading the page",
      },
    });
    expect(agents(f)[0]?.agent).not.toHaveProperty("label");
    await c.close();
    b.ws.close();
  });

  it("a publish through MCP makes it Editing with the change note as activity", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const later = vi.spyOn(agentModule, "touchViewerAgentLater");
    const c = await connect(alice.grant);
    ok(
      await tool(c, "publish_artifact", {
        id,
        format: "html",
        content: "<p>2</p>",
        message: "fixing the header",
      }),
    );
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.agent).toMatchObject({
      state: "editing",
      activity: "fixing the header",
    });
    // The touch rode scheduleIndex: no extra DO call.
    expect(later).not.toHaveBeenCalled();
    await c.close();
    b.ws.close();
  });

  it("a restore_version through MCP makes it Editing", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const later = vi.spyOn(agentModule, "touchViewerAgentLater");
    const c = await connect(alice.grant);
    ok(await tool(c, "restore_version", { id, version: 1 }));
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.agent?.state).toBe("editing");
    expect(later).not.toHaveBeenCalled();
    await c.close();
    b.ws.close();
  });

  it("a settings-only publish_artifact makes no DO call and no touch", async () => {
    const id = await pub(alice);
    const c = await connect(alice.grant);
    const doMod = await import("../src/runtime/do.js");
    const stubs = vi.spyOn(doMod, "runtimeStub");
    const later = vi.spyOn(agentModule, "touchViewerAgentLater");
    const touch = vi.spyOn(agentModule, "viewerAgentTouch");
    ok(await tool(c, "publish_artifact", { id, title: "renamed" }));
    expect(stubs).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    expect(await agentRows(id)).toBe(0);
    await c.close();
  });

  it("a data write through artifact_data_set makes it Editing", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const later = vi.spyOn(agentModule, "touchViewerAgentLater");
    const c = await connect(alice.grant);
    ok(
      await tool(c, "artifact_data_set", {
        id,
        collection: "notes",
        docId: "n1",
        data: { a: 1 },
        activity: "saving notes",
      }),
    );
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.agent).toMatchObject({
      state: "editing",
      activity: "saving notes",
    });
    // A data read rides its DO call too, and stays Viewing for a reader.
    const reader = await connect(alice.grant);
    ok(
      await tool(reader, "artifact_data_get", {
        id,
        collection: "notes",
        docId: "n1",
      }),
    );
    const g = await b.until(hasAgents(2));
    expect(
      agents(g)
        .map((a) => a.agent?.state)
        .sort(),
    ).toEqual(["editing", "viewing"]);
    expect(later).not.toHaveBeenCalled();
    await reader.close();
    await c.close();
    b.ws.close();
  });

  it('two legacy MCP sessions of one client show as "Claude Code" and "Claude Code-2"; one session\'s calls show once', async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const c1 = await connect(alice.grant);
    const c2 = await connect(alice.grant);
    ok(await tool(c1, "get_artifact", { id }));
    await b.until(hasAgents(1));
    ok(await tool(c1, "artifact_data_list", { id, collection: "notes" }));
    ok(await tool(c2, "get_artifact", { id }));
    const f = await b.until(hasAgents(2));
    expect(
      agents(f)
        .map((a) => a.name)
        .sort(),
    ).toEqual([PRODUCT, `${PRODUCT}-2`]);
    expect(await agentRows(id)).toBe(2);
    await c1.close();
    await c2.close();
    b.ws.close();
  });

  it("a client without the session header gets one face per connection", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    await rawCall(alice.grant, "get_artifact", { id });
    await rawCall(alice.grant, "get_artifact", { id });
    await rawCall(alice.grant, "artifact_data_list", {
      id,
      collection: "notes",
    });
    expect(await agentRows(id)).toBe(1);
    // Another connection (a PAT) is another face.
    await rawCall(alicePat, "get_artifact", { id });
    expect(await agentRows(id)).toBe(2);
    await b.until(hasAgents(2));
    b.ws.close();
  });

  it("a modern-era client (connect(token, { modern: true })) gets no Mcp-Session-Id and shows one face per connection across its calls", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    const c1 = await connect(alice.grant, { modern: true });
    const c2 = await connect(alice.grant, { modern: true });
    ok(await tool(c1, "get_artifact", { id }));
    ok(await tool(c2, "get_artifact", { id }));
    ok(await tool(c1, "artifact_data_list", { id, collection: "notes" }));
    expect(await agentRows(id)).toBe(1);
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.name).toBe(PRODUCT);
    await c1.close();
    await c2.close();
    b.ws.close();
  });

  it("an agent drops off AGENT_PRESENT_MS after its last request", async () => {
    const id = await pub(alice);
    const stub = stubOf(id);
    const clock = { t: BASE };
    await runInDurableObject(stub, (i: ArtifactRuntime) => {
      i.now = () => clock.t;
    });
    // Runs the publish's index job (armed on the wall clock) out of the way.
    await runDurableObjectAlarm(stub);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    clock.t = BASE + 2_000;
    const c = await connect(alice.grant);
    ok(await tool(c, "get_artifact", { id }));
    await b.until(hasAgents(1));
    const seen = clock.t;
    const alarmAt = () =>
      runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    expect(await alarmAt()).toBe(seen + AGENT_PRESENT_MS);
    clock.t = seen + AGENT_PRESENT_MS - 1;
    await runDurableObjectAlarm(stub);
    expect(agents(lastOf(b))).toHaveLength(1);
    expect(await agentRows(id)).toBe(1);
    const n = b.presence.length;
    clock.t = seen + AGENT_PRESENT_MS;
    await runDurableObjectAlarm(stub);
    expect(await agentRows(id)).toBe(0);
    await b.until(hasAgents(0), n);
    await c.close();
    b.ws.close();
  });

  it('a PAT agent shows as "Agent" with no product', async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    await rawCall(alicePat, "get_artifact", { id });
    const f = await b.until(hasAgents(1));
    const a = agents(f)[0] as PresenceEntry;
    expect(a.name).toBe("Agent");
    expect(a.named).toBe(false);
    expect(a.agent?.owner).toBe("Alice Owner");
    expect(a.agent).not.toHaveProperty("product");
    expect(a.agent).not.toHaveProperty("label");
    b.ws.close();
  });

  it("a PAT-connected agent's token label never reaches another viewer", async () => {
    const id = await pub(alice);
    const o = await sock(id, alice);
    const named = await sock(id, bob);
    const anon = await sock(id, null);
    const g = await sock(id, guest);
    const embed = await sock(id, null, `${R.events(id)}?embed=1`);
    for (const s of [o, named, anon, g]) await s.until(hasAgents(0));
    // MCP over the PAT: read, publish, data write.
    const c = await connect(alicePat);
    ok(await tool(c, "get_artifact", { id }));
    ok(
      await tool(c, "publish_artifact", {
        id,
        format: "html",
        content: "<p>2</p>",
      }),
    );
    ok(
      await tool(c, "artifact_data_set", {
        id,
        collection: "notes",
        docId: "n1",
        data: { a: 1 },
      }),
    );
    // REST over the same PAT: read, publish, data write.
    expect((await api(app, R.artifact(id), alicePat)).status).toBe(200);
    const pv = await api(app, R.versions(id), alicePat, {
      method: "POST",
      body: { format: "html", content: "<p>3</p>" },
    });
    expect(pv.status).toBe(201);
    const pd = await api(app, R.dataDoc(id, "notes", "n2"), alicePat, {
      method: "PUT",
      body: { b: 2 },
    });
    expect(pd.status).toBe(200);
    // MCP session and REST connection: two faces, both "Agent".
    const own = await o.until(
      (f) =>
        agents(f).length === 2 &&
        agents(f).every((a) => a.agent?.label === LABEL),
    );
    for (const s of [named, anon, g]) await s.until(hasAgents(2));
    for (const a of agents(own)) {
      expect(a.name).toMatch(/^Agent(-2)?$/);
      expect(a.agent).not.toHaveProperty("product");
    }
    // The owner's frames carry the label only as agent.label.
    for (const raw of o.raw.filter((r) => r.includes('"presence"'))) {
      const f = PresenceFrameSchema.parse(JSON.parse(raw));
      for (const v of f.viewers) {
        expect(v.name).not.toContain("label-7f3c");
        expect(v.agent?.product ?? "").not.toContain("label-7f3c");
        expect(v.agent?.owner ?? "").not.toContain("label-7f3c");
        expect(v.agent?.activity ?? "").not.toContain("label-7f3c");
      }
    }
    // Anon, guest (public link) and embed: no frame at all carries it.
    for (const s of [anon, g, embed])
      expect(s.raw.join("\n")).not.toContain("label-7f3c");
    // The named member: no presence frame carries it. (The `version` frame's
    // by.name is the pre-existing publisher attribution, outside presence.)
    expect(
      named.raw.filter((r) => !r.includes('"type":"version"')).join("\n"),
    ).not.toContain("label-7f3c");
    // Embed gets no presence frames at all.
    expect(embed.raw.filter((r) => r.includes('"presence"'))).toHaveLength(0);
    // No email, user id, token id or actor in any non-owner frame.
    for (const s of [named, anon, g, embed]) {
      const all = s.raw.join("\n");
      expect(all).not.toContain(alice.email);
      expect(all).not.toContain(alice.userId);
      expect(all).not.toContain('"u:');
      expect(all).not.toContain('"t:');
      expect(all).not.toContain('"g:');
      expect(all).not.toContain(alicePatId);
    }
    await c.close();
    for (const s of [o, named, anon, g, embed]) s.ws.close();
  });

  it("an OAuth grant's product is its client name; a token's is never its label", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    await rawCall(alice.grant, "get_artifact", { id });
    await rawCall(alicePat, "get_artifact", { id });
    const f = await b.until(hasAgents(2));
    const products = agents(f).map((a) => a.agent?.product ?? null);
    expect(products.sort()).toEqual([PRODUCT, null].sort());
    expect(JSON.stringify(f)).not.toContain("label-7f3c");
    b.ws.close();
  });

  it('an owner with no name gives agent.owner "Member", never the email', async () => {
    const nameless = await mk("vpa-nameless");
    // Member.name falls back to the full email (effectiveName).
    expect(nameless.member.name).toBe(nameless.email);
    const pat = (await createPat(env, nameless.userId, "nl")).token;
    const id = await pub(nameless);
    const b = await sock(id, bob);
    const o = await sock(id, nameless);
    await b.until(hasAgents(0));
    await rawCall(pat, "get_artifact", { id });
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.agent?.owner).toBe("Member");
    await o.until(hasAgents(1));
    for (const s of [b, o]) {
      const all = s.raw.join("\n").toLowerCase();
      expect(all).not.toContain(nameless.email.toLowerCase());
    }
    b.ws.close();
    o.ws.close();
  });

  it("closeActor of the owner removes their agents at once", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    await rawCall(alice.grant, "get_artifact", { id });
    await b.until(hasAgents(1));
    const n = b.presence.length;
    await runInDurableObject(stubOf(id), (i: ArtifactRuntime) =>
      i.closeActor(`u:${alice.userId}`, "revoked"),
    );
    expect(await agentRows(id)).toBe(0);
    await b.until(hasAgents(0), n);
    b.ws.close();
  });

  it("activity over 80 chars is refused by the tool input; activity never appears for a non-agent", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    const o = await sock(id, alice);
    await b.until(hasAgents(0));
    const c = await connect(alice.grant);
    const r = await tool(c, "get_artifact", { id, activity: "x".repeat(81) });
    expect(r.isError).toBe(true);
    expect(await agentRows(id)).toBe(0);
    ok(await tool(c, "get_artifact", { id, activity: "y".repeat(80) }));
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.agent?.activity).toBe("y".repeat(80));
    for (const v of f.viewers.filter((x) => x.kind !== "agent"))
      expect(v).not.toHaveProperty("agent");
    await c.close();
    b.ws.close();
    o.ws.close();
  });

  it("REST GET R.artifact with a PAT adds the agent; with a session cookie it does not", async () => {
    const id = await pub(alice);
    const b = await sock(id, bob);
    await b.until(hasAgents(0));
    expect((await api(app, R.artifact(id), alice.cookie)).status).toBe(200);
    // fetchAndWait awaited the request's waitUntil: a touch would be done.
    expect(await agentRows(id)).toBe(0);
    expect((await api(app, R.artifact(id), alicePat)).status).toBe(200);
    expect(await agentRows(id)).toBe(1);
    const f = await b.until(hasAgents(1));
    expect(agents(f)[0]?.name).toBe("Agent");
    b.ws.close();
  });

  it("a failed touch leaves the MCP and REST results intact and logs viewer_presence_touch_failed", async () => {
    const id = await pub(alice);
    // The schema is not recreated while the instance is ready: every agent
    // upsert now throws.
    await runInDurableObject(stubOf(id), (_i, st) => {
      st.storage.sql.exec("drop table viewer_presence_agent");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged = () =>
      spy.mock.calls.filter((c) =>
        String(c[0]).includes("viewer_presence_touch_failed"),
      ).length;
    const c = await connect(alice.grant);
    const set = ok(
      await tool(c, "artifact_data_set", {
        id,
        collection: "notes",
        docId: "n1",
        data: { a: 1 },
      }),
    );
    expect(set.structuredContent).toMatchObject({ id: "n1", data: { a: 1 } });
    const got = ok(
      await tool(c, "artifact_data_get", {
        id,
        collection: "notes",
        docId: "n1",
      }),
    );
    expect(got.structuredContent).toMatchObject({ doc: { data: { a: 1 } } });
    ok(await tool(c, "get_artifact", { id }));
    ok(
      await tool(c, "publish_artifact", {
        id,
        format: "html",
        content: "<p>2</p>",
      }),
    );
    const put = await api(app, R.dataDoc(id, "notes", "n2"), alicePat, {
      method: "PUT",
      body: { b: 2 },
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ id: "n2", data: { b: 2 } });
    const read = await api(app, R.dataDoc(id, "notes", "n2"), alicePat);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { b: 2 } });
    // data set, data get, get_artifact, publish, REST put, REST get.
    await vi.waitFor(() => expect(logged()).toBeGreaterThanOrEqual(6));
    await c.close();
  });
});

// AI agents on the viewer-presence roster (#539 Task 6): MCP and REST calls
// that reach an artifact put the caller on an open viewer's roster. A token
// connection's label goes only to the token's owner.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  AGENT_PRESENT_MS,
  type ArtifactEvent,
  ArtifactEventSchema,
  type Member,
  newId,
  type PresenceEntry,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  MCP_URL,
  oauthToken,
  tool,
} from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
let guest: U;
let plain: U;

async function mk(
  prefix: string,
  role: Member["role"],
  displayName?: string,
): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  if (displayName)
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(displayName, l.userId)
      .run();
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

beforeAll(async () => {
  owner = await mk("vp-owner", "member", "Evie Owner");
  viewer = await mk("vp-viewer", "member", "Vera Viewer");
  guest = await mk("vp-guest", "guest", "Gus Guest");
  plain = await mk("vp-plain", "member");
});

const pub = async (u: U = owner, extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      u.member,
      {
        title: "vp",
        format: "html",
        content: "<p>1</p>",
        visibility: "public",
        capabilities: { db: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

// ---------------------------------------------------------------- sockets

type Roster = { viewers: PresenceEntry[]; total: number };
type Sock = {
  ws: WebSocket;
  raw: string[];
  roster: Roster[];
  /** Resolves with the first roster frame (past or future) that satisfies `pred`. */
  until: (pred: (r: Roster) => boolean) => Promise<Roster>;
  settle: () => Promise<void>;
};
let ipSeq = 0;
const ip = () => `198.51.100.${(++ipSeq % 250) + 1}`;

function wrap(ws: WebSocket): Sock {
  const raw: string[] = [];
  const roster: Roster[] = [];
  const watchers: { pred: (r: Roster) => boolean; res: (r: Roster) => void }[] =
    [];
  const pongs: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    const s = String(e.data);
    raw.push(s);
    if (s === "pong") {
      pongs.shift()?.();
      return;
    }
    const f: ArtifactEvent = ArtifactEventSchema.parse(JSON.parse(s));
    if (f.type !== "presence") return;
    roster.push(f);
    for (let i = watchers.length - 1; i >= 0; i--) {
      const w = watchers[i];
      if (w?.pred(f)) {
        watchers.splice(i, 1);
        w.res(f);
      }
    }
  });
  ws.accept();
  return {
    ws,
    raw,
    roster,
    until: (pred) => {
      const hit = roster.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((res) => watchers.push({ pred, res }));
    },
    settle: () =>
      new Promise<void>((res) => {
        pongs.push(res);
        ws.send("ping");
      }),
  };
}

const clocks = new Map<string, number>();
/** Steps the artifact's clock past the coalesce window, so a change is sent at once. */
async function tick(id: string, ms = 1100) {
  const t = (clocks.get(id) ?? 1_900_000_000_000) + ms;
  clocks.set(id, t);
  await runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      i.now = () => t;
    },
  );
  return t;
}

async function open(
  id: string,
  u: U | null,
  headers: Record<string, string> = {},
): Promise<Sock> {
  await tick(id);
  const r = await api(app, R.events(id), u?.cookie ?? null, {
    headers: { upgrade: "websocket", "cf-connecting-ip": ip(), ...headers },
  });
  if (!r.webSocket) throw new Error(`no websocket (${r.status})`);
  const s = wrap(r.webSocket);
  if (!headers["x-oa-embed"]) await s.until(() => true);
  return s;
}

const agents = (r: Roster) => r.viewers.filter((v) => v.kind === "agent");
const hasAgent = (r: Roster) => agents(r).length > 0;
const agentNames = (r: Roster) => agents(r).map((v) => v.name);

// ------------------------------------------------------------------- agents

async function pat(u: U, label: string) {
  return (await createPat(env, u.userId, label)).token;
}
/** An OAuth grant for `u`, named like the client ("Claude Code"). */
async function grant(u: U, clientName = "Claude Code") {
  return (await oauthToken(u.email, clientName, u)).accessToken;
}

const rawCall = (
  token: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  callWorker(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );

const countAgents = (id: string) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (_i, s) =>
      s.storage.sql
        .exec("select count(*) as n from viewer_presence_agent")
        .one().n,
  );

describe("viewer presence: AI agents", () => {
  it('an MCP get_artifact puts the agent on an open viewer\'s roster as "<product>", owner name, Viewing', async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "get_artifact", { id, activity: "reading the plan" });
    const r = await v.until(hasAgent);
    expect(agents(r)).toHaveLength(1);
    expect(agents(r)[0]).toMatchObject({
      kind: "agent",
      name: "Claude Code",
      named: true,
      agent: {
        owner: "Evie Owner",
        product: "Claude Code",
        state: "viewing",
        activity: "reading the plan",
      },
    });
    await c.close();
  });

  it("a publish through MCP makes it Editing with the change note as activity", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "publish_artifact", {
      id,
      title: "vp",
      format: "html",
      content: "<p>2</p>",
      message: "tightened the intro",
    });
    const r = await v.until((x) => agents(x)[0]?.agent?.state === "editing");
    expect(agents(r)[0]?.agent).toMatchObject({
      activity: "tightened the intro",
    });
    await c.close();
  });

  it("a restore_version through MCP makes it Editing", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "publish_artifact", {
      id,
      title: "vp",
      format: "html",
      content: "<p>2</p>",
    });
    await v.until((x) => agents(x)[0]?.agent?.state === "editing");
    // Back to viewing, then a restore edits again.
    await tick(id, AGENT_PRESENT_MS + 5000);
    await runDurableObjectAlarm(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    );
    await v.until((x) => !hasAgent(x));
    await tick(id);
    await tool(c, "restore_version", { id, version: 1 });
    const r = await v.until((x) => agents(x)[0]?.agent?.state === "editing");
    expect(agents(r)).toHaveLength(1);
    await c.close();
  });

  it("a settings-only publish_artifact makes no touch", async () => {
    const id = await pub();
    const c = await connect(await pat(owner, "settings-agent"));
    await tool(c, "publish_artifact", { id, title: "renamed" });
    expect(await countAgents(id)).toBe(0);
    await c.close();
  });

  it("a data write through artifact_data_set makes it Editing", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "artifact_data_set", {
      id,
      collection: "votes",
      docId: "a",
      data: { n: 1 },
    });
    const r = await v.until((x) => agents(x)[0]?.agent?.state === "editing");
    expect(agentNames(r)).toEqual(["Claude Code"]);
    await c.close();
  });

  it('two legacy MCP sessions of one client show as "Claude Code" and "Claude Code-2"; one session\'s calls show once', async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const token = await grant(owner);
    const a = await connect(token);
    const b = await connect(token);
    await tick(id);
    await tool(a, "get_artifact", { id });
    await tick(id);
    await tool(b, "get_artifact", { id });
    await tick(id);
    await tool(a, "get_artifact", { id });
    const r = await v.until((x) => agents(x).length === 2);
    expect(agentNames(r).sort()).toEqual(["Claude Code", "Claude Code-2"]);
    expect(await countAgents(id)).toBe(2);
    await a.close();
    await b.close();
  });

  it("a client without the session header gets one face per connection", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const token = await grant(owner);
    await tick(id);
    expect((await rawCall(token, "get_artifact", { id })).status).toBe(200);
    await tick(id);
    expect((await rawCall(token, "get_artifact", { id })).status).toBe(200);
    await v.until(hasAgent);
    expect(await countAgents(id)).toBe(1);
  });

  it("a modern-era client (connect(token, { modern: true })) shows one face per connection across its calls", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const token = await grant(owner);
    const a = await connect(token, { modern: true });
    await tick(id);
    await tool(a, "get_artifact", { id });
    await tick(id);
    const b = await connect(token, { modern: true });
    await tool(b, "get_artifact", { id });
    await v.until(hasAgent);
    expect(await countAgents(id)).toBe(1);
    await a.close();
    await b.close();
  });

  it("an agent drops off AGENT_PRESENT_MS after its last request", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "get_artifact", { id });
    await v.until(hasAgent);
    await tick(id, AGENT_PRESENT_MS + 2);
    await runDurableObjectAlarm(
      runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    );
    const r = await v.until((x) => !hasAgent(x) && x.total === 1);
    expect(r.viewers).toHaveLength(1);
    expect(await countAgents(id)).toBe(0);
    await c.close();
  });

  it('a PAT agent shows as "Agent" with no product', async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await pat(owner, "my-laptop-pat"));
    await tick(id);
    await tool(c, "get_artifact", { id });
    const r = await v.until(hasAgent);
    expect(agents(r)[0]).toMatchObject({
      name: "Agent",
      named: false,
      agent: { owner: "Evie Owner" },
    });
    expect(agents(r)[0]?.agent?.product).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("my-laptop-pat");
    await c.close();
  });

  it("a PAT-connected agent's token label never reaches another viewer", async () => {
    const id = await pub();
    const label = "label-7f3c secret";
    const token = await pat(owner, label);
    const named = await open(id, viewer);
    const anon = await open(id, null);
    const gst = await open(id, guest);
    const embed = await open(id, null, { "x-oa-embed": "1" });
    const own = await open(id, owner);
    const c = await connect(token);
    await tick(id);
    await tool(c, "get_artifact", { id, activity: "checking" });
    await tick(id);
    // REST with the same token, a publish and a data read.
    expect((await api(app, R.artifact(id), token)).status).toBe(200);
    await tick(id);
    await tool(c, "publish_artifact", {
      id,
      title: "vp",
      format: "html",
      content: "<p>3</p>",
      message: "edit",
    });
    await tick(id);
    await tool(c, "artifact_data_list", { id, collection: "votes" });
    // The owner's own socket carries the label, as agent.label only.
    const mine = await own.until((r) => agents(r)[0]?.agent?.label === label);
    expect(agents(mine)[0]?.name).toBe("Agent");
    expect(agents(mine)[0]?.agent?.product).toBeUndefined();
    await named.until(hasAgent);
    for (const s of [named, anon, gst, embed]) await s.settle();
    for (const s of [named, anon, gst, embed])
      expect(s.raw.join("\n")).not.toContain("label-7f3c");
    expect(embed.roster).toHaveLength(0);
    expect(named.roster.some(hasAgent)).toBe(true);
    expect(anon.roster.some(hasAgent)).toBe(true);
    expect(gst.roster.some(hasAgent)).toBe(true);
    await c.close();
  });

  it("an OAuth grant's product is its client name; a token's is never its label", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const g = await connect(await grant(owner, "Cursor"));
    await tick(id);
    await tool(g, "get_artifact", { id });
    const r = await v.until(hasAgent);
    expect(agents(r)[0]?.agent?.product).toBe("Cursor");
    expect(agents(r)[0]?.agent?.label).toBeUndefined();
    await g.close();
  });

  it('an owner with no name gives agent.owner "Member", never the email', async () => {
    const id = await pub(plain);
    const v = await open(id, viewer);
    const c = await connect(await pat(plain, "unnamed-owner-agent"));
    await tick(id);
    await tool(c, "get_artifact", { id });
    const r = await v.until(hasAgent);
    expect(agents(r)[0]?.agent?.owner).toBe("Member");
    expect(JSON.stringify(r)).not.toContain(plain.email);
    expect(JSON.stringify(r)).not.toContain("@");
    await c.close();
  });

  it("closeActor of the owner removes their agents at once", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    await tick(id);
    await tool(c, "get_artifact", { id });
    await v.until(hasAgent);
    await tick(id);
    await runtimeStub(env, id).closeActor(`u:${owner.userId}`, "revoked");
    await v.until((r) => !hasAgent(r) && r.total === 1);
    expect(await countAgents(id)).toBe(0);
    await c.close();
  });

  it("activity over 80 chars is refused by the tool input; activity never appears for a non-agent", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    const c = await connect(await grant(owner));
    const refused = await tool(c, "get_artifact", {
      id,
      activity: "x".repeat(81),
    }).catch(() => ({ isError: true }));
    expect(refused.isError).toBe(true);
    expect(await countAgents(id)).toBe(0);
    await v.settle();
    for (const r of v.roster)
      for (const e of r.viewers)
        if (e.kind !== "agent") expect(e.agent).toBeUndefined();
    await c.close();
  });

  it("REST GET R.artifact with a PAT adds the agent; with a session cookie it does not", async () => {
    const id = await pub();
    const v = await open(id, viewer);
    await tick(id);
    expect((await api(app, R.artifact(id), owner.cookie)).status).toBe(200);
    expect(await countAgents(id)).toBe(0);
    await tick(id);
    expect(
      (await api(app, R.artifact(id), await pat(owner, "rest-agent"))).status,
    ).toBe(200);
    const r = await v.until(hasAgent);
    expect(agents(r)[0]?.name).toBe("Agent");
    expect(APP).toBeTruthy();
  });
});

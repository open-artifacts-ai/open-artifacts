import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { DATA_WRITERS_WARNING, newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import { api, login } from "./helpers.js";
import { connect, type ToolResult, textOf, tool } from "./mcp-helpers.js";

// #681 D: publish_artifact with an id and only settings updates them in
// place through the PATCH service path and creates no version.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string };
let client: Client;
const open: Client[] = [];

const sc = <T = Record<string, unknown>>(r: ToolResult) => {
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent as T;
};

const html = async (extra: Record<string, unknown> = {}) =>
  sc<{ id: string; version: number }>(
    await tool(client, "publish_artifact", {
      title: `so ${tag}`,
      format: "html",
      content: "<p>hi</p>",
      ...extra,
    }),
  ).id;

const versions = async (id: string) =>
  sc<{ items: { version: number }[] }>(
    await tool(client, "list_versions", { id }),
  ).items.length;

const summary = async (id: string) =>
  sc<{
    artifact: {
      title: string;
      description: string | null;
      visibility: string;
      dataWriters: string;
      capabilities: Record<string, boolean>;
      currentVersion: number;
    };
  }>(await tool(client, "get_artifact", { id, includeContent: false }))
    .artifact;

/** A member with `role` on `id`, connected over MCP with a PAT. */
async function sharedClient(id: string, role: "viewer" | "editor") {
  const email = `so-${role}-${newId().slice(0, 6).toLowerCase()}@x.com`;
  const u = await login(email);
  await getDb(env).insert(shares).values({
    artifactId: id,
    email,
    role,
    createdBy: owner.userId,
    createdAt: Date.now(),
  });
  const c = await connect((await createPat(env, u.userId, role)).token);
  open.push(c);
  return { client: c, ...u };
}

beforeAll(async () => {
  owner = await login(`so-owner-${tag}@x.com`);
  client = await connect((await createPat(env, owner.userId, "so")).token);
  open.push(client);
});
afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
});

describe("publish_artifact with only settings (#681 D)", () => {
  it("updates visibility and dataWriters in place; no new version; publish's result shape", async () => {
    const first = sc<{ id: string; version: number; url: string }>(
      await tool(client, "publish_artifact", {
        title: `so ${tag}`,
        format: "html",
        content: "<p>hi</p>",
        capabilities: { db: true },
      }),
    );
    const id = first.id;
    expect(await versions(id)).toBe(1);
    const r = await tool(client, "publish_artifact", {
      id,
      visibility: "team",
      dataWriters: "editors",
      message: "ignored",
    });
    const out = sc(r);
    // publish's shape: id, the current version and the same view URL.
    expect(out).toEqual({ id, version: 1, url: first.url });
    expect(r.content).toHaveLength(1);
    expect(textOf(r)).not.toContain("\n");
    expect(textOf(r)).toContain(first.url);
    expect(textOf(r)).toMatch(/no new version/);
    expect(await versions(id)).toBe(1);
    const a = await summary(id);
    expect(a).toMatchObject({
      visibility: "team",
      dataWriters: "editors",
      currentVersion: 1,
    });
  });

  it("title, description and capabilities alone; version stays the latest", async () => {
    const id = await html();
    sc(
      await tool(client, "publish_artifact", {
        id,
        format: "html",
        content: "<p>v2</p>",
      }),
    );
    const out = sc<{ version: number }>(
      await tool(client, "publish_artifact", {
        id,
        title: "Renamed",
        description: "New words",
        capabilities: { viewer: true },
      }),
    );
    expect(out.version).toBe(2);
    expect(await versions(id)).toBe(2);
    expect(await summary(id)).toMatchObject({
      title: "Renamed",
      description: "New words",
      capabilities: { db: false, viewer: true, storage: false },
    });
  });

  it("audits a visibility change as PATCH does", async () => {
    const id = await html();
    sc(await tool(client, "publish_artifact", { id, visibility: "team" }));
    const row = await env.DB.prepare(
      "select action, actor_id, detail from audit_events where target_id = ? order by at desc limit 1",
    )
      .bind(id)
      .first<{ action: string; actor_id: string; detail: string }>();
    expect(row).toMatchObject({
      action: "artifact.visibility",
      actor_id: owner.userId,
    });
    expect(JSON.parse(row?.detail ?? "")).toEqual({
      from: "private",
      to: "team",
    });
  });

  it("warns when public + db + viewers, as PATCH does", async () => {
    const id = await html({ capabilities: { db: true } });
    const r = await tool(client, "publish_artifact", {
      id,
      visibility: "public",
    });
    const out = sc<{ warning?: string; version: number }>(r);
    expect(out.warning).toBe(DATA_WRITERS_WARNING);
    expect(textOf(r)).toContain(DATA_WRITERS_WARNING);
    expect(out.version).toBe(1);
    // editors: no warning.
    const quiet = sc<{ warning?: string }>(
      await tool(client, "publish_artifact", { id, dataWriters: "editors" }),
    );
    expect(quiet.warning).toBeUndefined();
  });

  it("an editor who isn't owner or manager gets PATCH's refusal; a title edit still works", async () => {
    const id = await html();
    const ed = await sharedClient(id, "editor");
    const mcp = await tool(ed.client, "publish_artifact", {
      id,
      visibility: "team",
    });
    expect(mcp.isError).toBe(true);
    const rest = await api(app, R.artifact(id), ed.cookie, {
      method: "PATCH",
      body: { visibility: "team" },
    });
    expect(rest.status).toBe(400);
    const restErr = ((await rest.json()) as { error: { message: string } })
      .error;
    expect(textOf(mcp)).toBe(`bad_request: ${restErr.message}`);
    expect((await summary(id)).visibility).toBe("private");
    sc(await tool(ed.client, "publish_artifact", { id, title: "By editor" }));
    expect((await summary(id)).title).toBe("By editor");
    expect(await versions(id)).toBe(1);
  });

  it("a viewer is refused", async () => {
    const id = await html();
    const v = await sharedClient(id, "viewer");
    for (const args of [{ title: "x" }, { visibility: "team" }]) {
      const r = await tool(v.client, "publish_artifact", { id, ...args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^not_found|^forbidden/);
    }
    expect((await summary(id)).title).toBe(`so ${tag}`);
  });

  it("nothing to change → 400 bad_request", async () => {
    const id = await html();
    for (const args of [{}, { message: "only a note" }, { capabilities: {} }]) {
      const r = await tool(client, "publish_artifact", { id, ...args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^bad_request: Nothing to change/);
    }
    expect(await versions(id)).toBe(1);
  });

  it("format, language or entry without content → 400; settings untouched", async () => {
    const id = await html();
    for (const args of [
      { format: "markdown" },
      { language: "python" },
      { entry: "index.html" },
    ]) {
      const r = await tool(client, "publish_artifact", {
        id,
        visibility: "team",
        ...args,
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^bad_request: \w+ belongs to a version/);
    }
    expect((await summary(id)).visibility).toBe("private");
    expect(await versions(id)).toBe(1);
  });

  it("spaceId → use_move, as on a publish", async () => {
    const id = await html();
    const r = await tool(client, "publish_artifact", {
      id,
      title: "x",
      spaceId: owner.userId,
    });
    expect(textOf(r)).toMatch(/^use_move/);
  });

  it("an unknown id is not_found; without an id content is still required", async () => {
    const r = await tool(client, "publish_artifact", {
      id: newId(),
      title: "x",
    });
    expect(textOf(r)).toMatch(/^not_found/);
    const noId = await tool(client, "publish_artifact", { title: "x" });
    expect(noId.isError).toBe(true);
    expect(textOf(noId)).toMatch(/exactly one of content or files/);
  });

  it("closes live sockets on an access change", async () => {
    const id = await html({
      visibility: "team",
      capabilities: { db: true },
    });
    const viewer = await login(`so-sock-${tag}@x.com`);
    const r = await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    const ws = r.webSocket;
    if (!ws) throw new Error(`no websocket (${r.status})`);
    ws.accept();
    const code = new Promise<number>((res) =>
      ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
    );
    sc(await tool(client, "publish_artifact", { id, visibility: "private" }));
    expect(await code).toBe(4403);
    expect(await versions(id)).toBe(1);
  });
});

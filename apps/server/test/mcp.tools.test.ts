import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import {
  INLINE_TOO_LARGE_MESSAGE,
  LIMITS,
  newId,
  QUOTA_MESSAGE,
} from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { shares } from "../src/db/schema.js";
import { INSTRUCTIONS } from "../src/mcp/instructions.js";
import { TOOL_DEFS } from "../src/mcp/tool-defs.js";
import manifest from "../src/mcp/tool-manifest.json";
import { SYSTEM_ACTOR, setUserStatus } from "../src/services/members.js";
import { login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  E,
  MCP_URL,
  type ToolResult,
  textOf,
  tool,
} from "./mcp-helpers.js";

const TOOLS = [
  "publish_artifact",
  "create_upload",
  "get_artifact",
  "list_artifacts",
  "search_artifacts",
  "list_versions",
  "restore_version",
  "share_artifact",
  "unshare_artifact",
  "set_visibility",
  "delete_artifact",
  "artifact_data_get",
  "artifact_data_list",
  "artifact_data_query",
  "artifact_data_set",
  "artifact_data_update",
  "artifact_data_delete",
  "list_spaces",
];

const tag = newId().slice(0, 6).toLowerCase();
let owner: { userId: string };
let client: Client;
let ownerPat: string;

const sc = <T = Record<string, unknown>>(r: ToolResult) => {
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent as T;
};

async function publishMd(c: Client, content: string, extra = {}) {
  return sc<{ id: string; version: number; url: string }>(
    await tool(c, "publish_artifact", {
      title: `md ${tag}`,
      format: "markdown",
      content,
      ...extra,
    }),
  );
}

async function shareWith(id: string, email: string, role: "viewer" | "editor") {
  await getDb(env).insert(shares).values({
    artifactId: id,
    email,
    role,
    createdBy: owner.userId,
    createdAt: Date.now(),
  });
}

beforeAll(async () => {
  owner = await login(`mcp-owner-${tag}@x.com`);
  ownerPat = (await createPat(env, owner.userId, "my-agent")).token;
  client = await connect(ownerPat);
});
afterAll(async () => {
  await client?.close();
});

describe("MCP tools over PAT", () => {
  it("tools/list has all 18 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("publish_artifact markdown → get_artifact returns the same content", async () => {
    const content = `# Hello ${tag}\n\nSome *markdown*.\n`;
    const pub = await publishMd(client, content);
    expect(pub.version).toBe(1);
    const r = await tool(client, "get_artifact", { id: pub.id });
    const got = sc<{
      artifact: { id: string; format: string };
      version: { version: number; agent: unknown };
      content?: string;
      downloadUrl?: string;
    }>(r);
    expect(got.content).toBe(content);
    expect(got.downloadUrl).toBeUndefined();
    expect(got.artifact).toMatchObject({ id: pub.id, format: "markdown" });
    expect(got.version.version).toBe(1);
    // PAT attribution: the token label, no version.
    expect(got.version.agent).toEqual({ name: "my-agent", version: null });
    expect(textOf(r)).toContain(pub.id);
  });

  it("a result is a one-line summary with the URL plus structured content", async () => {
    const r = await tool(client, "publish_artifact", {
      title: "summary",
      format: "markdown",
      content: "x",
    });
    const pub = sc<{ url: string }>(r);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe("text");
    expect(textOf(r)).not.toContain("\n");
    expect(textOf(r)).toContain(pub.url);
  });

  it("a 3-file HTML artifact → list_versions has 1 version with 3 files", async () => {
    const pub = sc<{ id: string }>(
      await tool(client, "publish_artifact", {
        title: `site ${tag}`,
        entry: "index.html",
        files: {
          "index.html":
            '<link rel="stylesheet" href="s.css"><script src="a.js"></script>',
          "s.css": "body{color:red}",
          "a.js": "console.log(1)",
        },
      }),
    );
    const v = sc<{ items: { files: unknown[] }[] }>(
      await tool(client, "list_versions", { id: pub.id }),
    );
    expect(v.items).toHaveLength(1);
    expect(v.items[0]?.files).toHaveLength(3);
  });

  it("get_artifact: binary is never inlined, gets a signed downloadUrl", async () => {
    const png = btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0));
    const pub = sc<{ id: string }>(
      await tool(client, "publish_artifact", {
        title: "bin",
        entry: "index.html",
        files: { "index.html": "<img src=a.png>", "a.png": { base64: png } },
      }),
    );
    const got = sc<{ content?: string; downloadUrl?: string }>(
      await tool(client, "get_artifact", { id: pub.id, path: "a.png" }),
    );
    expect(got.content).toBeUndefined();
    expect(got.downloadUrl).toMatch(
      new RegExp(
        `^http://content\\.localhost/c/\\d+\\.[\\w-]+/${pub.id}/v1/a\\.png\\?dl=1$`,
      ),
    );
  });

  it("get_artifact: text over 1 MB gets a downloadUrl, no inline content", async () => {
    // Over LIMITS.inlineBytes: create_upload, PUT, publish by uploadId.
    const big = "a".repeat(1024 * 1024 + 10);
    const up = sc<{ uploadId: string; artifactId: string; url: string }>(
      await tool(client, "create_upload", {
        path: "README.md",
        size: big.length,
      }),
    );
    const u = new URL(up.url);
    const put = await callWorker(
      new Request(`${APP}${u.pathname}${u.search}`, {
        method: "PUT",
        body: big,
        headers: { "content-length": String(big.length) },
      }),
    );
    expect(put.status).toBe(204);
    const pub = sc<{ id: string }>(
      await tool(client, "publish_artifact", {
        id: up.artifactId,
        title: `md ${tag}`,
        files: { "README.md": { uploadId: up.uploadId } },
      }),
    );
    const got = sc<{ content?: string; downloadUrl?: string }>(
      await tool(client, "get_artifact", { id: pub.id }),
    );
    expect(got.content).toBeUndefined();
    expect(got.downloadUrl).toContain(`/${pub.id}/v1/`);
  });

  it("get_artifact includeContent=false omits content", async () => {
    const pub = await publishMd(client, "# no content");
    const got = sc<{ content?: string }>(
      await tool(client, "get_artifact", { id: pub.id, includeContent: false }),
    );
    expect(got.content).toBeUndefined();
  });

  it("a strict-schema failure is an isError result naming the field", async () => {
    const r = await tool(client, "get_artifact", { id: "nope", bogus: 1 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/bogus|id/);
    const r2 = await tool(client, "restore_version", { id: newId() });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toMatch(/version/);
  });

  it(`C3: inline content over ${LIMITS.inlineBytes / 1024} KB → too_large steering to create_upload then publish({uploadId})`, async () => {
    const r = await tool(client, "publish_artifact", {
      title: "big",
      format: "html",
      content: "x".repeat(LIMITS.inlineBytes + 1),
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`too_large: ${INLINE_TOO_LARGE_MESSAGE}`);
    const kb = LIMITS.inlineBytes / 1024;
    expect(textOf(r)).toBe(
      `too_large: Inline content is limited to ${kb} KB per publish. For larger files: create_upload({ path, size, contentType }), PUT the bytes to the returned url, then publish_artifact({ id: artifactId, title, files: { "<path>": { uploadId } } }).`,
    );
    const half = "x".repeat(LIMITS.inlineBytes / 2);
    const f = await tool(client, "publish_artifact", {
      title: "big",
      files: { "a.txt": half, "b.txt": half, "c.txt": "y" },
    });
    expect(textOf(f)).toBe(`too_large: ${INLINE_TOO_LARGE_MESSAGE}`);
  });

  it("no access is not_found, never forbidden", async () => {
    const r = await tool(client, "get_artifact", { id: newId() });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not_found: /);
  });

  it("list, search, restore, visibility, share, unshare, delete", async () => {
    const word = `zq${tag}word`;
    const pub = await publishMd(client, `# ${word}\n`, {
      title: `find ${word}`,
    });
    const l = sc<{ items: { id: string }[] }>(
      await tool(client, "list_artifacts", { scope: "mine", limit: 100 }),
    );
    expect(l.items.map((i) => i.id)).toContain(pub.id);
    const s = sc<{ items: { id: string }[] }>(
      await tool(client, "search_artifacts", { q: word }),
    );
    expect(s.items.map((i) => i.id)).toContain(pub.id);
    const rv = sc<{ version: number }>(
      await tool(client, "restore_version", { id: pub.id, version: 1 }),
    );
    expect(rv.version).toBe(2);
    const vis = sc<{ visibility: string }>(
      await tool(client, "set_visibility", { id: pub.id, visibility: "team" }),
    );
    expect(vis.visibility).toBe("team");
    const sh = sc<{ email: string; role: string }>(
      await tool(client, "share_artifact", {
        id: pub.id,
        email: `friend-${tag}@x.com`,
        role: "viewer",
      }),
    );
    expect(sh).toMatchObject({ email: `friend-${tag}@x.com`, role: "viewer" });
    sc(
      await tool(client, "unshare_artifact", {
        id: pub.id,
        email: `friend-${tag}@x.com`,
      }),
    );
    sc(await tool(client, "delete_artifact", { id: pub.id }));
    const gone = await tool(client, "get_artifact", { id: pub.id });
    expect(textOf(gone)).toMatch(/^not_found/);
  });

  it("no tool result or description carries a raw view URL (#292)", async () => {
    const out: unknown[] = [];
    const run = async (name: string, args: Record<string, unknown>) => {
      const r = await tool(client, name, args);
      expect(r.isError, textOf(r)).toBeFalsy();
      out.push(r);
      return r.structuredContent as Record<string, unknown>;
    };
    const png = btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10, 0));
    const pub = await run("publish_artifact", {
      title: `raw ${tag}`,
      entry: "index.html",
      files: { "index.html": "<p>hi</p>", "a.png": { base64: png } },
    });
    const id = pub.id as string;
    await run("get_artifact", { id });
    await run("get_artifact", { id, path: "a.png" });
    await run("get_artifact", { id, includeContent: false });
    await run("list_artifacts", {});
    await run("list_versions", { id });
    await run("set_visibility", { id, visibility: "public" });
    await run("get_artifact", { id, path: "a.png" });
    await run("get_artifact", { id, includeContent: false });
    await run("share_artifact", {
      id,
      email: `raw-${tag}@x.com`,
      role: "viewer",
    });
    await run("unshare_artifact", { id, email: `raw-${tag}@x.com` });
    await run("restore_version", { id, version: 1 });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_artifact")?.description).toContain(
      "Download URLs expire after 10 minutes; call get_artifact again for a fresh one.",
    );
    const text = JSON.stringify({ out, tools, INSTRUCTIONS });
    expect(text).not.toMatch(/raw view|open raw|__view|rawUrl/i);
    // Every content-host URL handed out is an explicit (signed) download.
    const urls = text.match(/http:\/\/content\.localhost[^"\s\\]*/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls)
      expect(u).toMatch(/^http:\/\/content\.localhost\/c\/[^/]+\/.+\?dl=1$/);
  });

  it("create_upload returns a signed upload URL", async () => {
    const up = sc<{ uploadId: string; artifactId: string; url: string }>(
      await tool(client, "create_upload", { path: "big.bin", size: 3_000_000 }),
    );
    expect(up.url).toContain(up.uploadId);
  });

  it("runtime docs resource is readable", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      "openartifacts://docs/runtime",
    );
    const r = await client.readResource({
      uri: "openartifacts://docs/runtime",
    });
    const c = r.contents[0] as { text?: string };
    expect(c.text).toContain("window.openArtifacts");
    expect(c.text).toContain("create_upload");
  });
});

describe("MCP artifact data tools", () => {
  let id: string;
  beforeAll(async () => {
    id = (await publishMd(client, "# data")).id;
  });

  it("artifact_data_set → artifact_data_get round trip (the owner may seed before db)", async () => {
    const set = sc<{ id: string; data: unknown; updatedBy: string }>(
      await tool(client, "artifact_data_set", {
        id,
        collection: "votes",
        docId: "a",
        data: { choice: "A", n: 1 },
      }),
    );
    expect(set).toMatchObject({ id: "a", data: { choice: "A", n: 1 } });
    expect(set.updatedBy).toBe(`u:${owner.userId}`);
    const got = sc<{ doc: { data: unknown } }>(
      await tool(client, "artifact_data_get", {
        id,
        collection: "votes",
        docId: "a",
      }),
    );
    expect(got.doc.data).toEqual({ choice: "A", n: 1 });
  });

  it("update, list, query, delete", async () => {
    sc(
      await tool(client, "artifact_data_update", {
        id,
        collection: "votes",
        docId: "a",
        patch: { n: 2 },
      }),
    );
    sc(
      await tool(client, "artifact_data_set", {
        id,
        collection: "votes",
        docId: "b",
        data: { choice: "B", n: 5 },
      }),
    );
    const l = sc<{ items: { id: string }[] }>(
      await tool(client, "artifact_data_list", { id, collection: "votes" }),
    );
    expect(l.items.map((d) => d.id).sort()).toEqual(["a", "b"]);
    const q = sc<{ items: { id: string; data: { n: number } }[] }>(
      await tool(client, "artifact_data_query", {
        id,
        collection: "votes",
        query: { where: { choice: "A" } },
      }),
    );
    expect(q.items.map((d) => d.data.n)).toEqual([2]);
    sc(
      await tool(client, "artifact_data_delete", {
        id,
        collection: "votes",
        docId: "b",
      }),
    );
    const miss = sc<{ doc: unknown }>(
      await tool(client, "artifact_data_get", {
        id,
        collection: "votes",
        docId: "b",
      }),
    );
    expect(miss.doc).toBeNull();
  });

  it("non-owners: viewers read and write (as REST), capability required", async () => {
    const viewer = await login(`mcp-viewer-${tag}@x.com`);
    const editor = await login(`mcp-editor-${tag}@x.com`);
    await shareWith(id, `mcp-viewer-${tag}@x.com`, "viewer");
    await shareWith(id, `mcp-editor-${tag}@x.com`, "editor");
    const vc = await connect((await createPat(env, viewer.userId, "v")).token);
    const ec = await connect((await createPat(env, editor.userId, "e")).token);
    const get = { id, collection: "votes", docId: "a" };
    const set = { ...get, data: { x: 1 } };
    sc(
      await tool(client, "publish_artifact", {
        id,
        content: "# data no db",
        format: "markdown",
        capabilities: { db: false },
      }),
    );
    // No db capability declared.
    expect(textOf(await tool(vc, "artifact_data_get", get))).toMatch(
      /^capability_denied/,
    );
    expect(textOf(await tool(ec, "artifact_data_set", set))).toMatch(
      /^capability_denied/,
    );
    sc(
      await tool(client, "publish_artifact", {
        id,
        content: "# data v2",
        format: "markdown",
        capabilities: { db: true },
      }),
    );
    sc(await tool(vc, "artifact_data_get", get));
    // Viewers write through MCP, as on the REST runtime routes (spec §6.7).
    const vw = sc<{ updatedBy: string }>(
      await tool(vc, "artifact_data_set", set),
    );
    expect(vw.updatedBy).toBe(`u:${viewer.userId}`);
    const w = sc<{ updatedBy: string }>(
      await tool(ec, "artifact_data_set", set),
    );
    expect(w.updatedBy).toBe(`u:${editor.userId}`);
    const stranger = await login(`mcp-stranger-${tag}@x.com`);
    const sc2 = await connect(
      (await createPat(env, stranger.userId, "s")).token,
    );
    expect(textOf(await tool(sc2, "artifact_data_get", get))).toMatch(
      /^not_found/,
    );
    await Promise.all([vc.close(), ec.close(), sc2.close()]);
  });
});

describe("MCP 2026-07-28 era (per-request envelope)", () => {
  it("lists tools and publishes", async () => {
    const c = await connect(ownerPat, { modern: true });
    expect((await c.listTools()).tools).toHaveLength(18);
    const pub = await publishMd(c, "# modern");
    const got = sc<{ content: string; version: { agent: unknown } }>(
      await tool(c, "get_artifact", { id: pub.id }),
    );
    expect(got.content).toBe("# modern");
    expect(got.version.agent).toEqual({ name: "my-agent", version: null });
    await c.close();
  });
});

describe("MCP request limits and roles (PAT)", () => {
  const H = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const publishBody = (n: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "publish_artifact",
        arguments: { title: "big", format: "markdown", content: "a".repeat(n) },
      },
    });
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...H, authorization: `Bearer ${ownerPat}`, ...headers },
        body,
        duplex: "half",
      } as RequestInit),
    );

  it("a declared content-length over the cap → 413 before any handler", async () => {
    const big = publishBody(3_600_000);
    const r = await post(big, { "content-length": String(big.length) });
    expect(r.status).toBe(413);
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("a streamed body over the cap → 413", async () => {
    const bytes = new TextEncoder().encode(publishBody(3_600_000));
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= bytes.length) return c.close();
        c.enqueue(bytes.slice(i, i + 65536));
        i += 65536;
      },
    });
    expect((await post(body)).status).toBe(413);
  });

  it("a body under the cap is read once and still served (2025-era POST)", async () => {
    const r = await post(publishBody(LIMITS.inlineBytes - 8 * 1024));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Published");
  });

  it("a guest's PAT → 401 with the resource-metadata challenge", async () => {
    const g = await login(`mcp-guest-${tag}@x.com`, "guest");
    const { token } = await createPat(env, g.userId, "g");
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: { ...H, authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("MCP quota errors", () => {
  it("a D1 quota error → isError with QUOTA_MESSAGE", async () => {
    const boom = () => {
      throw new Error(
        "D1_ERROR: Your account has exceeded D1's free tier daily row write limit",
      );
    };
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return boom;
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const c = await connect(ownerPat, { env: E({ DB }) });
    const r = await tool(c, "publish_artifact", {
      title: "q",
      format: "markdown",
      content: "# q",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`quota_exceeded: ${QUOTA_MESSAGE}`);
    await c.close();
  });
});

describe("tool manifest", () => {
  // Gitignored; `pnpm gen` writes it before every test run.
  it("src/mcp/tool-manifest.json is TOOL_DEFS and covers every tool", () => {
    expect(manifest).toEqual(
      TOOL_DEFS.map(({ name, description }) => ({ name, description })),
    );
    expect(manifest.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
  });

  it("tool descriptions and instructions state the current inline limit", () => {
    const kb = `${LIMITS.inlineBytes / 1024} KB`;
    const text = (n: string) =>
      TOOL_DEFS.find((t) => t.name === n)?.description ?? "";
    expect(text("publish_artifact")).toContain(
      `is limited to ${kb}; for more, call create_upload`,
    );
    expect(text("create_upload")).toContain(`over the ${kb} inline limit`);
    const ins = INSTRUCTIONS("free");
    expect(ins).toContain(`limited to ${kb} per call`);
    expect(ins).toContain(
      `limited to ${kb} per call; over it, publish_artifact fails with too_large`,
    );
    // The old inline limit; the Free data-doc limit is also 256 KB, so drop
    // that one phrase first.
    const docFree = `${LIMITS.dataDocBytesFree / 1024} KB`;
    expect(
      JSON.stringify(manifest) +
        ins
          .replaceAll(`${docFree} per document`, "")
          .replaceAll(`data document over ${docFree}`, ""),
    ).not.toMatch(/\b256 KB\b/);
  });

  it("instructions state the plan's data-doc limit", () => {
    expect(INSTRUCTIONS("free")).toContain(
      `${LIMITS.dataDocBytesFree / 1024} KB per document on this instance (free plan; Workers Paid allows ${LIMITS.dataDocBytesPaid / 1024 / 1024} MB)`,
    );
    expect(INSTRUCTIONS("paid")).toContain(
      `${LIMITS.dataDocBytesPaid / 1024 / 1024} MB per document on this instance (paid plan),`,
    );
  });
});

describe("MCP spaces (P3 T10)", () => {
  const SPACES = E({ FEATURES: "spaces", PLAN: "paid" });
  const mkSpace = async (name: string) => {
    const id = newId();
    await env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 1, 1)",
    )
      .bind(id, name)
      .run();
    return id;
  };
  const member = (sid: string, uid: string, role: string) =>
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', 1)",
    )
      .bind(sid, uid, role)
      .run();

  it("MCP publish into a view-only space → 403 space_forbidden; list_spaces omits it", async () => {
    const u = await login(`mcp-sp-${tag}@x.com`);
    const view = await mkSpace(`View ${tag}`);
    const edit = await mkSpace(`Edit ${tag}`);
    await member(view, u.userId, "viewer");
    await member(edit, u.userId, "editor");
    const c = await connect((await createPat(env, u.userId, "sp")).token, {
      env: SPACES,
    });
    const denied = await tool(c, "publish_artifact", {
      title: "no",
      format: "markdown",
      content: "x",
      spaceId: view,
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/^space_forbidden/);
    const listed = sc<{
      items: { id: string; kind: string; myRole: string }[];
    }>(await tool(c, "list_spaces", {}));
    const ids = listed.items.map((s) => s.id);
    expect(ids).toContain(edit);
    expect(ids).not.toContain(view);
    expect(listed.items[0]).toMatchObject({
      id: u.userId,
      kind: "personal",
      myRole: "manager",
    });
    const pub = sc<{ id: string }>(
      await tool(c, "publish_artifact", {
        title: "yes",
        format: "markdown",
        content: "x",
        spaceId: edit,
      }),
    );
    const got = sc<{
      artifact: { space?: { id: string }; can?: { edit: boolean } };
    }>(await tool(c, "get_artifact", { id: pub.id }));
    expect(got.artifact.space).toMatchObject({ id: edit, kind: "shared" });
    expect(got.artifact.can).toMatchObject({ edit: true, move: false });
    await c.close();
  });

  it("spaces off: list_spaces offers the personal space only", async () => {
    const u = await login(`mcp-spoff-${tag}@x.com`);
    const edit = await mkSpace(`Off ${tag}`);
    await member(edit, u.userId, "editor");
    const c = await connect((await createPat(env, u.userId, "off")).token, {
      env: E({ FEATURES: "" }),
    });
    const listed = sc<{ items: { id: string }[] }>(
      await tool(c, "list_spaces", {}),
    );
    expect(listed.items.map((s) => s.id)).toEqual([u.userId]);
    await c.close();
  });

  it("the skill lists list_spaces and the instructions say owner or space manager", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toContain("list_spaces");
    expect(INSTRUCTIONS("free")).toContain("owner or space manager");
  });
});

describe("content revocation (P3 T11)", () => {
  it("with content_revocation, download URLs bind the agent's user; a suspension refuses them", async () => {
    const u = await login(`mcp-rev-${tag}@x.com`);
    const rev = E({ FEATURES: "content_revocation" });
    const c = await connect((await createPat(env, u.userId, "rev")).token, {
      env: rev,
    });
    const { id } = await publishMd(c, "# rev");
    const { downloadUrl } = sc<{ downloadUrl: string }>(
      await tool(c, "get_artifact", { id, includeContent: false }),
    );
    const url = new URL(downloadUrl);
    expect(url.pathname).toMatch(
      new RegExp(`^/c/\\d+\\.${u.userId}\\.\\d+\\.[A-Za-z0-9_-]{43}/${id}/`),
    );
    const get = () =>
      callWorker(new Request(`http://content.localhost${url.pathname}?dl=1`));
    expect((await get()).status).toBe(200);
    await setUserStatus(env, u.userId, "suspended", "admin_suspend", SYSTEM_ACTOR);
    expect((await get()).status).toBe(404);
  });
});

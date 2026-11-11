import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { api, errOf, login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";

// #1100 slice-1 groundwork: "doc" as an artifact format at the data layer.
// A doc is created from Markdown, stored as one Markdown file (doc.md) and
// reported as format "doc". files, entry, language, capabilities and
// dataWriters are refused with the next step; other artifacts never become
// docs; a whole-content publish to a doc is use_edit_doc.

const app = createApp();
let owner: { cookie: string; userId: string };
let client: Client;

beforeAll(async () => {
  owner = await login(`doc-${newId().slice(0, 6).toLowerCase()}@x.com`);
  client = await connect((await createPat(env, owner.userId, "doc")).token);
});
afterAll(async () => {
  await close(client);
});

const post = (path: string, body: unknown) =>
  api(app, path, owner.cookie, { method: "POST", body });
const get = (path: string) => api(app, path, owner.cookie);

const makeDoc = async (body: Record<string, unknown> = {}) => {
  const r = await post(R.artifacts, {
    title: "Notes",
    format: "doc",
    content: "# Goals\n\nShip docs.\n",
    ...body,
  });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; version: number };
};

const versionCount = async (id: string) =>
  ((await (await get(R.versions(id))).json()) as unknown[]).length;

describe("creating a doc", () => {
  it("from Markdown: format doc, one file doc.md, versions are docs", async () => {
    const d = await makeDoc();
    expect(d.version).toBe(1);
    const s = (await (await get(R.artifact(d.id))).json()) as {
      format: string;
    };
    expect(s.format).toBe("doc");
    const vs = (await (await get(R.versions(d.id))).json()) as {
      format: string;
      entry: string;
      files: { path: string }[];
    }[];
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ format: "doc", entry: "doc.md" });
    expect(vs[0]?.files.map((f) => f.path)).toEqual(["doc.md"]);
    const text = await (await get(R.versionFile(d.id, 1, "doc.md"))).text();
    expect(text).toBe("# Goals\n\nShip docs.\n");
  });

  it("with no content: an empty doc", async () => {
    const r = await post(R.artifacts, { title: "Empty", format: "doc" });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(await (await get(R.versionFile(id, 1, "doc.md"))).text()).toBe("");
  });

  it("the list filters docs apart from markdown", async () => {
    const d = await makeDoc();
    const md = await post(R.artifacts, {
      title: "md",
      format: "markdown",
      content: "# md\n",
    });
    const mdId = ((await md.json()) as { id: string }).id;
    const ids = async (format: string) =>
      (
        (await (
          await get(`${R.artifacts}?scope=mine&format=${format}&limit=100`)
        ).json()) as { items: { id: string; format: string }[] }
      ).items;
    const docs = await ids("doc");
    expect(docs.map((a) => a.id)).toContain(d.id);
    expect(docs.map((a) => a.id)).not.toContain(mdId);
    expect(docs.every((a) => a.format === "doc")).toBe(true);
    const mds = await ids("markdown");
    expect(mds.map((a) => a.id)).toContain(mdId);
    expect(mds.map((a) => a.id)).not.toContain(d.id);
  });
});

describe("refusals on a new doc, each with the next step", () => {
  const refused = async (
    body: Record<string, unknown>,
    path: string,
    reason: string,
  ) => {
    const r = await post(R.artifacts, { title: "x", format: "doc", ...body });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.code).toBe("bad_request");
    expect(e.details).toMatchObject({ path, reason });
    return e.message;
  };

  it("files: a doc is one Markdown file", async () => {
    const m = await refused(
      { files: { "a.md": "# a" }, entry: "a.md" },
      "files",
      "doc_one_file",
    );
    expect(m).toMatch(/content with format "doc"/);
  });

  it("entry and language", async () => {
    await refused({ content: "x", entry: "x.md" }, "entry", "doc_entry");
    await refused({ content: "x", language: "md" }, "language", "doc_language");
  });

  it("capabilities", async () => {
    const m = await refused(
      { content: "x", capabilities: { db: true } },
      "capabilities",
      "doc_capabilities",
    );
    expect(m).toMatch(/Leave capabilities out/);
  });

  it("dataWriters and allowAnonymousWrites", async () => {
    await refused(
      { content: "x", dataWriters: "editors" },
      "dataWriters",
      "doc_data_writers",
    );
    await refused(
      { content: "x", allowAnonymousWrites: false },
      "allowAnonymousWrites",
      "doc_data_writers",
    );
  });
});

describe("an existing doc", () => {
  it("a whole-content publish is use_edit_doc and publishes nothing", async () => {
    const d = await makeDoc();
    for (const body of [
      { format: "doc", content: "# New\n" },
      { format: "markdown", content: "# New\n" },
      { files: { "index.html": "<p>x</p>" }, entry: "index.html" },
      { edits: [{ old: "Ship", new: "Land" }] },
    ]) {
      const r = await post(R.versions(d.id), body);
      expect(r.status).toBe(400);
      const e = await errOf(r);
      expect(e.code).toBe("use_edit_doc");
      expect(e.message).toMatch(/edit_doc/);
    }
    expect(await versionCount(d.id)).toBe(1);
  });

  it("PATCH capabilities or dataWriters is refused; title still changes", async () => {
    const d = await makeDoc();
    const patch = (body: unknown) =>
      api(app, R.artifact(d.id), owner.cookie, { method: "PATCH", body });
    const caps = await patch({ capabilities: { storage: true } });
    expect(caps.status).toBe(400);
    expect((await errOf(caps)).details).toMatchObject({
      reason: "doc_capabilities",
    });
    const dw = await patch({ dataWriters: "editors" });
    expect(dw.status).toBe(400);
    expect((await errOf(dw)).details).toMatchObject({
      reason: "doc_data_writers",
    });
    const ok = await patch({ title: "Renamed" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { format: string }).format).toBe("doc");
  });
});

describe("other artifacts never become docs", () => {
  it("format doc with a markdown artifact's id is refused", async () => {
    const md = await post(R.artifacts, {
      title: "md",
      format: "markdown",
      content: "# md\n",
    });
    const { id } = (await md.json()) as { id: string };
    const r = await post(R.versions(id), { format: "doc", content: "# d\n" });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.details).toMatchObject({
      path: "format",
      reason: "doc_conversion",
    });
    expect(e.message).toMatch(/Leave id out to create a new doc/);
    expect(await versionCount(id)).toBe(1);
    const s = (await (await get(R.artifact(id))).json()) as { format: string };
    expect(s.format).toBe("markdown");
  });
});

describe("publish_artifact (MCP)", () => {
  it("creates a doc from Markdown; a whole-content publish is use_edit_doc", async () => {
    const r = await tool(client, "publish_artifact", {
      title: "Plan",
      format: "doc",
      content: "# Plan\n",
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const { id } = r.structuredContent as { id: string };
    const again = await tool(client, "publish_artifact", {
      id,
      format: "doc",
      content: "# Plan 2\n",
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/^use_edit_doc: /);
    const settings = await tool(client, "publish_artifact", {
      id,
      dataWriters: "editors",
    });
    expect(settings.isError).toBe(true);
    expect(textOf(settings)).toMatch(/dataWriters doesn't apply/);
    const renamed = await tool(client, "publish_artifact", {
      id,
      title: "Plan B",
    });
    expect(renamed.isError, textOf(renamed)).toBeFalsy();
  });

  it("files on a new doc are refused with the next step", async () => {
    const r = await tool(client, "publish_artifact", {
      title: "Plan",
      format: "doc",
      files: { "a.md": "# a" },
      entry: "a.md",
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/A doc is one Markdown file/);
  });
});

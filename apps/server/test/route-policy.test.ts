import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import {
  CONTENT_POLICY,
  type Policy,
  ROUTE_POLICY,
  TOOL_POLICY,
} from "../src/auth/route-policy.js";
import { contentApp } from "../src/content/app.js";
import manifest from "../src/mcp/tool-manifest.json";
import { api, login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// P3 T5: every route and tool has a policy, enforced before its handler.

type Route = { method: string; path: string; handler: { length: number } };
/** Answering routes only (middleware are ALL routes taking (c, next)). */
const answering = (routes: readonly Route[]) => [
  ...new Set(
    routes
      .filter((r) => !(r.method === "ALL" && r.handler.length >= 2))
      .map((r) => `${r.method} ${r.path}`),
  ),
];
const app = createApp();

describe("policy coverage", () => {
  it("every mounted app route has a policy, and every policy a route", () => {
    const keys = answering(app.routes as Route[]);
    expect(keys.filter((k) => !(k in ROUTE_POLICY))).toEqual([]);
    expect(Object.keys(ROUTE_POLICY).filter((k) => !keys.includes(k))).toEqual(
      [],
    );
  });
  it("every content-host route has a policy, and every policy a route", () => {
    const keys = answering(contentApp.routes as Route[]);
    expect(keys.filter((k) => !(k in CONTENT_POLICY))).toEqual([]);
    expect(
      Object.keys(CONTENT_POLICY).filter((k) => !keys.includes(k)),
    ).toEqual([]);
  });
  it("TOOL_POLICY matches tool-manifest.json exactly", () => {
    expect(Object.keys(TOOL_POLICY).sort()).toEqual(
      manifest.map((t) => t.name).sort(),
    );
  });
  it("an unlisted route answers 404 even when mounted", async () => {
    const a = createApp((x) => {
      x.get("/api/v1/unlisted", (c) => c.json({ leaked: true }));
    });
    const r = await api(a as never, "/api/v1/unlisted", null);
    expect(r.status).toBe(404);
  });
});

/** A concrete path for a route pattern. */
const fill = (path: string, id: string) =>
  path
    .replace(":id", id)
    .replace(":v", "1")
    .replace(":col", "c")
    .replace(":doc", "d")
    .replace(":key", "k")
    .replace(":email", "x%40y.com")
    .replace(":grantId", "g")
    .replace("*", "index.html");
const isOpen = (p: Policy) => "public" in p || "signed" in p;
const send = (
  a: typeof app,
  method: string,
  path: string,
  auth: string | null,
) =>
  api(a as never, path, auth, {
    method: method === "ALL" ? "POST" : method,
    body: method === "GET" || method === "HEAD" ? undefined : {},
  });

describe("enforcement", () => {
  const tag = newId().slice(0, 6).toLowerCase();
  let ownerCookie: string;
  let strangerCookie: string;
  let strangerPat: string;
  let id: string;
  beforeAll(async () => {
    const owner = await login(`rp-owner-${tag}@x.com`);
    ownerCookie = owner.cookie;
    const stranger = await login(`rp-stranger-${tag}@x.com`);
    strangerCookie = stranger.cookie;
    strangerPat = (await createPat(env, stranger.userId, "rp")).token;
    const r = await api(app as never, R.artifacts, ownerCookie, {
      method: "POST",
      body: {
        title: "Private",
        format: "html",
        content: "<p>x",
        capabilities: { db: true, storage: true },
      },
    });
    id = ((await r.json()) as { id: string }).id;
  });

  const guarded = Object.entries(ROUTE_POLICY).filter(([, p]) => !isOpen(p));
  it.each(guarded)("anonymous %s → 401 or 404", async (key) => {
    const [method, path] = key.split(" ") as [string, string];
    const r = await send(app, method, fill(path, id), null);
    expect([401, 404]).toContain(r.status);
  });

  const artifactRoutes = guarded.filter(([, p]) => "artifact" in p);
  it.each(artifactRoutes)(
    "a logged-in non-member gets 404 on %s",
    async (key) => {
      const [method, path] = key.split(" ") as [string, string];
      const r = await send(app, method, fill(path, id), strangerCookie);
      expect(r.status).toBe(404);
    },
  );

  const artifactTools = Object.entries(TOOL_POLICY).filter(
    ([, p]) => "artifact" in p,
  );
  it.each(artifactTools)("a non-member's %s → not_found", async (name) => {
    const c = await connect(strangerPat);
    const args: Record<string, unknown> = { id };
    if (name === "restore_version") args.version = 1;
    if (name === "share_artifact")
      Object.assign(args, { email: "z@y.com", role: "viewer" });
    if (name === "unshare_artifact") args.email = "z@y.com";
    if (name === "set_visibility") args.visibility = "public";
    if (name === "add_comment") args.body = "hi";
    if (name === "resolve_comment") args.threadId = "AAAAAAAAAAAAAAAA";
    if (name.startsWith("artifact_data_"))
      Object.assign(args, { collection: "c" });
    if (
      [
        "artifact_data_get",
        "artifact_data_set",
        "artifact_data_update",
        "artifact_data_delete",
      ].includes(name)
    )
      args.docId = "d";
    if (name === "artifact_data_set") args.data = {};
    if (name === "artifact_data_update") args.patch = {};
    if (name === "artifact_data_query") args.query = {};
    expect(textOf(await tool(c, name, args))).toMatch(/^not_found/);
  });

  it("the owner still reaches every artifact read route (gate reuses the row)", async () => {
    for (const p of [R.artifact(id), R.versions(id), R.shares(id)]) {
      const r = await api(app as never, p, ownerCookie);
      expect(r.status, p).toBe(200);
    }
  });
});

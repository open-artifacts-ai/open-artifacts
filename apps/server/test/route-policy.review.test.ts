import { env } from "cloudflare:workers";
import { type ListQuery, type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type Caller, callerOf, withCap } from "../src/auth/authz.js";
import { isPubliclyServable } from "../src/auth/policy.js";
import {
  enforce,
  isMiddleware,
  ROUTE_POLICY,
} from "../src/auth/route-policy.js";
import { getDb } from "../src/db/client.js";
import { artifacts, shares } from "../src/db/schema.js";
import { ApiError } from "../src/http/errors.js";
import { createServer } from "../src/mcp/server.js";
import { list } from "../src/services/artifacts.js";
import { createUpload } from "../src/services/uploads.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// The #367/#374 security review (M1-M3, L1-L7): the cap reaches every gate.

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: Member;
let viewer: Member;
let viewerCookie: string;
let dataId: string;
let teamId: string;
const ARTS = "/api/v1/artifacts/:id";
const capped = (m: Member): Caller => callerOf(withCap({ ...m }, "restricted"));
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof ApiError ? e.code : String(e)),
  );

beforeAll(async () => {
  const o = await login(`rv-owner-${tag}@x.com`);
  owner = (await getUser(env, o.userId)) as Member;
  const v = await login(`rv-viewer-${tag}@x.com`);
  viewerCookie = v.cookie;
  viewer = (await getUser(env, v.userId)) as Member;
  const now = Date.now();
  const mk = async (visibility: string) => {
    const id = newId();
    await getDb(env)
      .insert(artifacts)
      .values({
        id,
        ownerId: owner.id,
        spaceId: owner.id,
        title: `rv-${visibility}`,
        format: "html",
        visibility,
        capabilities: '{"db":true,"viewer":false,"storage":true}',
        // #681: "viewers" needs both columns, as publish writes them.
        dataWriters: "viewers",
        allowAnonymousWrites: 1,
        createdAt: now,
        updatedAt: now,
      });
    return id;
  };
  dataId = await mk("private");
  teamId = await mk("team");
  await getDb(env)
    .insert(shares)
    .values({
      artifactId: dataId,
      email: `rv-viewer-${tag}@x.com`,
      role: "viewer",
      createdBy: owner.id,
      createdAt: now,
    });
});

describe("L1: the gate runs first", () => {
  it("only tagged middleware precede the gate", () => {
    const routes = app.routes as { handler: object }[];
    const gate = routes.findIndex((r, i) => i > 0 && isMiddleware(r.handler));
    expect(gate).toBe(1);
    expect(routes.slice(0, gate).every((r) => isMiddleware(r.handler))).toBe(
      true,
    );
  });
  it("an unlisted route is 404 before CSRF or body checks", async () => {
    const a = createApp((x) => {
      x.post("/api/v1/unlisted", (c) => c.json({ leaked: true }));
    });
    const r = await api(a as never, "/api/v1/unlisted", viewerCookie, {
      method: "POST",
      headers: { "x-oa-request": "" },
      body: {},
    });
    expect(r.status).toBe(404);
  });
});

describe("M2: REST gates match MCP", () => {
  const P = (k: string) => ROUTE_POLICY[k];
  it("data writes and storage refuse a capped viewer", async () => {
    for (const k of [
      `PUT ${ARTS}/data/:col/:doc`,
      `PATCH ${ARTS}/data/:col/:doc`,
      `DELETE ${ARTS}/data/:col/:doc`,
      `PUT ${ARTS}/storage/:key`,
      `GET ${ARTS}/storage`,
    ])
      expect(
        await code(enforce(P(k), capped(viewer), env, () => dataId)),
        k,
      ).toBe("not_found");
  });
  it("an uncapped viewer passes the write floor", async () => {
    expect(
      await code(
        enforce(
          P(`PUT ${ARTS}/data/:col/:doc`),
          callerOf(viewer),
          env,
          () => dataId,
        ),
      ),
    ).toBe("ok");
  });
  it("a capped viewer can't set even a first thumbnail", async () => {
    expect(
      await code(
        enforce(P(`PUT ${ARTS}/thumbnail`), capped(viewer), env, () => dataId),
      ),
    ).toBe("not_found");
  });
  it("anonymous on a private artifact: 404 (no 401 leak of existence)", async () => {
    const r = await api(app as never, R.dataDoc(dataId, "c", "d"), null, {
      method: "PUT",
      body: {},
    });
    expect(r.status).toBe(404);
  });
});

describe("M3: capped callers don't list team artifacts", () => {
  it("team titles never reach a capped member", async () => {
    const q = { scope: "all", limit: 100, includeDeleted: false } as ListQuery;
    const open = (await list(env, callerOf(viewer), q)).items.map((a) => a.id);
    const shut = (await list(env, capped(viewer), q)).items.map((a) => a.id);
    expect(open).toContain(teamId);
    expect(shut).not.toContain(teamId);
    expect(shut).toContain(dataId); // still through the share
  });
});

describe("L2: MCP tools are enforced at dispatch", () => {
  it("a tool registered without a policy can't run", async () => {
    const server = createServer({
      env,
      user: viewer,
      sessionEpoch: 0,
      agent: null,
    });
    server.registerTool("evil_tool", { description: "x" }, async () => ({
      content: [{ type: "text", text: "leaked" }],
    }));
    const d = server as unknown as {
      _registeredTools: Record<string, unknown>;
      executeToolHandler: (
        t: unknown,
        a: unknown,
        c: unknown,
      ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    };
    const r = await d.executeToolHandler(d._registeredTools.evil_tool, {}, {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("leaked");
  });
});

describe("L5, L6, L7", () => {
  it("L5: a capped caller can't reserve an upload", async () => {
    expect(
      await code(
        createUpload(env, withCap({ ...viewer }, "restricted"), {
          path: "a.txt",
          size: 3,
          contentType: "text/plain",
        } as never),
      ),
    ).toBe("space_forbidden");
  });
  it("L6: isPubliclyServable", () => {
    expect(isPubliclyServable({ visibility: "public", deleted: false })).toBe(
      true,
    );
    expect(isPubliclyServable({ visibility: "public", deleted: true })).toBe(
      false,
    );
    expect(isPubliclyServable({ visibility: "team", deleted: false })).toBe(
      false,
    );
    // A space's public-links toggle is not an input: it only refuses new
    // public links (see list.spaces.test.ts for the toggle end to end).
  });
  it("L7: a malformed :id is 404 before D1", async () => {
    expect(
      await code(
        enforce(
          ROUTE_POLICY[`GET ${ARTS}`],
          callerOf(viewer),
          env,
          () => "../../x",
        ),
      ),
    ).toBe("not_found");
  });
});

describe("L6: content-url mints unsigned only via isPubliclyServable", () => {
  it("public artifact → unsigned /p/ URL; private shared → signed URL", async () => {
    const pub = await api(app as never, R.artifacts, viewerCookie, {
      method: "POST",
      body: {
        title: "pub",
        format: "html",
        content: "<p>x",
        visibility: "public",
      },
    });
    const id = ((await pub.json()) as { id: string }).id;
    const u = (await (
      await api(app as never, R.contentUrl(id), null)
    ).json()) as { url: string; expiresAt: string | null };
    expect(u.url).toContain("/p/");
    expect(u.expiresAt).toBeNull();
    const priv = await api(app as never, R.artifacts, viewerCookie, {
      method: "POST",
      body: { title: "priv", format: "html", content: "<p>x" },
    });
    const pid = ((await priv.json()) as { id: string }).id;
    const s = (await (
      await api(app as never, R.contentUrl(pid), viewerCookie)
    ).json()) as { url: string; expiresAt: string | null };
    expect(s.url).toContain("/c/");
    expect(s.expiresAt).not.toBeNull();
  });
});

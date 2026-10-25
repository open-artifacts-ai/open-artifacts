import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiErrorSchema,
  ArtifactSummarySchema,
  ContentUrlSchema,
  DataDocSchema,
  INLINE_TOO_LARGE_MESSAGE,
  LIMITS,
  MemberSchema,
  MeSchema,
  OAuthClientSchema,
  PageSchema,
  PublishResultSchema,
  QUOTA_MESSAGE,
  R,
  SearchHitSchema,
  SettingsSchema,
  ShareSchema,
  SNIPPET_MARK,
  StorageEntrySchema,
  StorageKeySchema,
  StorageSetBodySchema,
  TokenCreatedSchema,
  TokenSchema,
  UploadCreatedSchema,
  UsageSchema,
  VERSIONS_PAGE_SIZE,
  VersionInfoSchema,
  viewerPath,
} from "../src/index.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
const fresh = (o?: Parameters<typeof createHandlers>[0]) =>
  server.use(...createHandlers(o));

const O = "http://localhost";
const H: Record<string, string> = {
  "content-type": "application/json",
  "x-oa-request": "1",
  cookie: "s=1",
};
const call = (method: string, path: string, body?: unknown, headers = H) =>
  fetch(`${O}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as any;

const by = (f: (a: (typeof fixtures.artifacts)[number]) => boolean) =>
  fixtures.artifacts.find(f) as (typeof fixtures.artifacts)[number];
const art = fixtures.artifacts[0] as (typeof fixtures.artifacts)[number];
const pdf = by((a) => a.format === "pdf");
const poll = by((a) => a.capabilities.db);
const pub = by((a) => a.visibility === "public");
const guide = by((a) => a.access === "viewer");
const ID = art.id;
const bad = "1111111111111111";
const member = fixtures.members[1]?.id as string;

const Err = ApiErrorSchema;
const publish = { title: "T", format: "markdown", content: "hi" };
type Row = [string, string, string, unknown, number, z.ZodType | null];
const rows: Row[] = [
  ["me", "GET", R.me, undefined, 200, MeSchema],
  ["me", "PATCH", R.me, { displayName: "  Ada  " }, 200, MeSchema],
  [
    "artifacts",
    "GET",
    R.artifacts,
    undefined,
    200,
    PageSchema(ArtifactSummarySchema),
  ],
  ["artifacts", "POST", R.artifacts, publish, 201, PublishResultSchema],
  ["artifact", "GET", R.artifact(ID), undefined, 200, ArtifactSummarySchema],
  [
    "artifact",
    "PATCH",
    R.artifact(ID),
    { title: "N" },
    200,
    ArtifactSummarySchema,
  ],
  [
    "restoreDeleted",
    "POST",
    R.restoreDeleted(ID),
    undefined,
    200,
    ArtifactSummarySchema,
  ],
  [
    "versions",
    "GET",
    R.versions(ID),
    undefined,
    200,
    z.array(VersionInfoSchema),
  ],
  [
    "versions",
    "POST",
    R.versions(ID),
    { id: ID, ...publish },
    201,
    PublishResultSchema,
  ],
  [
    "versionFile",
    "GET",
    R.versionFile(ID, 1, "index.html"),
    undefined,
    200,
    null,
  ],
  [
    "restoreVersion",
    "POST",
    R.restoreVersion(ID, 1),
    undefined,
    201,
    PublishResultSchema,
  ],
  ["versionText", "PUT", R.versionText(pdf.id, 1), undefined, 204, null],
  ["thumbnail", "GET", R.thumbnail(ID), undefined, 200, null],
  ["thumbnail", "PUT", R.thumbnail(ID), undefined, 204, null],
  ["contentUrl", "GET", R.contentUrl(ID), undefined, 200, ContentUrlSchema],
  ["shares", "GET", R.shares(ID), undefined, 200, z.array(ShareSchema)],
  [
    "shares",
    "PUT",
    R.shares(ID),
    { email: "c@example.com", role: "editor" },
    200,
    ShareSchema,
  ],
  ["share", "DELETE", R.share(ID, "bob@example.com"), undefined, 204, null],
  [
    "uploads",
    "POST",
    R.uploads,
    { path: "a.bin", size: 5 },
    201,
    UploadCreatedSchema,
  ],
  ["upload", "PUT", R.upload("abc"), undefined, 204, null],
  [
    "search",
    "GET",
    `${R.search}?q=page`,
    undefined,
    200,
    PageSchema(SearchHitSchema),
  ],
  ["members", "GET", R.members, undefined, 200, z.array(MemberSchema)],
  [
    "members",
    "POST",
    R.members,
    { email: "n@example.com", role: "member" },
    201,
    MemberSchema,
  ],
  ["member", "PATCH", R.member(member), { role: "admin" }, 200, MemberSchema],
  ["member", "DELETE", R.member(member), undefined, 204, null],
  ["tokens", "GET", R.tokens, undefined, 200, z.array(TokenSchema)],
  ["tokens", "POST", R.tokens, { label: "ci" }, 201, TokenCreatedSchema],
  [
    "token",
    "PATCH",
    R.token(fixtures.tokens[0]?.id as string),
    { label: "work laptop" },
    200,
    TokenSchema,
  ],
  [
    "token",
    "DELETE",
    R.token(fixtures.tokens[0]?.id as string),
    undefined,
    204,
    null,
  ],
  [
    "oauthClients",
    "GET",
    R.oauthClients,
    undefined,
    200,
    z.array(OAuthClientSchema),
  ],
  [
    "oauthClient",
    "PATCH",
    R.oauthClient(fixtures.oauthClients[0]?.grantId as string),
    { label: "Claude on my laptop" },
    200,
    OAuthClientSchema,
  ],
  [
    "oauthClient",
    "DELETE",
    R.oauthClient(fixtures.oauthClients[0]?.grantId as string),
    undefined,
    204,
    null,
  ],
  ["settings", "GET", R.settings, undefined, 200, SettingsSchema],
  ["settings", "PATCH", R.settings, { name: "X" }, 200, SettingsSchema],
  ["usage", "GET", R.usage, undefined, 200, UsageSchema],
  [
    "dataCollection",
    "GET",
    R.dataCollection(poll.id, "votes"),
    undefined,
    200,
    PageSchema(DataDocSchema),
  ],
  [
    "dataQuery",
    "POST",
    R.dataQuery(poll.id, "votes"),
    {},
    200,
    PageSchema(DataDocSchema),
  ],
  [
    "dataDoc",
    "GET",
    R.dataDoc(poll.id, "votes", "v1"),
    undefined,
    200,
    DataDocSchema,
  ],
  [
    "dataDoc",
    "PUT",
    R.dataDoc(poll.id, "votes", "v2"),
    { a: 1 },
    200,
    DataDocSchema,
  ],
  [
    "dataDoc",
    "PATCH",
    R.dataDoc(poll.id, "votes", "v1"),
    { b: 2 },
    200,
    DataDocSchema,
  ],
  [
    "dataDoc",
    "DELETE",
    R.dataDoc(poll.id, "votes", "v1"),
    undefined,
    204,
    null,
  ],
  [
    "dataSubscribe",
    "GET",
    R.dataSubscribe(poll.id, "votes"),
    undefined,
    426,
    null,
  ],
  [
    "storage",
    "GET",
    R.storage(poll.id),
    undefined,
    200,
    PageSchema(StorageKeySchema),
  ],
  [
    "storageKey",
    "GET",
    R.storageKey(poll.id, "theme"),
    undefined,
    200,
    StorageEntrySchema,
  ],
  [
    "storageKey",
    "PUT",
    R.storageKey(poll.id, "k"),
    { value: 1 },
    200,
    StorageEntrySchema,
  ],
  [
    "storageKey",
    "DELETE",
    R.storageKey(poll.id, "theme"),
    undefined,
    204,
    null,
  ],
];

describe("emailEnabled option", () => {
  it("defaults to false; createHandlers({ emailEnabled: true }) flips it", async () => {
    fresh();
    expect((await json(await call("GET", R.me))).instance.emailEnabled).toBe(
      false,
    );
    fresh({ emailEnabled: true });
    expect((await json(await call("GET", R.me))).instance.emailEnabled).toBe(
      true,
    );
  });
});

describe("plan option", () => {
  it('me and usage default to "free"; createHandlers({ plan: "paid" }) gives Paid', async () => {
    fresh();
    const free = UsageSchema.parse(await json(await call("GET", R.usage)));
    expect(free.plan).toBe("free");
    expect((await json(await call("GET", R.me))).instance.plan).toBe("free");
    expect(free.metrics.find((m) => m.key === "requests")?.limit).toBe(100_000);
    fresh({ plan: "paid" });
    const paid = UsageSchema.parse(await json(await call("GET", R.usage)));
    expect(paid.plan).toBe("paid");
    for (const m of paid.metrics) expect(m.limit).toBe(0);
    expect((await json(await call("GET", R.me))).instance.plan).toBe("paid");
  });
});

describe("update option", () => {
  it("defaults to null; createHandlers({ update }) sets it", async () => {
    fresh();
    expect((await json(await call("GET", R.me))).instance.update).toBeNull();
    const update = {
      latestVersion: "0.4.0",
      current: "0.3.0",
      custom: false,
      updateAvailable: true,
      breaking: false,
      notesUrl:
        "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v0.4.0",
      checkedAt: "2026-10-20T00:00:00.000Z",
    };
    fresh({ update });
    const me = MeSchema.parse(await json(await call("GET", R.me)));
    expect(me.instance.update).toEqual(update);
  });
});

describe("fixtures", () => {
  it("parse with their schemas and cover the brief", () => {
    MeSchema.parse(fixtures.me);
    for (const a of fixtures.artifacts) ArtifactSummarySchema.parse(a);
    for (const vs of Object.values(fixtures.versions))
      for (const v of vs) VersionInfoSchema.parse(v);
    for (const m of fixtures.members) MemberSchema.parse(m);
    for (const d of fixtures.data) DataDocSchema.parse(d.doc);
    const a = fixtures.artifacts;
    for (const f of ["html", "markdown", "code", "pdf"])
      expect(a.some((x) => x.format === f)).toBe(true);
    expect(a.some((x) => x.visibility === "public")).toBe(true);
    expect(a.some((x) => x.access !== "owner")).toBe(true);
    expect(a.some((x) => x.capabilities.db)).toBe(true);
  });
  it("is consistent", () => {
    expect(fixtures.versions[guide.id]?.[0]?.createdBy.id).toBe(guide.owner.id);
    for (const x of fixtures.artifacts)
      if (x.allowAnonymousWrites) expect(x.visibility).toBe("public");
  });
});

describe("every route", () => {
  for (const [name, method, path, body, status, schema] of rows) {
    it(`${method} ${name}: ${path}`, async () => {
      fresh();
      const r = await call(method, path, body);
      expect(r.status).toBe(status);
      if (schema) schema.parse(await r.json());
    });
    it(`quota ${method} ${name}`, async () => {
      fresh({ quotaExceeded: true });
      const r = await call(method, path, body);
      expect(r.status).toBe(503);
      const e = Err.parse(await r.json());
      expect(e.error.code).toBe("quota_exceeded");
      expect(e.error.message).toBe(QUOTA_MESSAGE);
    });
  }
});

describe("validation", () => {
  it("POST artifacts {} -> 400 ApiError", async () => {
    fresh();
    const r = await call("POST", R.artifacts, {});
    expect(r.status).toBe(400);
    Err.parse(await r.json());
  });
  it.each([
    ["PUT", R.shares(ID), { email: "x", role: "viewer" }],
    ["POST", R.members, { email: "a@b.co", role: "owner" }],
    ["PATCH", R.member(member), { role: "guest" }],
    ["POST", R.tokens, { label: "" }],
    ["PATCH", R.token(fixtures.tokens[0]?.id as string), { label: null }],
    ["PATCH", R.token(fixtures.tokens[0]?.id as string), { label: "\u202e" }],
    [
      "PATCH",
      R.oauthClient(fixtures.oauthClients[0]?.grantId as string),
      { label: "x".repeat(61) },
    ],
    [
      "PATCH",
      R.oauthClient(fixtures.oauthClients[0]?.grantId as string),
      { label: "ok", clientName: "spoof" },
    ],
    ["POST", R.versions(ID), {}],
  ])("%s %s bad body -> 400", async (m, p, b) => {
    fresh();
    expect((await call(m, p, b)).status).toBe(400);
  });
  it("PUT dataDoc with invalid JSON -> 400", async () => {
    fresh();
    const r = await fetch(`${O}${R.dataDoc(poll.id, "votes", "z")}`, {
      method: "PUT",
      headers: H,
      body: "{nope",
    });
    expect(r.status).toBe(400);
  });
});

describe("not found", () => {
  it.each([
    ["GET", R.artifact(bad)],
    ["PATCH", R.member(bad)],
    ["DELETE", R.member(bad)],
    ["DELETE", R.token(bad)],
    ["PATCH", R.token(bad)],
    ["DELETE", R.oauthClient(bad)],
    ["PATCH", R.oauthClient(bad)],
    ["DELETE", R.share(ID, "nobody@example.com")],
    ["GET", R.versions(bad)],
  ])("%s %s -> 404 not_found", async (m, p) => {
    fresh();
    const patch = p.startsWith(R.members) ? { role: "admin" } : { label: "x" };
    const r = await call(m, p, m === "PATCH" ? patch : undefined);
    expect(r.status).toBe(404);
    expect(Err.parse(await r.json()).error.code).toBe("not_found");
  });
});

describe("agent labels", () => {
  const grant = fixtures.oauthClients[0]?.grantId as string;
  it("PATCH oauthClient strips controls, trims, lists it, and null clears it", async () => {
    fresh();
    const set = await json(
      await call("PATCH", R.oauthClient(grant), {
        label: " \u202eMy\u200b box ",
      }),
    );
    expect(set.label).toBe("My box");
    const listed = await json(await call("GET", R.oauthClients));
    expect(listed[0].label).toBe("My box");
    const cleared = await json(
      await call("PATCH", R.oauthClient(grant), { label: null }),
    );
    expect(cleared).not.toHaveProperty("label");
    expect(OAuthClientSchema.parse(cleared).clientName).toBe(
      "Example MCP client",
    );
  });
  it("PATCH token sets its label", async () => {
    fresh();
    const id = fixtures.tokens[0]?.id as string;
    await call("PATCH", R.token(id), { label: "ci" });
    const listed = await json(await call("GET", R.tokens));
    expect(listed[0].label).toBe("ci");
  });
});

describe("state", () => {
  it("mutations are reflected and isolated per createHandlers()", async () => {
    fresh();
    await call("PATCH", R.artifact(ID), { title: "Renamed" });
    expect((await json(await call("GET", R.artifact(ID)))).title).toBe(
      "Renamed",
    );
    await call("DELETE", R.artifact(ID));
    expect((await call("GET", R.artifact(ID))).status).toBe(404);
    const all = await json(
      await call("GET", `${R.artifacts}?includeDeleted=true`),
    );
    expect(all.items.some((a: any) => a.id === ID)).toBe(true);
    const live = await json(await call("GET", R.artifacts));
    expect(live.items.some((a: any) => a.id === ID)).toBe(false);
    await call("POST", R.restoreDeleted(ID));
    expect((await call("GET", R.artifact(ID))).status).toBe(200);
    server.resetHandlers();
    fresh();
    expect((await json(await call("GET", R.artifact(ID)))).title).toBe(
      art.title,
    );
  });
  it("versions, shares, members, tokens, data, storage persist", async () => {
    fresh();
    const v = await json(
      await call("POST", R.versions(ID), { id: ID, ...publish }),
    );
    expect(v.version).toBe((fixtures.versions[ID]?.length ?? 0) + 1);
    expect((await json(await call("GET", R.versions(ID)))).length).toBe(
      v.version,
    );
    expect((await json(await call("GET", R.artifact(ID)))).currentVersion).toBe(
      v.version,
    );
    await call("PUT", R.shares(ID), { email: "c@example.com", role: "viewer" });
    await call("PUT", R.shares(ID), { email: "c@example.com", role: "editor" });
    const sh = await json(await call("GET", R.shares(ID)));
    expect(sh.filter((s: any) => s.email === "c@example.com")).toMatchObject([
      { role: "editor" },
    ]);
    await call("DELETE", R.share(ID, "c@example.com"));
    expect(
      (await json(await call("GET", R.shares(ID)))).some(
        (s: any) => s.email === "c@example.com",
      ),
    ).toBe(false);
    const m = await json(
      await call("POST", R.members, { email: "n@example.com", role: "member" }),
    );
    expect(
      (await json(await call("GET", R.members))).some(
        (x: any) => x.id === m.id,
      ),
    ).toBe(true);
    const t = await json(await call("POST", R.tokens, { label: "ci" }));
    await call("DELETE", R.token(t.id));
    expect(
      (await json(await call("GET", R.tokens))).some((x: any) => x.id === t.id),
    ).toBe(false);
    await call("PUT", R.dataDoc(poll.id, "votes", "n1"), { a: 1 });
    await call("PATCH", R.dataDoc(poll.id, "votes", "n1"), { b: 2 });
    expect(
      (await json(await call("GET", R.dataDoc(poll.id, "votes", "n1")))).data,
    ).toEqual({ a: 1, b: 2 });
    await call("PUT", R.storageKey(poll.id, "k"), { value: "v" });
    expect(
      (await json(await call("GET", R.storageKey(poll.id, "k")))).value,
    ).toBe("v");
    expect(
      (await json(await call("GET", R.storage(poll.id)))).items.some(
        (e: any) => e.key === "k",
      ),
    ).toBe(true);
  });
});

describe("list query", () => {
  const ids = async (qs: string, path: string = R.artifacts) =>
    (await json(await call("GET", `${path}${qs}`))).items.map((a: any) => a.id);
  it("scope, format, q, agent", async () => {
    fresh();
    expect(await ids("?scope=shared")).toEqual(
      fixtures.artifacts.filter((a) => a.access !== "owner").map((a) => a.id),
    );
    expect(await ids("?scope=mine")).toEqual(
      fixtures.artifacts
        .filter((a) => a.owner.id === fixtures.me.user.id)
        .map((a) => a.id),
    );
    expect(await ids("?scope=team")).toEqual(
      fixtures.artifacts
        .filter((a) => a.visibility === "team")
        .map((a) => a.id),
    );
    expect(await ids("?format=pdf")).toEqual([pdf.id]);
    expect(await ids("?q=Q4")).toEqual([pdf.id]);
    expect(await ids("?agent=nobody")).toEqual([]);
    expect(await ids("?q=Q4", R.search)).toEqual([pdf.id]);
  });
  it("limit + cursor", async () => {
    fresh();
    const p1 = await json(await call("GET", `${R.artifacts}?limit=2`));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await json(
      await call(
        "GET",
        `${R.artifacts}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
      ),
    );
    expect(p2.items[0].id).toBe(fixtures.artifacts[2]?.id);
  });
});

describe("misc rules", () => {
  it("content-url: public has null expiry, private has one", async () => {
    fresh();
    expect(
      (await json(await call("GET", R.contentUrl(pub.id)))).expiresAt,
    ).toBeNull();
    expect(
      (await json(await call("GET", R.contentUrl(guide.id)))).expiresAt,
    ).toBeTruthy();
  });
  it("CSRF: cookie without header -> 403 csrf; Bearer without header passes", async () => {
    fresh();
    const r = await call(
      "PATCH",
      R.artifact(ID),
      { title: "x" },
      { "content-type": "application/json", cookie: "oa_session=1" },
    );
    expect(r.status).toBe(403);
    expect(Err.parse(await r.json()).error.code).toBe("csrf");
    expect(
      (
        await call(
          "PATCH",
          R.artifact(ID),
          { title: "x" },
          { "content-type": "application/json", authorization: "Bearer x" },
        )
      ).status,
    ).toBe(200);
  });
});

const text = async (r: Response) => await r.text();

describe("round 3", () => {
  it("storage PUT rejects unknown keys; POST with unknown client id and no title -> 400", async () => {
    fresh();
    expect(
      (await call("PUT", R.storageKey(poll.id, "k"), { value: 1, x: 1 }))
        .status,
    ).toBe(400);
    const r = await call("POST", R.artifacts, {
      id: "1111111111111111",
      format: "html",
      content: "x",
    });
    expect(r.status).toBe(400);
    expect(Err.parse(await r.json()).error.code).toBe("bad_request");
  });
});

describe("round 2", () => {
  it("version files differ per version; unknown path 404", async () => {
    fresh();
    const v1 = await text(
      await call("GET", R.versionFile(art.id, 1, "index.html")),
    );
    const v2 = await text(
      await call("GET", R.versionFile(art.id, 2, "index.html")),
    );
    expect(v1).not.toBe(v2);
    expect(
      (await call("GET", R.versionFile(art.id, 1, "style.css"))).status,
    ).toBe(404);
    expect(
      (await call("GET", R.versionFile(art.id, 2, "style.css"))).status,
    ).toBe(200);
    expect(
      (await call("GET", R.versionFile(art.id, 9, "index.html"))).status,
    ).toBe(404);
  });
  it("GET thumbnail serves webp for fixtures with a thumbnailUrl", async () => {
    fresh();
    const r = await call("GET", R.thumbnail(art.id));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    const b = new Uint8Array(await r.arrayBuffer());
    expect(String.fromCharCode(...b.slice(0, 4))).toBe("RIFF");
    expect((await call("GET", R.thumbnail(pdf.id))).status).toBe(404);
  });
  it("PATCH missing data doc upserts", async () => {
    fresh();
    const r = await call("PATCH", R.dataDoc(poll.id, "votes", "fresh"), {
      a: 1,
    });
    expect(r.status).toBe(200);
    expect(
      (await json(await call("GET", R.dataDoc(poll.id, "votes", "fresh"))))
        .data,
    ).toEqual({ a: 1 });
    expect(
      (await call("PUT", R.dataDoc(poll.id, "bad.col", "x"), {})).status,
    ).toBe(400);
  });
  it("restoreVersion copies files/entry with message; publish url has no version", async () => {
    fresh();
    const r = await json(await call("POST", R.restoreVersion(art.id, 1)));
    expect(r.url).toBe(fixtures.me.instance.appUrl + viewerPath(art.id));
    const vs = await json(await call("GET", R.versions(art.id)));
    const top = vs[0];
    const src = vs.find((v: { version: number }) => v.version === 1);
    expect(top.message).toBe("Restored v1");
    expect(top.files).toEqual(src.files);
    expect(top.entry).toBe(src.entry);
    expect(top.format).toBe(src.format);
    expect(
      await text(
        await call("GET", R.versionFile(art.id, top.version, "index.html")),
      ),
    ).toBe(
      await text(await call("GET", R.versionFile(art.id, 1, "index.html"))),
    );
  });
  it("C3: inline content over 128 KB → 413 too_large with the upload hint", async () => {
    fresh();
    const r = await call("POST", R.artifacts, {
      title: "big",
      format: "html",
      content: "x".repeat(LIMITS.inlineBytes + 1),
    });
    expect(r.status).toBe(413);
    expect((await json(r)).error).toEqual({
      code: "too_large",
      message: INLINE_TOO_LARGE_MESSAGE,
    });
  });
  it("publish builds VersionInfo from files/entry", async () => {
    fresh();
    await call("POST", R.versions(art.id), {
      id: art.id,
      files: { "a.md": "hello", "b/c.txt": "x" },
      entry: "a.md",
      message: "m",
    });
    const top = (await json(await call("GET", R.versions(art.id))))[0];
    expect(top.entry).toBe("a.md");
    expect(top.files.map((f: any) => f.path).sort()).toEqual([
      "a.md",
      "b/c.txt",
    ]);
    expect(top.files.find((f: any) => f.path === "a.md").size).toBe(5);
  });
  it("shares lowercase and reject owner; owner member protected", async () => {
    fresh();
    const s = await json(
      await call("PUT", R.shares(ID), {
        email: "Carol@Example.com",
        role: "viewer",
      }),
    );
    expect(s.email).toBe("carol@example.com");
    expect(
      (await call("DELETE", R.share(ID, "CAROL@example.com"))).status,
    ).toBe(204);
    expect(
      (
        await call("PUT", R.shares(ID), {
          email: art.owner.email?.toUpperCase(),
          role: "viewer",
        })
      ).status,
    ).toBe(400);
    const owner = fixtures.members.find((m) => m.role === "owner")
      ?.id as string;
    expect(
      (await call("PATCH", R.member(owner), { role: "member" })).status,
    ).toBe(400);
    expect((await call("DELETE", R.member(owner))).status).toBe(400);
  });
  it("search: empty q 400; snippet marks the match", async () => {
    fresh();
    expect((await call("GET", R.search)).status).toBe(400);
    expect((await call("GET", `${R.search}?q=`)).status).toBe(400);
    const p = await json(await call("GET", `${R.search}?q=q4`));
    expect(p.items[0].snippet).toContain(
      `${SNIPPET_MARK.open}Q4${SNIPPET_MARK.close}`,
    );
  });
  it("visibility/owner filters; deleted carry deletedAt", async () => {
    fresh();
    const ids = async (qs: string) =>
      (await json(await call("GET", `${R.artifacts}${qs}`))).items.map(
        (a: any) => a.id,
      );
    expect(await ids("?visibility=public")).toEqual(
      fixtures.artifacts
        .filter((a) => a.visibility === "public")
        .map((a) => a.id),
    );
    expect(await ids(`?owner=${guide.owner.id}`)).toEqual(
      fixtures.artifacts
        .filter((a) => a.owner.id === guide.owner.id)
        .map((a) => a.id),
    );
    await call("DELETE", R.artifact(pdf.id));
    const all = (
      await json(await call("GET", `${R.artifacts}?includeDeleted=true`))
    ).items;
    expect(all.find((a: any) => a.id === pdf.id).deletedAt).toBeTruthy();
    expect(all.find((a: any) => a.id === art.id).deletedAt).toBeNull();
  });
  it("viewer cannot mutate (404); editor cannot share/delete/visibility", async () => {
    fresh();
    for (const [m, p, b] of [
      ["PATCH", R.artifact(guide.id), { title: "x" }],
      ["POST", R.versions(guide.id), { id: guide.id, ...publish }],
      ["POST", R.restoreVersion(guide.id, 1), undefined],
      ["PUT", R.shares(guide.id), { email: "z@example.com", role: "viewer" }],
      ["DELETE", R.artifact(guide.id), undefined],
    ] as const) {
      const r = await call(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect((await call("GET", R.artifact(guide.id))).status).toBe(200);
  });
  it("editor can publish/patch/restore but not share, delete or change visibility", async () => {
    fresh();
    const d = by((a) => a.access === "editor");
    expect((await call("PATCH", R.artifact(d.id), { title: "x" })).status).toBe(
      200,
    );
    expect(
      (await call("POST", R.versions(d.id), { id: d.id, ...publish })).status,
    ).toBe(201);
    expect((await call("POST", R.restoreVersion(d.id, 1))).status).toBe(201);
    expect(
      (await call("PATCH", R.artifact(d.id), { visibility: "public" })).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", R.shares(d.id), {
          email: "z@example.com",
          role: "viewer",
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", R.artifact(d.id))).status).toBe(404);
  });
  it("data and storage lists honor limit/cursor", async () => {
    fresh();
    for (const n of ["a1", "a2", "a3"])
      await call("PUT", R.dataDoc(poll.id, "c", n), {});
    const p1 = await json(
      await call("GET", `${R.dataCollection(poll.id, "c")}?limit=2`),
    );
    expect(p1.items).toHaveLength(2);
    const p2 = await json(
      await call(
        "GET",
        `${R.dataCollection(poll.id, "c")}?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`,
      ),
    );
    expect(p2.items).toHaveLength(1);
    for (const k of ["k1", "k2"])
      await call("PUT", R.storageKey(poll.id, k), { value: 1 });
    const s1 = await json(await call("GET", `${R.storage(poll.id)}?limit=2`));
    expect(s1.items).toHaveLength(2);
    expect(s1.items[0]).not.toHaveProperty("value");
    expect(s1.nextCursor).toBeTruthy();
  });
  it("strict bodies reject unknown keys", async () => {
    fresh();
    expect(
      (await call("PATCH", R.settings, { name: "x", extra: 1 })).status,
    ).toBe(400);
  });
});

describe("contract C1", () => {
  const long = () =>
    Object.entries(fixtures.versions).find(([, v]) => v.length > 20) as [
      string,
      (typeof fixtures.versions)[string],
    ];
  it("has a fixture artifact with more than a page of versions", () => {
    expect(long()[1].length).toBeGreaterThan(VERSIONS_PAGE_SIZE);
    expect(VERSIONS_PAGE_SIZE).toBe(20);
    const a = fixtures.artifacts.find((x) => x.id === long()[0]);
    expect(a?.currentVersion).toBe(long()[1][0]?.version);
  });
  it("versions GET pages by before, newest first, 20 at a time", async () => {
    fresh();
    const id = long()[0];
    const total = long()[1].length;
    const p1 = z
      .array(VersionInfoSchema)
      .parse(await json(await call("GET", R.versions(id))));
    expect(p1.length).toBe(20);
    expect(p1[0]?.version).toBe(total);
    const p2 = await json(await call("GET", R.versions(id, p1[19]?.version)));
    expect(p2.map((v: { version: number }) => v.version)).toEqual(
      Array.from({ length: total - 20 }, (_, i) => total - 20 - i),
    );
    expect(await json(await call("GET", R.versions(id, 1)))).toEqual([]);
  });
  it("rejects bad before values", async () => {
    fresh();
    for (const b of ["0", "-1", "1.5", "abc", "", "01"])
      expect((await call("GET", `${R.versions(ID)}?before=${b}`)).status).toBe(
        400,
      );
  });
  it("list and search require auth; hits are redacted for authed only", async () => {
    fresh();
    const anon = { "content-type": "application/json" };
    expect((await call("GET", R.artifacts, undefined, anon)).status).toBe(401);
    expect(
      (await call("GET", `${R.search}?q=q4`, undefined, anon)).status,
    ).toBe(401);
    const hit = (await json(await call("GET", `${R.search}?q=q4`))).items[0];
    expect(hit.owner.email).toBe(pub.owner.email);
    const own = encodeURIComponent(pub.owner.email as string);
    const authed = await json(await call("GET", `${R.artifacts}?owner=${own}`));
    expect(authed.items.length).toBeGreaterThan(0);
  });
  it("R.versions builds before only when defined", () => {
    expect(R.versions("id")).toBe("/api/v1/artifacts/id/versions");
    expect(R.versions("id", 5)).toBe("/api/v1/artifacts/id/versions?before=5");
    for (const b of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => R.versions("id", b)).toThrow(RangeError);
  });
  it("anonymous requests on public artifacts get null emails", async () => {
    fresh();
    const anon = { "content-type": "application/json" };
    const a = await json(
      await call("GET", R.artifact(pub.id), undefined, anon),
    );
    ArtifactSummarySchema.parse(a);
    expect(a.owner.email).toBeNull();
    expect(a.owner.name).toBe(pub.owner.name);
    const vs = await json(
      await call("GET", R.versions(pub.id), undefined, anon),
    );
    expect(vs[0].createdBy.email).toBeNull();
    const authed = await json(
      await call("GET", R.artifact(pub.id), undefined, { ...H, cookie: "s=1" }),
    );
    expect(authed.owner.email).toBe(pub.owner.email);
    const bearer = await json(
      await call("GET", R.artifact(pub.id), undefined, {
        authorization: "Bearer x",
      }),
    );
    expect(bearer.owner.email).toBe(pub.owner.email);
    const cookie = await json(
      await call("GET", R.artifact(pub.id), undefined, { cookie: "s=1" }),
    );
    expect(cookie.owner.email).toBe(pub.owner.email);
  });
  it("storageKey PUT uses StorageSetBodySchema (strict)", async () => {
    fresh();
    expect(StorageSetBodySchema.safeParse({ value: 1 }).success).toBe(true);
    expect(StorageSetBodySchema.safeParse({ value: 1, x: 2 }).success).toBe(
      false,
    );
    const r = await call("PUT", R.storageKey(poll.id, "k2"), {
      value: 1,
      x: 2,
    });
    expect(r.status).toBe(400);
    expect(
      (await call("PUT", R.storageKey(poll.id, "k2"), { value: 1 })).status,
    ).toBe(200);
  });
});

describe("anonymous callers on authed routes", () => {
  const anon = { "content-type": "application/json" };
  const rows: [string, string, string][] = [
    ["GET", "me", R.me],
    ["GET", "members", R.members],
    ["GET", "tokens", R.tokens],
    ["GET", "oauthClients", R.oauthClients],
    ["GET", "settings", R.settings],
    ["GET", "usage", R.usage],
    ["GET", "artifacts", R.artifacts],
    ["GET", "search", `${R.search}?q=q4`],
    ["POST", "uploads", R.uploads],
    ["POST", "artifacts", R.artifacts],
    ["PATCH", "artifact", R.artifact(ID)],
    ["DELETE", "artifact", R.artifact(ID)],
    ["POST", "versions", R.versions(ID)],
    ["PUT", "storageKey", R.storageKey(poll.id, "k")],
  ];
  for (const [method, name, path] of rows)
    it(`${method} ${name} -> 401 without cookie or Bearer`, async () => {
      fresh();
      const r = await call(
        method,
        path,
        method === "GET" ? undefined : {},
        anon,
      );
      expect(r.status).toBe(401);
      expect((await json(r)).error.code).toBe("unauthorized");
    });
  it("anonymous data writes on a public allowAnonymousWrites artifact succeed (B13)", async () => {
    fresh();
    expect(poll.visibility).toBe("public");
    expect(poll.allowAnonymousWrites).toBe(true);
    const put = await call(
      "PUT",
      R.dataDoc(poll.id, "votes", "anon1"),
      { v: 1 },
      anon,
    );
    expect(put.status).toBe(200);
    expect((await json(put)).updatedBy).toBe("anon");
    const patch = await call(
      "PATCH",
      R.dataDoc(poll.id, "votes", "anon1"),
      { w: 2 },
      anon,
    );
    expect(patch.status).toBe(200);
    expect((await json(patch)).data).toEqual({ v: 1, w: 2 });
    expect(
      (
        await call(
          "DELETE",
          R.dataDoc(poll.id, "votes", "anon1"),
          undefined,
          anon,
        )
      ).status,
    ).toBe(204);
    // Not allowed: a public artifact without allowAnonymousWrites, and storage.
    const other = by(
      (a) => a.visibility === "public" && !a.allowAnonymousWrites,
    );
    expect(
      (await call("PUT", R.dataDoc(other.id, "c", "d"), { v: 1 }, anon)).status,
    ).toBe(401);
    expect(
      (await call("PUT", R.storageKey(poll.id, "k"), { value: 1 }, anon))
        .status,
    ).toBe(401);
  });
  it("Bearer counts as authed; public artifact reads stay anonymous", async () => {
    fresh();
    const b = { ...anon, authorization: "Bearer x" };
    expect((await call("GET", R.me, undefined, b)).status).toBe(200);
    expect(
      (await call("GET", R.artifact(pub.id), undefined, anon)).status,
    ).toBe(200);
    expect(
      (await call("GET", R.versions(pub.id), undefined, anon)).status,
    ).toBe(200);
  });
});

describe("anonymous reads of non-public artifacts (as on the server)", () => {
  const anon = { "content-type": "application/json" };
  const embed = { ...H, "x-oa-embed": "1" };
  const priv = by((a) => a.visibility === "private" && a.access === "owner");
  const team = by((a) => a.visibility === "team");
  const reads = (id: string) => [
    R.artifact(id),
    R.contentUrl(id),
    R.versions(id),
    R.dataCollection(id, "votes"),
    R.dataDoc(id, "votes", "x"),
  ];

  it("no cookie/Bearer, or X-OA-Embed: 1 with a cookie or Bearer -> 404 not_found", async () => {
    fresh();
    for (const headers of [
      anon,
      embed,
      { ...anon, authorization: "Bearer x", "x-oa-embed": "1" },
    ])
      for (const a of [priv, team])
        for (const path of reads(a.id)) {
          const r = await call("GET", path, undefined, headers);
          expect(r.status, `${path} ${JSON.stringify(headers)}`).toBe(404);
          expect((await json(r)).error.code).toBe("not_found");
        }
  });

  it("signed in (no hint) still reads them; public reads stay anonymous-OK", async () => {
    fresh();
    expect((await call("GET", R.artifact(priv.id))).status).toBe(200);
    expect((await call("GET", R.contentUrl(priv.id))).status).toBe(200);
    expect(
      (await call("GET", R.dataCollection(poll.id, "votes"), undefined, embed))
        .status,
    ).toBe(200);
    const r = await call("GET", R.artifact(pub.id), undefined, embed);
    expect(r.status).toBe(200);
    expect((await json(r)).owner.email).toBeNull();
    expect(
      (await call("GET", R.contentUrl(pub.id), undefined, anon)).status,
    ).toBe(200);
  });

  it("anonymous data/storage writes to a non-public artifact -> 404; query on public is a read", async () => {
    fresh();
    for (const headers of [anon, { ...embed }])
      for (const a of [priv, team]) {
        for (const [m, path, body] of [
          ["PUT", R.dataDoc(a.id, "c", "d"), { v: 1 }],
          ["PATCH", R.dataDoc(a.id, "c", "d"), { v: 1 }],
          ["DELETE", R.dataDoc(a.id, "c", "d"), undefined],
          ["POST", R.dataQuery(a.id, "c"), {}],
          ["PUT", R.storageKey(a.id, "k"), { value: 1 }],
          ["DELETE", R.storageKey(a.id, "k"), undefined],
        ] as const) {
          const r = await call(m, path, body, headers);
          expect(r.status, `${m} ${path}`).toBe(404);
          expect((await json(r)).error.code).toBe("not_found");
        }
      }
    expect(
      (await call("PUT", R.dataDoc(bad, "c", "d"), { v: 1 }, anon)).status,
    ).toBe(404);
    expect(
      (await call("POST", R.dataQuery(poll.id, "votes"), {}, anon)).status,
    ).toBe(200);
  });

  it("X-OA-Embed: 1 and ?embed=1 make authed routes 401 even with a cookie", async () => {
    fresh();
    expect((await call("GET", R.me, undefined, embed)).status).toBe(401);
    expect((await call("GET", `${R.me}?embed=1`)).status).toBe(401);
    expect(
      (await call("GET", R.me, undefined, { ...H, "x-oa-embed": "0" })).status,
    ).toBe(200);
  });
});

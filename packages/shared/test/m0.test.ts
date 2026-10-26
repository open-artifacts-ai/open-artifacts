import { describe, expect, it } from "vitest";
import * as S from "../src/index.js";
import { newId } from "../src/index.js";

const id = newId();
const doc = { id: "d", data: { a: 1 }, updatedAt: "t", updatedBy: null };
const user = { id: "u", email: "a@b.co", name: null };
const summary = {
  id,
  title: "t",
  description: null,
  format: "html",
  visibility: "private",
  owner: user,
  currentVersion: 1,
  createdAt: "t",
  updatedAt: "t",
  deletedAt: null,
  lastAgent: null,
  thumbnailUrl: null,
  thumbnailVersion: null,
  access: "owner",
  capabilities: { db: false, viewer: false, storage: false },
  dataWriters: "editors",
  allowAnonymousWrites: false,
};

describe("runtime params/results", () => {
  const P = S.RUNTIME_PARAMS;
  const Rz = S.RUNTIME_RESULTS;
  it("covers every method", () => {
    expect(Object.keys(P).sort()).toEqual([...S.RUNTIME_METHODS].sort());
    expect(Object.keys(Rz).sort()).toEqual([...S.RUNTIME_METHODS].sort());
  });
  it("params", () => {
    expect(P["db.get"].safeParse({ collection: "c", id: "d" }).success).toBe(
      true,
    );
    expect(P["db.get"].safeParse({ collection: "c", id: ".." }).success).toBe(
      false,
    );
    expect(
      P["db.get"].safeParse({ collection: "c", id: "d", x: 1 }).success,
    ).toBe(false);
    expect(P["db.list"].safeParse({ collection: "c", limit: 5 }).success).toBe(
      true,
    );
    expect(
      P["db.query"].safeParse({ collection: "c", query: { where: { a: 1 } } })
        .success,
    ).toBe(true);
    expect(
      P["db.set"].safeParse({ collection: "c", id: "d", data: [1] }).success,
    ).toBe(true);
    expect(
      P["db.update"].safeParse({ collection: "c", id: "d", patch: { a: 1 } })
        .success,
    ).toBe(true);
    expect(
      P["db.update"].safeParse({
        collection: "c",
        id: "d",
        patch: { "a.b": 1 },
      }).success,
    ).toBe(false);
    expect(P["db.subscribe"].safeParse({ collection: "c" }).success).toBe(true);
    expect(P["storage.get"].safeParse({ key: "a/b" }).success).toBe(false);
    expect(P["storage.set"].safeParse({ key: "k", value: 1 }).success).toBe(
      true,
    );
    expect(P["storage.list"].safeParse({}).success).toBe(true);
    expect(P["storage.list"].safeParse({ a: 1 }).success).toBe(false);
    expect(P["viewer.get"].safeParse({}).success).toBe(true);
  });
  it("results", () => {
    expect(Rz["db.get"].safeParse(null).success).toBe(true);
    expect(Rz["db.get"].safeParse(doc).success).toBe(true);
    expect(
      Rz["db.list"].safeParse({ items: [doc], nextCursor: null }).success,
    ).toBe(true);
    expect(Rz["db.delete"].safeParse(null).success).toBe(true);
    expect(
      Rz["storage.list"].safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
    expect(
      Rz["viewer.get"].safeParse({ email: "a@b.co", name: null }).success,
    ).toBe(true);
    expect(Rz["viewer.get"].safeParse(null).success).toBe(true);
    expect(Rz["storage.set"].safeParse(1).success).toBe(false);
  });
});

describe("names and keys", () => {
  it("DataNameSchema", () => {
    expect(S.DataNameSchema.safeParse("a_b-1").success).toBe(true);
    for (const bad of [".", "..", "a.b", "", "a/b", "x".repeat(129)]) {
      expect(S.DataNameSchema.safeParse(bad).success).toBe(false);
    }
    expect(S.StorageKeyNameSchema.safeParse("a.b").success).toBe(false);
    expect(S.StorageKeyNameSchema.safeParse("ok").success).toBe(true);
  });
  it("data keys have no dots", () => {
    expect(S.DataQuerySchema.safeParse({ where: { "a.b": 1 } }).success).toBe(
      false,
    );
    expect(S.DataQuerySchema.safeParse({ orderBy: "a.b" }).success).toBe(false);
    expect(S.DataQuerySchema.safeParse({ orderBy: "a_b" }).success).toBe(true);
  });
  it("patch/set bodies", () => {
    expect(S.DataSetBodySchema.safeParse([1, "x"]).success).toBe(true);
    expect(S.DataPatchBodySchema.safeParse({ a: 1, b: { c: 2 } }).success).toBe(
      true,
    );
    expect(
      S.DataPatchBodySchema.safeParse(JSON.parse('{"__proto__": 1}')).success,
    ).toBe(false);
    expect(S.DataPatchBodySchema.safeParse({ constructor: 1 }).success).toBe(
      false,
    );
    expect(S.DataPatchBodySchema.safeParse([1]).success).toBe(false);
  });
});

describe("routes and misc", () => {
  it("dataSubscribe/diff/PAGES", () => {
    expect(S.R.dataSubscribe("id", "a b")).toBe(
      "/api/v1/artifacts/id/data-subscribe?collection=a%20b",
    );
    expect(S.R.dataCount("id", "a b")).toBe(
      "/api/v1/artifacts/id/data-count/a%20b",
    );
    expect(S.diffPath("id", 1, 2)).toBe("/a/id/diff/1/2");
    expect(S.PAGES).toEqual({ noAccess: "/no-access", search: "/search" });
  });
  it("DataChange, Theme, Storage", () => {
    expect(
      S.DataChangeSchema.safeParse({
        type: "db.change",
        collection: "c",
        docs: [doc],
        deleted: ["x"],
      }).success,
    ).toBe(true);
    expect(S.ThemeSchema.options).toEqual(["light", "dark"]);
    expect(
      S.StorageKeySchema.safeParse({ key: "k", updatedAt: "t" }).success,
    ).toBe(true);
    expect(
      S.PageSchema(S.StorageKeySchema).safeParse({
        items: [{ key: "k", updatedAt: "t" }],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
  it("SNIPPET_MARK and limits", () => {
    expect(S.SNIPPET_MARK).toEqual({ open: "\u0002", close: "\u0003" });
    expect(S.LIMITS.uploadUrlTtlSec).toBe(3600);
    // Search indexes only an entry's first 64 KB (the index alarm's CPU budget).
    expect(S.LIMITS.indexTextBytes).toBe(64 * 1024);
    // Body text is indexed this long after a publish (bursts coalesce).
    expect(S.LIMITS.indexDebounceMs).toBe(10_000);
  });
  it("summary deletedAt, list filters", () => {
    expect(S.ArtifactSummarySchema.safeParse(summary).success).toBe(true);
    const { deletedAt: _d, ...rest } = summary;
    expect(S.ArtifactSummarySchema.safeParse(rest).success).toBe(false);
    expect(
      S.ListQuerySchema.parse({ visibility: "team", owner: "a@b.co" }),
    ).toMatchObject({ visibility: "team", owner: "a@b.co" });
    expect(S.ListQuerySchema.safeParse({ visibility: "x" }).success).toBe(
      false,
    );
  });
});

describe("strict inputs", () => {
  it("unknown keys rejected", () => {
    const cases: [{ safeParse(v: unknown): { success: boolean } }, unknown][] =
      [
        [
          S.PublishInputSchema,
          { title: "t", format: "html", content: "x", zzz: 1 },
        ],
        [S.ArtifactPatchSchema, { zzz: 1 }],
        [S.ArtifactPatchSchema, { capabilities: { zzz: true } }],
        [S.ShareInputSchema, { email: "a@b.co", role: "viewer", zzz: 1 }],
        [S.MemberInviteSchema, { email: "a@b.co", role: "member", zzz: 1 }],
        [S.MemberPatchSchema, { role: "member", zzz: 1 }],
        [S.TokenCreateInputSchema, { label: "x", zzz: 1 }],
        [S.SettingsPatchSchema, { zzz: 1 }],
        [S.UploadCreateInputSchema, { path: "a", size: 1, zzz: 1 }],
        [S.DataQuerySchema, { zzz: 1 }],
      ];
    for (const [schema, v] of cases)
      expect(schema.safeParse(v).success).toBe(false);
  });
  it("SettingsPatch", () => {
    expect(S.SettingsPatchSchema.safeParse({}).success).toBe(true);
    expect(S.SettingsPatchSchema.safeParse({ name: "n" }).success).toBe(true);
    expect(
      S.SettingsPatchSchema.safeParse({ defaultVisibility: "public" }).success,
    ).toBe(false);
  });
});

describe("MCP inputs", () => {
  it("GetArtifactInput", () => {
    expect(S.GetArtifactInputSchema.parse({ id })).toEqual({
      id,
      includeContent: true,
    });
    expect(S.GetArtifactInputSchema.safeParse({ id: "bad" }).success).toBe(
      false,
    );
    expect(S.GetArtifactInputSchema.safeParse({ id, version: 0 }).success).toBe(
      false,
    );
    expect(
      S.GetArtifactInputSchema.safeParse({
        id,
        path: "a",
        version: 2,
        includeContent: false,
      }).success,
    ).toBe(true);
    expect(S.GetArtifactInputSchema.safeParse({ id, x: 1 }).success).toBe(
      false,
    );
  });
  it("SearchQuery", () => {
    expect(S.SearchQuerySchema.parse({ q: "  hi " })).toEqual({
      q: "hi",
      limit: 25,
    });
    expect(S.SearchQuerySchema.parse({ q: "hi", limit: "10" }).limit).toBe(10);
    expect(S.SearchQuerySchema.safeParse({ q: " " }).success).toBe(false);
    expect(S.SearchQuerySchema.safeParse({ q: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(S.SearchQuerySchema.safeParse({ q: "x", limit: 101 }).success).toBe(
      false,
    );
  });
  it("simple inputs", () => {
    expect(S.IdInputSchema.safeParse({ id }).success).toBe(true);
    expect(S.IdInputSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(
      S.RestoreVersionInputSchema.safeParse({ id, version: 2 }).success,
    ).toBe(true);
    expect(
      S.ShareArtifactInputSchema.safeParse({
        id,
        email: "a@b.co",
        role: "viewer",
      }).success,
    ).toBe(true);
    expect(
      S.ShareArtifactInputSchema.safeParse({
        id,
        email: "a@b.co",
        role: "viewer",
        z: 1,
      }).success,
    ).toBe(false);
    expect(
      S.UnshareInputSchema.safeParse({ id, email: "a@b.co" }).success,
    ).toBe(true);
    expect(
      S.SetVisibilityInputSchema.safeParse({ id, visibility: "team" }).success,
    ).toBe(true);
    expect(S.CreateUploadInputSchema).toBe(S.UploadCreateInputSchema);
  });
  it("artifact data inputs", () => {
    const base = { id, collection: "c" };
    expect(
      S.ArtifactDataGetInputSchema.safeParse({ ...base, docId: "d" }).success,
    ).toBe(true);
    expect(
      S.ArtifactDataListInputSchema.safeParse({ ...base, limit: 5 }).success,
    ).toBe(true);
    expect(
      S.ArtifactDataQueryInputSchema.safeParse({ ...base, query: {} }).success,
    ).toBe(true);
    expect(
      S.ArtifactDataSetInputSchema.safeParse({
        ...base,
        docId: "d",
        data: { a: 1 },
      }).success,
    ).toBe(true);
    expect(
      S.ArtifactDataUpdateInputSchema.safeParse({
        ...base,
        docId: "d",
        patch: { a: 1 },
      }).success,
    ).toBe(true);
    expect(
      S.ArtifactDataDeleteInputSchema.safeParse({ ...base, docId: "d" })
        .success,
    ).toBe(true);
    expect(
      S.ArtifactDataGetInputSchema.safeParse({
        ...base,
        collection: "..",
        docId: "d",
      }).success,
    ).toBe(false);
    expect(
      S.ArtifactDataGetInputSchema.safeParse({ ...base, docId: "d", x: 1 })
        .success,
    ).toBe(false);
  });
  it("GetArtifactResult", () => {
    const version = {
      version: 1,
      message: null,
      agent: null,
      createdBy: user,
      createdAt: "t",
      entry: "index.html",
      files: [],
      language: null,
      textIndexed: false,
      format: "html",
    };
    expect(
      S.GetArtifactResultSchema.safeParse({
        artifact: summary,
        version,
        content: "x",
      }).success,
    ).toBe(true);
    expect(
      S.GetArtifactResultSchema.safeParse({
        artifact: summary,
        version,
        downloadUrl: "https://x/y",
      }).success,
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { newId } from "../src/ids.js";
import {
  ApiErrorSchema,
  ArtifactPatchSchema,
  ArtifactSummarySchema,
  CapabilitiesPatchSchema,
  DATA_WRITERS_NOTE,
  DATA_WRITERS_WARNING,
  DataQuerySchema,
  DisplayNameSchema,
  dataDocLimit,
  dataDocTooLargeMessage,
  dataWritersWarning,
  ERROR_CODES,
  INLINE_TOO_LARGE_MESSAGE,
  LIMITS,
  ListQuerySchema,
  mcpBodyLimit,
  mcpTooLargeMessage,
  PageSchema,
  PublishInputSchema,
  PublishToolInputSchema,
  planOf,
  R,
  resolveDataWriters,
  SetVisibilityInputSchema,
  STATUS_FOR,
  USAGE_LIMITS,
  UsageSchema,
  usageLimit,
  viewerPath,
} from "../src/index.js";

const ok = (v: unknown) => PublishInputSchema.safeParse(v).success;

describe("PublishInputSchema", () => {
  it("rejects invalid combos", () => {
    expect(
      ok({
        title: "t",
        format: "html",
        content: "x",
        files: { "a.html": "x" },
      }),
    ).toBe(false);
    expect(ok({ title: "t" })).toBe(false);
    expect(ok({ format: "markdown", content: "x" })).toBe(false);
    expect(ok({ title: "t", content: "x" })).toBe(false);
    expect(ok({ title: "", format: "html", content: "x" })).toBe(false);
  });
  it("accepts valid", () => {
    expect(ok({ title: "t", format: "markdown", content: "# hi" })).toBe(true);
    expect(ok({ title: "t", entry: "a.md", content: "# hi" })).toBe(true);
    expect(ok({ id: newId(), files: { "index.html": "<p>" } })).toBe(true);
  });
});

describe("misc", () => {
  it("ListQuery defaults and coercion", () => {
    const q = ListQuerySchema.parse({ limit: "10" });
    expect(q).toMatchObject({ scope: "all", limit: 10 });
  });
  it("PageSchema", () => {
    expect(
      PageSchema(z.string()).parse({ items: ["a"], nextCursor: null }).items,
    ).toEqual(["a"]);
  });
  it("errors", () => {
    expect(Object.keys(STATUS_FOR).sort()).toEqual([...ERROR_CODES].sort());
    // #681: a write refused because only editors may change data.
    expect(STATUS_FOR.data_editors_only).toBe(403);
    expect(ERROR_CODES).not.toContain("anon_writes_disabled");
    const art = (
      visibility: string,
      db: boolean,
      dataWriters: "viewers" | "editors",
    ) => dataWritersWarning({ visibility, capabilities: { db }, dataWriters });
    expect(art("public", true, "viewers")).toBe(DATA_WRITERS_WARNING);
    expect(DATA_WRITERS_WARNING).toBe(
      'This page is public and lets anyone change its data. Set dataWriters to "editors" to limit that.',
    );
    expect(art("public", true, "editors")).toBeUndefined();
    expect(art("public", false, "viewers")).toBeUndefined();
    expect(art("private", true, "viewers")).toBeUndefined();
    expect(art("team", true, "viewers")).toBeUndefined();
    expect(DATA_WRITERS_NOTE).toBe(
      'Anyone who can view an artifact can change its live data; on a public artifact that includes anonymous visitors. Set dataWriters: "editors" to limit writes to editors (refusals get data_editors_only).',
    );
    for (const s of [DATA_WRITERS_NOTE, DATA_WRITERS_WARNING])
      expect(s).not.toMatch(/—/);
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "data_editors_only", message: "x" },
      }).success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({ error: { code: "nope", message: "x" } })
        .success,
    ).toBe(false);
  });
  it("routes", () => {
    expect(R.versionFile("id", 2, "a b/c.css")).toBe(
      "/api/v1/artifacts/id/versions/2/files/a%20b/c.css",
    );
    expect(R.contentUrl("id")).toBe("/api/v1/artifacts/id/content-url");
    expect(R.contentUrl("id", 3)).toBe("/api/v1/artifacts/id/content-url?v=3");
    expect(R.share("id", "a@b.c")).toBe("/api/v1/artifacts/id/shares/a%40b.c");
    expect(viewerPath("id")).toBe("/a/id");
    expect(viewerPath("id", 2)).toBe("/a/id/v/2");
  });
});

const parse = (v: unknown) => PublishInputSchema.safeParse(v);

describe("fix round 1: capabilities patch", () => {
  it("does not inject defaults", () => {
    expect(CapabilitiesPatchSchema.parse({ db: true })).toEqual({ db: true });
    expect(ArtifactPatchSchema.parse({ capabilities: { db: true } })).toEqual({
      capabilities: { db: true },
    });
    const r = PublishInputSchema.parse({
      title: "t",
      format: "html",
      content: "x",
      capabilities: { storage: true },
    });
    expect(r.capabilities).toEqual({ storage: true });
  });
});

describe("fix round 1: includeDeleted", () => {
  it("parses strings and booleans", () => {
    expect(
      ListQuerySchema.parse({ includeDeleted: "false" }).includeDeleted,
    ).toBe(false);
    expect(
      ListQuerySchema.parse({ includeDeleted: "true" }).includeDeleted,
    ).toBe(true);
    expect(ListQuerySchema.parse({ includeDeleted: true }).includeDeleted).toBe(
      true,
    );
    expect(ListQuerySchema.parse({}).includeDeleted).toBe(false);
  });
});

describe("fix round 1: routes", () => {
  const p = (u: string) => new URL(u, "https://x").pathname;
  it("encodes dynamic segments", () => {
    expect(p(R.storageKey("id", "../../../me"))).toBe(
      "/api/v1/artifacts/id/storage/..%2F..%2F..%2Fme",
    );
    expect(() => R.storageKey("id", "..")).toThrow();
    expect(() => R.dataDoc("id", "c", ".")).toThrow();
    expect(() => R.versionFile("id", 1, "../../../../me")).toThrow();
    expect(p(R.versionFile("id", 1, "a/b c.css"))).toBe(
      "/api/v1/artifacts/id/versions/1/files/a/b%20c.css",
    );
    const d = new URL(R.dataDoc("id", "c", "x?y"), "https://x");
    expect(d.pathname).toBe("/api/v1/artifacts/id/data/c/x%3Fy");
    expect(d.search).toBe("");
    expect(R.contentUrl("id", 0)).toBe("/api/v1/artifacts/id/content-url?v=0");
    expect(viewerPath("id", 0)).toBe("/a/id/v/0");
    expect(R.member("a/b")).toBe("/api/v1/members/a%2Fb");
    expect(R.token("../x")).toBe("/api/v1/tokens/..%2Fx");
    expect(R.upload("a#b")).toBe("/api/v1/uploads/a%23b");
    expect(R.oauthClient("a?b")).toBe("/api/v1/oauth-clients/a%3Fb");
    expect(R.artifact("a/b")).toBe("/api/v1/artifacts/a%2Fb");
  });
});

describe("fix round 1: PublishInput refinements", () => {
  const base = { title: "t" };
  const bad = (v: unknown) => expect(parse(v).success).toBe(false);
  it("id must be an id", () => {
    bad({ id: "abc", files: { "a.html": "x" } });
  });
  it("file keys validated", () => {
    const r = parse({ ...base, files: { "../x": "x" } });
    expect(r.success).toBe(false);
    if (!r.success) {
      const i = r.error.issues[0];
      expect(i?.path).toEqual(["files", "../x"]);
      expect(i?.message).toContain("../x");
      expect(i?.message).toContain("traversal");
    }
    bad({ ...base, files: { "A.css": "x", "a.css": "x" } });
    bad({ ...base, files: {} });
  });
  it("files count cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.filesPerVersion; i++) files[`f${i}`] = "x";
    bad({ ...base, files });
  });
  it("entry", () => {
    bad({ ...base, files: { "a.html": "x" }, entry: "b.html" });
    bad({ ...base, files: { "a.html": "x" }, entry: "../a.html" });
    expect(
      parse({ ...base, files: { "a/b.html": "x" }, entry: "./a/b.html" })
        .success,
    ).toBe(true);
  });
  it("title trimmed", () => {
    bad({ title: "   ", format: "html", content: "x" });
    expect(
      PublishInputSchema.parse({ title: "  hi ", format: "html", content: "x" })
        .title,
    ).toBe("hi");
  });
  it("content bytes", () => {
    bad({
      ...base,
      format: "html",
      content: "é".repeat(LIMITS.inlineBytes / 2 + 1),
    });
    expect(
      parse({
        ...base,
        format: "html",
        content: "é".repeat(LIMITS.inlineBytes / 2),
      }).success,
    ).toBe(true);
  });
  it("128 KB inline limit, upload hint; the MCP schema leaves it to the server", () => {
    expect(LIMITS.inlineBytes).toBe(128 * 1024);
    const kb = LIMITS.inlineBytes / 1024;
    expect(INLINE_TOO_LARGE_MESSAGE).toBe(
      `Inline content is limited to ${kb} KB per publish. For larger files: create_upload({ path, size, contentType }), PUT the bytes to the returned url, then publish_artifact({ id: artifactId, title, files: { "<path>": { uploadId } } }).`,
    );
    const big = {
      ...base,
      format: "html",
      content: "x".repeat(LIMITS.inlineBytes + 1),
    };
    const r = parse(big);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      INLINE_TOO_LARGE_MESSAGE,
    );
    expect(PublishToolInputSchema.safeParse(big).success).toBe(true);
    expect(PublishToolInputSchema.safeParse({ ...base }).success).toBe(false);
  });

  it("#681 D: the MCP schema takes an id with only settings; REST does not", () => {
    const id = "7Hq2mXc9KpR4tWbZ";
    const settings = { id, visibility: "team" };
    expect(PublishToolInputSchema.safeParse(settings).success).toBe(true);
    expect(PublishToolInputSchema.safeParse({ id }).success).toBe(true);
    expect(ok(settings)).toBe(false);
    // Without an id, content or files are still required.
    expect(PublishToolInputSchema.safeParse({ title: "t" }).success).toBe(
      false,
    );
    // Both at once stays an error.
    expect(
      PublishToolInputSchema.safeParse({
        id,
        format: "html",
        content: "x",
        files: { "a.html": "x" },
      }).success,
    ).toBe(false);
  });
});

describe("fix round 1: DataQuery", () => {
  const ok = (v: unknown) => DataQuerySchema.safeParse(v).success;
  it("where rules", () => {
    expect(ok({ where: { a: 1, b_c: "x", _d: null } })).toBe(true);
    expect(ok({ where: JSON.parse('{"__proto__": 1}') })).toBe(false);
    expect(ok({ where: { constructor: 1 } })).toBe(false);
    expect(ok({ where: { prototype: 1 } })).toBe(false);
    expect(ok({ where: { "1a": 1 } })).toBe(false);
    expect(ok({ where: { ["a".repeat(65)]: 1 } })).toBe(false);
    expect(ok({ where: { a: "x".repeat(1025) } })).toBe(false);
    expect(ok({ where: { a: "x".repeat(1024) } })).toBe(true);
    const many: Record<string, number> = {};
    for (let i = 0; i < 33; i++) many[`k${i}`] = 1;
    expect(ok({ where: many })).toBe(false);
  });
  it("orderBy rule", () => {
    expect(ok({ orderBy: "a_b" })).toBe(true);
    expect(ok({ orderBy: "__proto__" })).toBe(false);
    expect(ok({ orderBy: "a b" })).toBe(false);
  });
});

describe("fix round 2", () => {
  it("rejects files keys that normalize to the same path", () => {
    const r = PublishInputSchema.safeParse({
      title: "t",
      files: { "a.html": "x", "./a.html": "y" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const m = r.error.issues.map((i) => i.message).join("|");
      expect(m).toContain('"a.html"');
      expect(m).toContain('"./a.html"');
    }
  });
  it("ArtifactPatch.title is trimmed and min 1", () => {
    expect(ArtifactPatchSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(ArtifactPatchSchema.parse({ title: "  hi " })).toEqual({
      title: "hi",
    });
  });
});

describe("fix round 3", () => {
  it("input schemas", async () => {
    const m = await import("../src/index.js");
    expect(
      m.ShareInputSchema.safeParse({ email: "a@b.co", role: "editor" }).success,
    ).toBe(true);
    expect(
      m.ShareInputSchema.safeParse({ email: "x", role: "editor" }).success,
    ).toBe(false);
    expect(
      m.MemberInviteSchema.safeParse({ email: "a@b.co", role: "admin" })
        .success,
    ).toBe(true);
    expect(
      m.MemberInviteSchema.safeParse({ email: "a@b.co", role: "owner" })
        .success,
    ).toBe(false);
    expect(
      m.MemberInviteSchema.safeParse({ email: "a@b.co", role: "guest" })
        .success,
    ).toBe(false);
    expect(m.MemberPatchSchema.safeParse({ role: "member" }).success).toBe(
      true,
    );
    expect(m.MemberPatchSchema.safeParse({ role: "owner" }).success).toBe(
      false,
    );
    expect(m.TokenCreateInputSchema.parse({ label: "  x " })).toEqual({
      label: "x",
    });
    expect(m.TokenCreateInputSchema.safeParse({ label: " " }).success).toBe(
      false,
    );
    expect(
      m.TokenCreateInputSchema.safeParse({ label: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      m.StorageEntrySchema.safeParse({ key: "k", value: 1, updatedAt: "t" })
        .success,
    ).toBe(true);
  });
  it("Me.defaultVisibility is private|team", async () => {
    const m = await import("../src/index.js");
    const me = {
      user: {
        id: "i",
        email: "a@b.co",
        name: null,
        role: "owner",
        lastSeenAt: null,
      },
      instance: {
        name: "n",
        defaultVisibility: "public",
        appUrl: "a",
        mcpUrl: "b",
        emailEnabled: false,
        plan: "free",
      },
      displayName: null,
      suggestedName: null,
      needsDisplayName: true,
    };
    expect(m.MeSchema.safeParse(me).success).toBe(false);
    me.instance.defaultVisibility = "team";
    expect(m.MeSchema.safeParse(me).success).toBe(true);
    // instance.update: optional (older servers), nullable, else the full shape.
    const inst = me.instance as Record<string, unknown>;
    inst.update = null;
    expect(m.MeSchema.safeParse(me).success).toBe(true);
    inst.update = { latestVersion: "0.4.0" };
    expect(m.MeSchema.safeParse(me).success).toBe(false);
    inst.update = {
      latestVersion: "0.4.0",
      current: "0.3.0",
      custom: false,
      updateAvailable: true,
      breaking: true,
      notesUrl: "u",
      checkedAt: "t",
    };
    expect(m.MeSchema.safeParse(me).success).toBe(true);
    (inst.update as Record<string, unknown>).breaking = null;
    expect(m.MeSchema.safeParse(me).success).toBe(true);
  });
});

describe("fix round 4", () => {
  it("storage list page parses", async () => {
    const m = await import("../src/index.js");
    const page = {
      items: [{ key: "k", value: { a: 1 }, updatedAt: "t" }],
      nextCursor: null,
    };
    expect(m.PageSchema(m.StorageEntrySchema).safeParse(page).success).toBe(
      true,
    );
  });
});

describe("UserRefSchema email", () => {
  it("accepts null, rejects non-email strings", async () => {
    const { UserRefSchema, ArtifactSummarySchema, VersionInfoSchema } =
      await import("../src/index.js");
    expect(
      UserRefSchema.safeParse({ id: "a", email: null, name: null }).success,
    ).toBe(true);
    expect(
      UserRefSchema.safeParse({ id: "a", email: "x", name: null }).success,
    ).toBe(false);
    expect(ArtifactSummarySchema.shape.owner).toBe(UserRefSchema);
    expect(VersionInfoSchema.shape.createdBy).toBe(UserRefSchema);
  });
});

describe("VersionInfoSchema format (C2)", () => {
  it("requires a known format", async () => {
    const { VersionInfoSchema } = await import("../src/index.js");
    const v = {
      version: 1,
      message: null,
      agent: null,
      createdBy: { id: "a", email: null, name: null },
      createdAt: "t",
      entry: "README.md",
      files: [],
      language: null,
      textIndexed: true,
    };
    expect(VersionInfoSchema.safeParse(v).success).toBe(false);
    expect(
      VersionInfoSchema.safeParse({ ...v, format: "markdown" }).success,
    ).toBe(true);
    expect(VersionInfoSchema.safeParse({ ...v, format: "doc" }).success).toBe(
      false,
    );
  });
});

describe("UsageSchema", () => {
  it("accepts the CPU-limit metric keys", () => {
    const u = {
      available: true,
      plan: "free" as const,
      date: "2026-10-19",
      metrics: [
        { key: "cpu_limit_hits", used: 3, limit: 0 },
        { key: "cpu_p99_ms", used: 8.5, limit: 10 },
        { key: "kv_writes", used: 12, limit: 1000 },
      ],
    };
    expect(UsageSchema.parse(u)).toEqual(u);
    expect(
      UsageSchema.safeParse({
        ...u,
        metrics: [{ key: "cpu_nope", used: 1, limit: 0 }],
      }).success,
    ).toBe(false);
  });

  it("requires plan: free or paid", () => {
    const u = { available: false, date: "2026-10-19", metrics: [] };
    expect(UsageSchema.safeParse(u).success).toBe(false);
    expect(UsageSchema.parse({ ...u, plan: "paid" }).plan).toBe("paid");
    expect(UsageSchema.safeParse({ ...u, plan: "pro" }).success).toBe(false);
  });
});

describe("USAGE_LIMITS", () => {
  it("covers every usage metric key on both plans", () => {
    const keys = [...UsageSchema.shape.metrics.element.shape.key.options];
    for (const plan of ["free", "paid"] as const)
      expect(Object.keys(USAGE_LIMITS[plan]).sort()).toEqual(keys.sort());
  });

  it("Free: today's daily caps and the 10 ms CPU limit", () => {
    expect(USAGE_LIMITS.free).toEqual({
      requests: 100_000,
      d1_reads: 5_000_000,
      d1_writes: 100_000,
      do_requests: 100_000,
      cpu_limit_hits: 0,
      cpu_p99_ms: 10,
      kv_writes: 1_000,
    });
  });

  it("Paid: no daily caps (0) and the default 30 s CPU limit", () => {
    expect(USAGE_LIMITS.paid).toEqual({
      requests: 0,
      d1_reads: 0,
      d1_writes: 0,
      do_requests: 0,
      cpu_limit_hits: 0,
      cpu_p99_ms: 30_000,
      kv_writes: 0,
    });
    expect(usageLimit("paid", "cpu_p99_ms")).toBe(30_000);
    expect(usageLimit("free", "kv_writes")).toBe(1_000);
  });
});

describe("plan-aware limits", () => {
  it('PLAN: "paid" (trimmed, any case) is paid; unset or anything else is free', () => {
    for (const v of ["paid", "PAID", " Paid\n"]) expect(planOf(v)).toBe("paid");
    for (const v of [undefined, null, "", "free", "pro", "paid-ish", 1])
      expect(planOf(v)).toBe("free");
  });
  it("data docs: 256 KB on Free, 1 MB on Paid; docBytes is the Paid alias", () => {
    expect(LIMITS.dataDocBytesFree).toBe(256 * 1024);
    expect(LIMITS.dataDocBytesPaid).toBe(1024 * 1024);
    expect(LIMITS.docBytes).toBe(LIMITS.dataDocBytesPaid);
    expect(dataDocLimit("free")).toBe(256 * 1024);
    expect(dataDocLimit("paid")).toBe(1024 * 1024);
    expect(dataDocTooLargeMessage("free")).toBe(
      "Data docs are limited to 256 KB on this instance; Workers Paid allows 1 MB.",
    );
  });
  it("/mcp body: Free = 2 × inline + 64 KB (320 KB), Paid = Paid doc + 64 KB", () => {
    expect(LIMITS.mcpBodyBytesFree).toBe(2 * LIMITS.inlineBytes + 64 * 1024);
    expect(LIMITS.mcpBodyBytesFree).toBe(320 * 1024);
    expect(LIMITS.mcpBodyBytesPaid).toBe(LIMITS.dataDocBytesPaid + 64 * 1024);
    expect(mcpBodyLimit("free")).toBe(LIMITS.mcpBodyBytesFree);
    expect(mcpBodyLimit("paid")).toBe(LIMITS.mcpBodyBytesPaid);
    const m = mcpTooLargeMessage("free");
    expect(m).toContain("320 KB");
    expect(m).toContain("create_upload({ path, size, contentType })");
    expect(m).toContain(
      "Data docs on this instance are limited to 256 KB; clients that escape non-ASCII as \\u inflate the request, so send UTF-8 or use the REST data API. Workers Paid allows 1 MB.",
    );
  });
});

describe("DisplayNameSchema", () => {
  const ok = (v: unknown) => DisplayNameSchema.safeParse(v).success;
  it("trims and accepts 1–80 characters", () => {
    expect(DisplayNameSchema.parse("  Ada Lovelace ")).toBe("Ada Lovelace");
    expect(ok("x".repeat(80))).toBe(true);
    expect(ok("😀".repeat(80))).toBe(true);
    expect(ok("José Núñez")).toBe(true);
  });
  it("rejects blank, too long, controls, CR/LF, bidi and zero-width", () => {
    for (const v of [
      "",
      "   ",
      "x".repeat(81),
      "a\nb",
      "a\rb",
      "a\tb",
      "a\u0007b",
      "a\u0085b",
      "a\u202eb",
      "a\u2066b",
      "a\u200eb",
      "a\u061cb",
      "a\u200bb",
      "a\u200db",
      "a\u2060b",
      "a\ufeffb",
      42,
      null,
    ])
      expect(ok(v), JSON.stringify(v)).toBe(false);
  });
});

// #681: allowAnonymousWrites is still accepted on input and maps onto
// dataWriters; dataWriters wins when both are sent.
describe("resolveDataWriters", () => {
  const VIS = ["private", "team", "public"] as const;
  const DW = [undefined, "viewers", "editors"] as const;
  const AAW = [undefined, true, false] as const;
  for (const vis of VIS)
    for (const dataWriters of DW)
      for (const allowAnonymousWrites of AAW) {
        const want =
          dataWriters ??
          (allowAnonymousWrites === true
            ? "viewers"
            : allowAnonymousWrites === false && vis === "public"
              ? "editors"
              : undefined);
        it(`${vis} dataWriters=${dataWriters} allowAnonymousWrites=${allowAnonymousWrites} -> ${want}`, () => {
          expect(
            resolveDataWriters({ dataWriters, allowAnonymousWrites }, vis),
          ).toBe(want);
        });
      }

  it("publish, PATCH and set_visibility accept both fields", () => {
    const both = { dataWriters: "editors", allowAnonymousWrites: true };
    expect(
      PublishInputSchema.safeParse({
        title: "t",
        format: "html",
        content: "x",
        ...both,
      }).success,
    ).toBe(true);
    expect(ArtifactPatchSchema.safeParse(both).success).toBe(true);
    expect(
      SetVisibilityInputSchema.safeParse({
        id: newId(),
        visibility: "public",
        ...both,
      }).success,
    ).toBe(true);
    expect(
      ArtifactPatchSchema.safeParse({ dataWriters: "anyone" }).success,
    ).toBe(false);
    expect(ArtifactSummarySchema.shape.dataWriters).toBeDefined();
  });
});

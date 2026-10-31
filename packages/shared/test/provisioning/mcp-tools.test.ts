import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FREE_TEXT,
  fixtureAudit,
  fixtureInstall,
  fixtureJob,
  fixtureMe,
  fixtureSummary,
  fixtureWorld,
} from "../../src/provisioning/fixtures.js";
import {
  ADMIN_TOOLS,
  AdminToolNameSchema,
  API_ERROR_CODES,
  AUTHZ,
  bodyVariants,
  MCP_ERROR_RESULT,
  MCP_PROMPTS,
  MCP_SERVER,
  mcpInstructions,
  NO_TOOL,
  REQUEST_ID_HINT,
  ROUTE_IDS,
  ROUTES,
  type RouteDef,
  type RouteId,
  TOOL_OMIT,
  toolAnnotations,
  toolInput,
  toolOutput,
} from "../../src/provisioning/index.js";

/** A tool route's one object body (a union body has no tool). */
const objBody = (r: RouteDef) => {
  const [b, ...more] = bodyVariants(r);
  if (!b || more.length) throw new Error(`${r.id}: union body`);
  return b;
};

const byName = (n: string) => {
  const t = ADMIN_TOOLS.find((t) => t.name === n);
  if (!t) throw new Error(n);
  return t;
};

describe("tool table", () => {
  it("names are unique and AdminToolNameSchema lists them", () => {
    const names = ADMIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(AdminToolNameSchema.options).toEqual(names);
  });

  it("every tool names an existing route; each route at most one tool", () => {
    const routes = ADMIN_TOOLS.map((t) => t.route);
    for (const r of routes) expect(ROUTE_IDS).toContain(r);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("every route whose token column is not 403 has a tool or a no-tool row", () => {
    for (const id of ROUTE_IDS) {
      const t = AUTHZ[id].token;
      const refused = !t.allow && t.code === "forbidden";
      const covered = ADMIN_TOOLS.some((x) => x.route === id) || id in NO_TOOL;
      if (!refused) expect(covered, id).toBe(true);
    }
    // And a tool never fronts a route tokens may not use.
    for (const t of ADMIN_TOOLS)
      expect(AUTHZ[t.route].token.allow, t.name).toBe(true);
    for (const id of Object.keys(NO_TOOL))
      expect(
        ADMIN_TOOLS.some((t) => t.route === id),
        id,
      ).toBe(false);
  });

  it("pins the 9A.5 catalog", () => {
    expect(
      Object.fromEntries(ADMIN_TOOLS.map((t) => [t.name, t.route])),
    ).toEqual({
      whoami: "R1",
      get_world: "R27",
      list_installs: "R2",
      get_install: "R3",
      list_install_jobs: "R14",
      get_job: "R15",
      list_releases: "R16",
      query_audit: "R17",
      check_slug: "R18",
      create_install: "R4",
      upgrade_install: "R5",
      rollback_install: "R6",
      suspend_install: "R7",
      resume_install: "R8",
      retry_install: "R12",
      restore_install: "R10",
      delete_install: "R9",
      purge_install: "R11",
    });
    expect(Object.keys(NO_TOOL).sort()).toEqual(
      ["R13", "R19", "R20", "R21", "R22", "R23", "R24", "R25", "R26"].sort(),
    );
  });
});

describe("derived schemas", () => {
  it("no field name appears in two of params, query and body", () => {
    for (const id of ROUTE_IDS) {
      const r = ROUTES[id];
      for (const b of bodyVariants(r)) {
        const keys = [r.params, r.query, b].flatMap((s) =>
          Object.keys(s.shape),
        );
        expect(new Set(keys).size, id).toBe(keys.length);
      }
    }
  });

  it("input = params + query + body less TOOL_OMIT, strict; purge has no skipDirectoryRevoke (9A.5)", () => {
    expect(Object.keys(toolInput(byName("get_install")).shape)).toEqual(["id"]);
    expect(Object.keys(toolInput(byName("get_job")).shape)).toEqual(["jobId"]);
    expect(Object.keys(toolInput(byName("whoami")).shape)).toEqual([]);
    expect(
      Object.keys(toolInput(byName("suspend_install")).shape).sort(),
    ).toEqual(["id", "reason", "requestId"]);
    expect(
      Object.keys(toolInput(byName("purge_install")).shape).sort(),
    ).toEqual(["confirmSlug", "id", "requestId"]);
    // Parity note: sent anyway, it is -32602 on /mcp, 403 forbidden on /v1.
    expect(
      toolInput(byName("purge_install")).safeParse({
        id: "iabcdefgh234",
        requestId: "r".repeat(16),
        confirmSlug: "acme",
        skipDirectoryRevoke: { reason: "directory gone" },
      }).success,
    ).toBe(false);
    expect(byName("purge_install").description).not.toContain(
      "skipDirectoryRevoke",
    );
    for (const [route, fields] of Object.entries(TOOL_OMIT))
      for (const f of fields ?? [])
        expect(
          Object.keys(objBody(ROUTES[route as RouteId]).shape),
          `${route}.${f}`,
        ).toContain(f);
    expect(
      Object.keys(toolInput(byName("list_installs")).shape).sort(),
    ).toEqual(["cursor", "limit", "q", "source", "state"]);
    const inp = toolInput(byName("get_install"));
    expect(inp.safeParse({ id: "iabcdefgh234", extra: 1 }).success).toBe(false);
  });

  it("input fields are the route's own schemas, never hand-written", () => {
    for (const t of ADMIN_TOOLS) {
      const r = ROUTES[t.route];
      const shape = toolInput(t).shape as Record<string, z.ZodType>;
      const own = {
        ...r.params.shape,
        ...r.query.shape,
        ...objBody(r).shape,
      } as Record<string, z.ZodType>;
      for (const [k, v] of Object.entries(shape))
        expect(v, `${t.name}.${k}`).toBe(own[k]);
    }
  });

  it("output = the route's 2xx response; every schema renders as JSON Schema", () => {
    for (const t of ADMIN_TOOLS) {
      expect(toolOutput(t), t.name).toBe(ROUTES[t.route].response);
      expect(
        () => z.toJSONSchema(toolInput(t), { io: "input" }),
        t.name,
      ).not.toThrow();
      expect(
        () => z.toJSONSchema(toolOutput(t), { io: "output" }),
        t.name,
      ).not.toThrow();
    }
  });

  it("defaults: limit 20 on list tools only, within the route cap", () => {
    for (const t of ADMIN_TOOLS) {
      const list = [
        "list_installs",
        "list_install_jobs",
        "query_audit",
      ].includes(t.name);
      expect(t.defaults, t.name).toEqual(list ? { limit: 20 } : undefined);
      if (t.defaults)
        expect(
          toolInput(t).partial().safeParse(t.defaults).success,
          t.name,
        ).toBe(true);
    }
  });
});

describe("annotations", () => {
  it("readOnlyHint iff GET; destructive for suspend, rollback, delete, purge", () => {
    for (const t of ADMIN_TOOLS) {
      const a = toolAnnotations(t);
      expect(a.readOnlyHint, t.name).toBe(ROUTES[t.route].method === "GET");
      expect(a.destructiveHint, t.name).toBe(
        [
          "suspend_install",
          "rollback_install",
          "delete_install",
          "purge_install",
        ].includes(t.name),
      );
      expect(a.idempotentHint, t.name).toBe(true);
      expect(a.openWorldHint, t.name).toBe(false);
      expect(t.annotations, t.name).toEqual(a);
    }
  });

  it("write descriptions carry the requestId rule; destructive ones the confirmSlug rule", () => {
    for (const t of ADMIN_TOOLS) {
      if (ROUTES[t.route].write)
        expect(t.description, t.name).toContain(REQUEST_ID_HINT);
      if ("confirmSlug" in objBody(ROUTES[t.route]).shape)
        expect(t.description, t.name).toContain("confirmSlug");
      expect(t.description, t.name).not.toContain("—");
    }
  });
});

describe("summaries", () => {
  const BODY: Record<string, unknown> = {
    whoami: fixtureMe(),
    get_world: fixtureWorld(),
    list_installs: { items: [fixtureInstall()], nextCursor: "abc" },
    get_install: fixtureInstall(),
    list_install_jobs: { items: [fixtureJob()], nextCursor: null },
    get_job: fixtureJob(),
    list_releases: {
      items: [
        {
          version: "1.42.0",
          publishedAt: 1,
          variants: ["release"],
          installable: true,
          latest: true,
        },
      ],
    },
    query_audit: { items: [fixtureAudit()], nextCursor: "abc" },
    check_slug: { slug: "acme", status: "ok" },
  };
  const accepted = { job: fixtureJob(), install: fixtureSummary() };

  it("one line per tool", () => {
    for (const t of ADMIN_TOOLS) {
      const line = t.summary((BODY[t.name] ?? accepted) as never);
      expect(line, t.name).toMatch(/^[^\n]+$/);
    }
    expect(
      byName("list_installs").summary(BODY.list_installs as never),
    ).toContain("more: pass cursor");
    expect(
      byName("list_install_jobs").summary(BODY.list_install_jobs as never),
    ).not.toContain("more");
    expect(byName("check_slug").summary(BODY.check_slug as never)).toBe(
      "acme: ok",
    );
  });

  it("free text never reaches a content line", () => {
    for (const t of ADMIN_TOOLS) {
      const line = t.summary((BODY[t.name] ?? accepted) as never);
      for (const f of FREE_TEXT)
        expect(line, `${t.name}: ${f}`).not.toContain(f);
      expect(line, t.name).not.toMatch(/@/);
    }
  });
});

describe("errors, identity, prompts", () => {
  it("every ApiErrorCode has an MCP result", () => {
    expect(Object.keys(MCP_ERROR_RESULT).sort()).toEqual(
      [...API_ERROR_CODES].sort(),
    );
    expect(MCP_ERROR_RESULT.forbidden).toBe("tool_error");
    expect(MCP_ERROR_RESULT.csrf_failed).toBe("never");
    expect(MCP_ERROR_RESULT.payload_too_large).toBe("http_413");
  });

  it("server identity and instructions", () => {
    expect(MCP_SERVER.name).toBe("open-artifacts-admin");
    expect(MCP_SERVER.title("prod")).toBe("Open Artifacts admin (prod)");
    const i = mcpInstructions("staging", "open-artifacts-staging.app");
    expect(
      i.startsWith("Open Artifacts admin, staging. Start with get_world"),
    ).toBe(true);
    expect(i).toContain("https://admin.open-artifacts-staging.app");
    expect(i).not.toContain("<env>");
    expect(i).not.toContain("—");
  });

  it("prompts name only read tools", () => {
    const reads = new Set(
      ADMIN_TOOLS.filter((t) => ROUTES[t.route].method === "GET").map(
        (t) => t.name,
      ),
    );
    for (const p of MCP_PROMPTS) {
      const named = [...p.text.matchAll(/\b([a-z]+_[a-z_]+|whoami)\b/g)].map(
        (m) => m[1],
      );
      for (const n of named) {
        const t = AdminToolNameSchema.safeParse(n);
        if (t.success) expect(reads.has(t.data), `${p.name}: ${n}`).toBe(true);
      }
      expect(p.text).toContain("Do not write anything.");
    }
    expect(MCP_PROMPTS.map((p) => p.name)).toEqual([
      "triage",
      "investigate_install",
    ]);
  });
});

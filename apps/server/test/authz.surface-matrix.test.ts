// P3 T16: every caller on every artifact through every surface (REST, list
// and search, data and storage, content, sockets, all MCP tools), and every
// caller on every instance route, against the hand-written tables in
// test/authz/expect.ts. Then the customer_mismatch world: synced callers
// fail closed, and only the org owner's break-glass reaches the directory.
import { env } from "cloudflare:workers";
import { BreakGlassRequiredDetailsSchema, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../scripts/authz-probe.ts";
import { createApp } from "../src/app.js";
import {
  CONTENT_POLICY,
  ROUTE_POLICY,
  TOOL_POLICY,
} from "../src/auth/route-policy.js";
import { contentApp } from "../src/content/app.js";
import { DIRECTORY_DISCONNECT_CRON, scheduled } from "../src/cron.js";
import manifest from "../src/mcp/tool-manifest.json";
import {
  ARTIFACTS,
  type ArtifactName,
  CALLERS,
  type CallerName,
  expected,
  orgExpected,
  spaceExpected,
  TRAITS,
  type Traits,
} from "./authz/expect.ts";
import {
  BASE,
  buildWorld,
  cookieOf,
  googleCookie,
  io,
  mismatchHealth,
  staleHealth,
  type World,
} from "./authz/fixture.ts";
import {
  type Cred,
  contentUnlisted,
  ORG_SURFACES,
  type OrgTarget,
  SPACE_SURFACES,
  type SpaceTarget,
  SURFACES,
  type Surface,
  uncovered,
  unlisted,
} from "./authz/surfaces.ts";

let w: World;
let target: OrgTarget;
let space: SpaceTarget;
beforeAll(async () => {
  w = await buildWorld();
  target = {
    spaceId: w.spaces.S,
    memberId: w.users.otherMember as string,
    departedId: w.users.removedUser as string,
  };
  space = {
    spaceId: w.spaces.S,
    personalSpaceId: w.spaces.otherPersonal,
    memberId: w.users.otherMember as string,
    editorId: w.users.spaceEditor as string,
    managerId: w.users.spaceManager as string,
    groups: w.groups,
  };
}, 120_000);
/**
 * One Worker call's bound under suite load: the base config's testTimeout
 * (vitest.config.ts), which every single-call test lives under.
 */
const CALL_MS = 20_000;
/**
 * The most Worker calls a cell makes in sequence: a clone (mutating
 * surfaces), then the probe's mint or MCP call, then the content load.
 */
const CALLS_PER_CELL = 3;
/**
 * Probe-heavy tests: a row's cells (one per artifact) run concurrently on one
 * workerd, so under machine load they queue behind each other; the window is
 * every call of the row at its own bound, not a guess (it was a flat 120 s,
 * which the content and socket rows overran under load).
 */
const SLOW = CALL_MS * CALLS_PER_CELL * ARTIFACTS.length;

type RouteDef = { method: string; path: string; handler: { length: number } };
/** Answering routes only (middleware are ALL routes taking (c, next)). */
const answering = (routes: readonly RouteDef[]) => [
  ...new Set(
    routes
      .filter((r) => !(r.method === "ALL" && r.handler.length >= 2))
      .map((r) => `${r.method} ${r.path}`),
  ),
];

describe("coverage (derived from the router and the registries)", () => {
  it("SURFACES cover every artifact entry in ROUTE_POLICY and every MCP tool", () => {
    expect(uncovered(SURFACES, ROUTE_POLICY, TOOL_POLICY)).toEqual([]);
    expect(manifest.map((t) => t.name).sort()).toEqual(
      Object.keys(TOOL_POLICY).sort(),
    );
  });
  it("every mounted app route is listed (artifact surface, instance route or public)", () => {
    const mounted = answering(createApp().routes as RouteDef[]);
    expect(unlisted(Object.fromEntries(mounted.map((k) => [k, {}])))).toEqual(
      [],
    );
    expect(unlisted(ROUTE_POLICY)).toEqual([]);
  });
  it("every content-host route and CONTENT_POLICY key is probed or public", () => {
    const mounted = answering(contentApp.routes as RouteDef[]);
    expect(contentUnlisted(mounted)).toEqual([]);
    expect(contentUnlisted(Object.keys(CONTENT_POLICY))).toEqual([]);
    expect(mounted).toContain("GET /*");
    expect(
      SURFACES.filter((s) => s.routes.includes("content:GET /*")),
    ).toHaveLength(3);
  });
  it("every listed route is a real registry entry", () => {
    const known = new Set([
      ...Object.keys(ROUTE_POLICY),
      ...Object.keys(TOOL_POLICY).map((t) => `tool:${t}`),
      ...Object.keys(CONTENT_POLICY).map((k) => `content:${k}`),
    ]);
    expect(
      [
        ...SURFACES.flatMap((s) => s.routes),
        ...ORG_SURFACES.map((s) => s.route),
        ...SPACE_SURFACES.map((s) => s.route),
      ].filter((r) => !known.has(r)),
    ).toEqual([]);
  });
  it("ORG_SURFACES rules match ROUTE_POLICY", () => {
    // offWhen (feature-off 404s, T19) is not an access rule.
    for (const s of ORG_SURFACES) {
      const { offWhen: _, ...p } = ROUTE_POLICY[s.route] as {
        offWhen?: string;
      };
      expect(p, s.route).toEqual(
        "user" in s.rule ? { user: expect.any(String) } : s.rule,
      );
    }
    for (const s of SPACE_SURFACES)
      expect(ROUTE_POLICY[s.route], s.route).toEqual({
        user: expect.any(String),
      });
  });
});

/**
 * Known bugs, pinned so the suite stays green and fails once they are fixed
 * (then delete the entry). None today (B1, a restricted member's PAT at
 * /mcp, was fixed in #606).
 */
const KNOWN: Partial<Record<CallerName, { via: string; traits: Traits }>> = {};

/** One caller's row on one surface: every artifact, probed. */
async function row(
  s: Surface,
  cred: Cred,
  want: (art: ArtifactName) => string,
  ids: Record<ArtifactName, string> = w.ids,
) {
  const got = {} as Record<ArtifactName, string>;
  const exp = {} as Record<ArtifactName, string>;
  await Promise.all(
    ARTIFACTS.map(async (art) => {
      const id = s.mutates === "access" ? await w.clone(art) : ids[art];
      got[art] = await s
        .probe(BASE, cred, id, io)
        .catch((e: Error) => `error: ${e.message}`);
      exp[art] = want(art);
    }),
  );
  return { got, exp };
}

const want = (who: CallerName, s: Surface) => (art: ArtifactName) => {
  const bug = KNOWN[who];
  return expected(
    who,
    art,
    s.action,
    s.via,
    bug?.via === s.via ? bug.traits : TRAITS[who],
  );
};

describe("artifact surfaces (sync stale 8 days)", () => {
  describe.each(SURFACES.map((s) => ({ ...s })))("$name", (s) => {
    it.concurrent.each(CALLERS.map((c) => [c]))(
      "%s",
      async (who) => {
        const { got, exp } = await row(s, w.creds[who], want(who, s));
        expect(got).toEqual(exp);
      },
      SLOW,
    );
    it.concurrent(
      "staleSynced's PAT (its grant runs above)",
      async () => {
        const cred = { ...w.creds.staleSynced, token: w.staleSyncedPat };
        const { got, exp } = await row(s, cred, want("staleSynced", s));
        expect(got).toEqual(exp);
      },
      SLOW,
    );
    // The 24 h browser-session cap while sync is unhealthy (T18): a synced
    // user's 25 h old cookie resolves to no one; a 23 h one still works.
    it.concurrent.each([
      [25, "anonymous"],
      [23, "staleSynced"],
    ] as const)(
      "staleSynced's %i h old cookie",
      async (hours, as) => {
        const cred = {
          cookie: await cookieOf(
            w.users.staleSynced as string,
            hours * 3_600_000,
          ),
        };
        const { got, exp } = await row(s, cred, (art) =>
          s.via === "rest"
            ? expected(as, art, s.action, s.via)
            : expected("anonymous", art, s.action, s.via),
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });
});

// #681: the same data-write and anon-id surfaces on copies of every artifact
// with dataWriters "editors": only uncapped editors and up write; nobody
// gets an anon id.
describe("artifact surfaces, dataWriters editors (#681)", () => {
  describe.each(
    SURFACES.filter((s) => s.action === "data.write" || s.action === "anonId"),
  )("$name", (s) => {
    it.concurrent.each(CALLERS.map((c) => [c]))(
      "%s",
      async (who) => {
        const { got, exp } = await row(
          s,
          w.creds[who],
          (art) => expected(who, art, s.action, s.via, TRAITS[who], "editors"),
          w.editorsOnly,
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });
});

describe("instance routes", () => {
  describe.each(ORG_SURFACES.map((s) => ({ ...s })))("$route", (s) => {
    it.concurrent(
      "every caller",
      async () => {
        const got = {} as Record<CallerName, string>;
        const exp = {} as Record<CallerName, string>;
        await Promise.all(
          CALLERS.map(async (who) => {
            got[who] = await s
              .probe(BASE, w.creds[who], target, io)
              .catch((e: Error) => `error: ${e.message}`);
            exp[who] = orgExpected(who, s.rule);
          }),
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });
});

describe("directory disconnect: cookie sessions only, plus the platform system job", () => {
  it("no bearer token disconnects, the org owner's PAT included", async () => {
    const got: Record<string, number> = {};
    for (const who of CALLERS) {
      const token = w.creds[who].token;
      if (!token) continue;
      for (const method of ["POST", "DELETE"] as const) {
        const r = await createApp().fetch(
          new Request(
            `${BASE}${method === "POST" ? R.directoryDisconnect : R.directory}`,
            { method, headers: { authorization: `Bearer ${token}` } },
          ),
          env as never,
          { waitUntil: () => {}, passThroughOnException: () => {} } as never,
        );
        await r.body?.cancel();
        got[`${who} ${method}`] = r.status;
      }
    }
    expect(Object.keys(got)).toContain("orgOwner POST");
    for (const [k, s] of Object.entries(got))
      expect([401, 403, 404], k).toContain(s);
  });

  it("system jobs run only by scheduled() name; an unknown one is refused", async () => {
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    await expect(
      scheduled({ cron: DIRECTORY_DISCONNECT_CRON }, env as never, ctx),
    ).resolves.toBeUndefined();
    await expect(
      scheduled({ cron: "oa:directory-disconnect-x" }, env as never, ctx),
    ).rejects.toThrow("unknown system job");
  });
});

describe("space writes (the service rules behind { user })", () => {
  describe.each(SPACE_SURFACES.map((s) => ({ ...s })))("$name", (s) => {
    it.concurrent(
      "every caller",
      async () => {
        const got = {} as Record<CallerName, string>;
        const exp = {} as Record<CallerName, string>;
        await Promise.all(
          CALLERS.map(async (who) => {
            const t = s.mutates
              ? { ...space, cloneId: await w.cloneSpace() }
              : space;
            got[who] = await s
              .probe(BASE, w.creds[who], t, io)
              .catch((e: Error) => `error: ${e.message}`);
            exp[who] = spaceExpected(who, s.rule);
          }),
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });
});

describe("attack seeds: another member's personal space", () => {
  const send = (path: string, cookie: string, method = "GET", body?: unknown) =>
    io.fetch?.(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          cookie,
          "x-oa-request": "1",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    ) as Promise<Response>;
  const count = async (space: string) =>
    (
      await env.DB.prepare(
        "select count(*) n from artifacts where space_id = ?",
      )
        .bind(space)
        .first<{ n: number }>()
    )?.n ?? 0;

  it("publish into it, move into it and list it are refused for everyone else", async () => {
    const other = w.spaces.otherPersonal;
    const before = await count(other);
    for (const who of ["orgOwner", "spaceManager", "personalOwner"] as const) {
      const cookie = w.creds[who].cookie as string;
      const pub = await send(R.artifacts, cookie, "POST", {
        title: "x",
        format: "html",
        content: "<p>x</p>",
        spaceId: other,
      });
      expect([400, 403, 404], `${who} publish`).toContain(pub.status);
      const art = await w.clone(
        who === "personalOwner" ? "personalPrivate" : "spacePrivate",
      );
      const mv = await send(`${R.artifact(art)}/move`, cookie, "POST", {
        spaceId: other,
      });
      expect([400, 403, 404], `${who} move`).toContain(mv.status);
      const ls = await send(
        `${R.artifacts}?scope=space&spaceId=${other}`,
        cookie,
      );
      expect([400, 403, 404], `${who} list`).toContain(ls.status);
    }
    expect(await count(other)).toBe(before);
  });
});

describe("scripts/authz-probe.ts against this world (read-only cells)", () => {
  const names = [
    ...SURFACES.filter((s) => !s.mutates).map((s) => s.name),
    ...ORG_SURFACES.filter((s) => !s.mutates).map((s) => s.route),
    ...SPACE_SURFACES.filter((s) => !s.mutates).map((s) => s.name),
  ];
  it.concurrent.each(names.map((n) => [n]))(
    "%s",
    async (name) => {
      const lines: string[] = [];
      const code = await main(
        ["--base", BASE, "--creds", "world.json"],
        {},
        {
          log: (l) => lines.push(l),
          fetch: io.fetch,
          only: (n) => n === name,
          readFile: async () =>
            JSON.stringify({
              callers: w.creds,
              artifacts: w.ids,
              org: target,
              space,
              contentBase: io.contentBase,
            }),
        },
      );
      expect(lines.filter((l) => l.startsWith("MISMATCH"))).toEqual([]);
      expect(code).toBe(0);
      expect(lines.at(-1)).toMatch(/^[1-9]\d* cells, \d+ mismatches$/);
    },
    SLOW,
  );
});

// Last: it changes the instance's health for everything after it.
describe("customer_mismatch: synced callers resolve to no one", () => {
  beforeAll(mismatchHealth);
  afterAll(staleHealth);
  const SYNCED = ["orgOwner", "staleSynced"] as const;

  describe.each(SURFACES.map((s) => ({ ...s })))("$name", (s) => {
    it.concurrent.each([
      ...SYNCED.map((c) => [c, "cookie and token"] as const),
      ["staleSynced", "PAT"] as const,
    ])(
      "%s (%s)",
      async (who, kind) => {
        const cred =
          kind === "PAT"
            ? { ...w.creds[who], token: w.staleSyncedPat }
            : w.creds[who];
        const { got, exp } = await row(s, cred, (art) =>
          expected("anonymous", art, s.action, s.via),
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });

  it("GET R.me: the org owner gets break_glass_required, a synced member a plain 401", async () => {
    const me = (cookie: string) =>
      io.fetch?.(
        new Request(`${BASE}${R.me}`, { headers: { cookie } }),
      ) as Promise<Response>;
    const owner = await me(await googleCookie(w.users.orgOwner as string));
    expect(owner.status).toBe(401);
    const e = (
      (await owner.json()) as { error: { code: string; details: unknown } }
    ).error;
    expect(e.code).toBe("break_glass_required");
    expect(BreakGlassRequiredDetailsSchema.parse(e.details)).toEqual({
      fresh: true,
    });
    const member = await me(w.creds.staleSynced.cookie as string);
    expect(member.status).toBe(401);
    expect(
      ((await member.json()) as { error: { code: string } }).error.code,
    ).toBe("unauthorized");
  });

  /** Directory routes break-glass opens (T18); the rest stay anonymous. */
  const BREAK_GLASS = new Set([
    "GET /api/v1/directory",
    "GET /api/v1/directory/connect",
    "GET /api/v1/directory/callback",
    "POST /api/v1/directory/confirm",
    "POST /api/v1/directory/cancel",
    "POST /api/v1/directory/sync",
  ]);
  it(
    "break-glass: the owner's fresh forced Google session reaches the directory routes only",
    async () => {
      const cred = { cookie: await googleCookie(w.users.orgOwner as string) };
      const got: Record<string, string> = {};
      const exp: Record<string, string> = {};
      await Promise.all(
        ORG_SURFACES.map(async (s) => {
          got[s.route] = await s
            .probe(BASE, cred, target, io)
            .catch((e: Error) => `error: ${e.message}`);
          exp[s.route] = BREAK_GLASS.has(s.route) ? "allow" : "deny";
        }),
      );
      expect(got).toEqual(exp);
      // A public artifact still opens, as for anyone.
      const pub = await io.fetch?.(
        new Request(`${BASE}${R.artifact(w.ids.spacePublic)}`, {
          headers: { cookie: cred.cookie },
        }),
      );
      expect(pub?.status).toBe(200);
    },
    SLOW,
  );
  describe.each(
    SURFACES.filter((x) => x.via === "rest").map((s) => ({ ...s })),
  )("break-glass session on $name", (s) => {
    it.concurrent(
      "is anonymous",
      async () => {
        const cred = {
          cookie: await googleCookie(w.users.orgOwner as string),
        };
        const { got, exp } = await row(s, cred, (art) =>
          expected("anonymous", art, s.action, s.via),
        );
        expect(got).toEqual(exp);
      },
      SLOW,
    );
  });
});

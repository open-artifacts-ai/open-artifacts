import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORG_SURFACES,
  SPACE_SURFACES,
  SURFACES,
} from "../../../apps/server/test/authz/surfaces.ts";
import { HttpError, hook, hookReason, SetupHookError } from "../src/http.ts";
import {
  crossProbe,
  crossWrite,
  NotRefused,
  type ProbeFetch,
  registerMarker,
  type Side,
  type Verdict,
} from "../src/refused.ts";
import { parseManifest } from "../src/report.ts";
import {
  citationGaps,
  cleanup,
  coverageGaps,
  DROPPED,
  derive,
  HOOK_SPACE_ID,
  HOSTED_FEATURES,
  readRepoFile,
  viaTarget,
  worldSpaces,
} from "../src/surfaces.ts";
import { loadTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const toDispose: (() => unknown)[] = [];
afterEach(async () => {
  for (const d of toDispose.splice(0)) await d();
});

describe("probe cases (derived from Backend's surfaces)", () => {
  const d = derive();
  const { cases, dropped } = d;

  it("cover every ROUTE_POLICY route, MCP tool and content route", () => {
    expect(coverageGaps(d)).toEqual([]);
  });

  it("flag a route, a tool or a content route no case reaches", () => {
    const without = (r: string) =>
      coverageGaps({
        cases: cases.filter((c) => !c.routes.includes(r)),
        dropped: dropped.filter((x) => !x.routes.includes(r)),
      });
    expect(without("GET /api/v1/me")).toContain("no case: GET /api/v1/me");
    expect(without("tool:list_spaces")).toContain("no case: tool:list_spaces");
    expect(without("content:GET /*")).toContain("no case: content:GET /*");
  });

  it("flag a case list shorter than the policy manifest", () => {
    const gaps = coverageGaps({ cases: cases.slice(0, 10), dropped });
    expect(
      gaps.some((g) => /cases and exclusions < \d+ scoped routes/.test(g)),
    ).toBe(true);
  });

  it("flag a drop DROPPED doesn't record, and a recorded drop the rules don't make", () => {
    const extra = {
      name: "org GET /api/v1/new-owner-only",
      routes: ["GET /api/v1/new-owner-only"],
      why: "owner-only" as const,
      reason: "r",
    };
    expect(coverageGaps({ cases, dropped: [...dropped, extra] })).toContain(
      "drop not recorded in DROPPED: org GET /api/v1/new-owner-only (owner-only)",
    );
    const [first, ...rest] = dropped;
    expect(first).toBeDefined();
    expect(coverageGaps({ cases, dropped: rest })).toContain(
      `DROPPED lists a surface the rules don't drop: ${first?.name}`,
    );
  });

  it("never count a route reached only by a drop as covered", () => {
    // Dropping the only case for a route leaves a gap, not a pass.
    const gaps = coverageGaps({
      cases: cases.filter((c) => !c.routes.includes("GET /api/v1/settings")),
      dropped: [
        ...dropped,
        {
          name: "org GET /api/v1/settings",
          routes: ["GET /api/v1/settings"],
          why: "owner-only",
          reason: "r",
        },
      ],
    });
    expect(gaps).toContain("no case: GET /api/v1/settings");
  });

  it("flag an exclusion a case reaches (stale)", () => {
    const fake = {
      name: "org GET /api/v1/usage [pat]",
      routes: ["GET /api/v1/usage"],
      variant: "pat" as const,
      run: async () => "allow" as const,
    };
    expect(coverageGaps({ cases: [...cases, fake], dropped })).toContain(
      "stale exclusion: GET /api/v1/usage",
    );
  });

  it("drop a route a hosted FEATURES flag turns off (usage_off)", () => {
    expect(HOSTED_FEATURES).toContain("usage_off");
    expect(dropped.find((x) => x.name === "org GET /api/v1/usage")?.why).toBe(
      "feature-off",
    );
  });

  it("record every drop with a reason and a covering test", () => {
    expect(dropped.length).toBe(Object.keys(DROPPED).length);
    for (const x of dropped) {
      expect(DROPPED[x.name]?.why).toBe(x.why);
      expect(DROPPED[x.name]?.coveredBy).not.toBe("");
      expect(x.reason).not.toBe("");
    }
  });

  it("have unique names; every surface is a case or a recorded drop", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    const prefixes = [
      ...SURFACES.map((s) => `artifact ${s.name}`),
      ...ORG_SURFACES.map((s) => `org ${s.route}`),
      ...SPACE_SURFACES.map((s) => `space ${s.name}`),
    ];
    for (const p of prefixes)
      expect(
        p in DROPPED || cases.some((c) => c.name.startsWith(`${p} [`)),
      ).toBe(true);
  });

  it("run every mutating probe through crossWrite on a throwaway, never on the world", () => {
    const mutating = new Set([
      ...SURFACES.filter((s) => s.mutates).map((s) => `artifact ${s.name}`),
      ...ORG_SURFACES.filter((s) => s.mutates).map((s) => `org ${s.route}`),
      ...SPACE_SURFACES.filter((s) => s.mutates).map((s) => `space ${s.name}`),
    ]);
    expect(mutating.size).toBeGreaterThan(0);
    for (const c of cases) {
      const base = c.name.replace(/ \[(session|pat)\]$/, "");
      if (mutating.has(base)) {
        expect(c.write).toBeDefined();
        expect(c.run).toBeUndefined();
      } else {
        expect(c.run).toBeDefined();
        expect(c.write).toBeUndefined();
      }
    }
  });

  it("are all in the required-case manifest, and no drop is", () => {
    const m = parseManifest(
      readFileSync(join(import.meta.dirname, "../live/manifest.json"), "utf8"),
    );
    const listed = new Set(
      m.cases
        .filter((c) => c.file === "live/surfaces.test.ts")
        .map((c) => c.name),
    );
    const want = [
      "every ROUTE_POLICY route, MCP tool and content route has a case",
      ...cases.map((c) => c.name),
    ].map((n) => `surface probes (cross-install) > ${n}`);
    expect([...listed].sort()).toEqual([...want].sort());
  });
});

// ------------------------------------------------------------ crossProbe

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

async function fake(h?: Parameters<typeof fakeServer>[0]): Promise<Fake> {
  const f = await fakeServer(h);
  toDispose.push(() => f.close());
  return f;
}

/** A fake install: /api/v1/me answers 200 (and `body`) for `token`, else `refuse`. */
const install = (installId: string, token: string, refuse = 401, body = "{}") =>
  ((req, res) => {
    if (req.url === "/healthz")
      return json(res, 200, { ok: true, testHooks: true, installId });
    if (req.headers.authorization === `Bearer ${token}`)
      return res.writeHead(200).end(body);
    res.writeHead(refuse).end(body);
  }) as Parameters<typeof fakeServer>[0];

async function pair(a: Fake, b: Fake) {
  const s = secretDir({ "a-key": KEY_A, "b-key": KEY_B });
  toDispose.push(s.cleanup);
  const t = (name: string, f: Fake, file: string, domain: string) => ({
    name,
    installId: `${name}-id`,
    app: f.origin,
    content: `http://${name}.content.localhost:1`,
    testDomain: domain,
    hookKeyFile: s.path(file),
  });
  return loadTargets({
    REDLINE_TARGETS: JSON.stringify({
      mode: "local",
      a: t("rl-a", a, "a-key", "oa-redline-a.fyi"),
      b: t("rl-b", b, "b-key", "oa-redline-c.fyi"),
    }),
  });
}

/** The fakes' credentials are bearer tokens. */
const bearer = (r: Request, c: string) =>
  r.headers.get("authorization") === `Bearer ${c}`;

/** A probe in Backend's shape: allow on 200, deny on 401/404, else throws (quoting the body). */
const me = async (
  token: string,
  t: Target,
  f: ProbeFetch,
): Promise<Verdict> => {
  const r = await f(
    new Request(`${t.app}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const text = await r.text();
  if (r.status === 200) return "allow";
  if (r.status === 401 || r.status === 404) return "deny";
  throw new Error(`unexpected ${r.status} ${text}`);
};

describe("crossProbe", () => {
  it("passes when each install allows only its own credential", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb")),
    );
    await expect(
      crossProbe(me, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails when B's own credential is denied (a B that refuses everything)", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "nothing")),
    );
    await expect(
      crossProbe(me, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/B's own credential failed at B/);
  });

  it("fails when A's credential is denied at A", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "nothing")),
      await fake(install("rl-b-id", "tb")),
    );
    await expect(
      crossProbe(me, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/A's credential failed at A/);
  });

  it("fails when B allows A's credential", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "shared")),
      await fake(install("rl-b-id", "shared")),
    );
    await expect(
      crossProbe(me, {
        a: T.a,
        b: T.b,
        credA: "shared",
        credB: "shared",
        carries: bearer,
      }),
    ).rejects.toThrow(NotRefused);
  });

  it("fails when B's refusal carries a seeded marker, even if the probe says deny", async () => {
    const marker = "REDLINE-rl-b-unitmarker";
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb", 404, `{"title":"${marker}"}`)),
    );
    registerMarker(T.b, marker);
    await expect(
      crossProbe(me, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/seeded marker/);
  });

  it("fails when the cross leg's requests went elsewhere, not to B", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb")),
    );
    // The cross leg asks A instead of B: B never saw A's credential.
    const run = (cred: string, t: Target, f: ProbeFetch) =>
      me(cred, t === T.b && cred === "ta" ? T.a : t, f).then((v) =>
        t === T.b && cred === "ta" ? ("deny" as Verdict) : v,
      );
    await expect(
      crossProbe(run, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/no request carrying A's credential reached B/);
  });

  it("fails when B was reached only without A's credential", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb")),
    );
    // The cross leg asks B with no credential at all.
    const run = (cred: string, t: Target, f: ProbeFetch) =>
      t === T.b && cred === "ta" ? me("", t, f) : me(cred, t, f);
    await expect(
      crossProbe(run, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/no request carrying A's credential reached B/);
  });

  it("fails when no request reached B", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb")),
    );
    const run = (cred: string, t: Target, f: ProbeFetch) =>
      t === T.b && cred === "ta"
        ? Promise.resolve<Verdict>("deny")
        : me(cred, t, f);
    await expect(
      crossProbe(run, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).rejects.toThrow(/no request carrying A's credential reached B/);
  });

  it("a probe error shows status and hashes, never the body", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb", 500, "SECRET-BODY-TEXT")),
    );
    const err = await crossProbe(me, {
      a: T.a,
      b: T.b,
      credA: "ta",
      credB: "nope",
      carries: bearer,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/status 500, body sha256:/);
    expect(String(err)).not.toContain("SECRET-BODY-TEXT");
  });

  it("lets a probe cancel its body (no tee deadlock)", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "tb")),
    );
    const run = async (cred: string, t: Target, f: ProbeFetch) => {
      const r = await f(
        new Request(`${t.app}/api/v1/me`, {
          headers: { authorization: `Bearer ${cred}` },
        }),
      );
      await r.body?.cancel();
      return r.status === 200 ? "allow" : ("deny" as Verdict);
    };
    await expect(
      crossProbe(run, {
        a: T.a,
        b: T.b,
        credA: "ta",
        credB: "tb",
        carries: bearer,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("crossWrite", () => {
  /** Throwaways per install: id -> value; `write` sets one when the token is the install's own. */
  async function world(leakB = false) {
    const store = new Map<string, Map<string, string>>([
      ["rl-a", new Map()],
      ["rl-b", new Map()],
    ]);
    const handler = (name: string, installId: string, token: string) =>
      ((req, res, body) => {
        if (req.url === "/healthz")
          return json(res, 200, { ok: true, testHooks: true, installId });
        const id = req.url?.split("/").pop() ?? "";
        const own = req.headers.authorization === `Bearer ${token}`;
        if (req.method === "PUT" && (own || (leakB && name === "rl-b"))) {
          store.get(name)?.set(id, body);
          return res.writeHead(200).end("{}");
        }
        res.writeHead(401).end("{}");
      }) as Parameters<typeof fakeServer>[0];
    const T = await pair(
      await fake(handler("rl-a", "rl-a-id", "ta")),
      await fake(handler("rl-b", "rl-b-id", "tb")),
    );
    let n = 0;
    const made: string[] = [];
    const disposed: string[] = [];
    const o = {
      a: T.a,
      b: T.b,
      credA: "ta",
      credB: "tb",
      carries: bearer,
      fresh: async (t: Target) => {
        const id = `x${n++}`;
        store.get(t.name)?.set(id, "orig");
        made.push(`${t.name}/${id}`);
        return id;
      },
      snapshot: async (t: Target, x: string) => store.get(t.name)?.get(x) ?? "",
      dispose: async (t: Target, x: string) => {
        disposed.push(`${t.name}/${x}`);
      },
    };
    const write = async (
      cred: string,
      t: Target,
      x: string,
      f: ProbeFetch,
    ): Promise<Verdict> => {
      const r = await f(
        new Request(`${t.app}/w/${x}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${cred}` },
          body: "changed",
        }),
      );
      await r.body?.cancel();
      return r.status === 200 ? "allow" : "deny";
    };
    return { o, write, made, disposed };
  }

  it("passes when each install writes only its own throwaways; disposes all three", async () => {
    const w = await world();
    await expect(crossWrite(w.write, w.o)).resolves.toBeUndefined();
    expect(w.made).toHaveLength(3);
    expect([...w.disposed].sort()).toEqual([...w.made].sort());
  });

  it("fails when B's throwaway changed, even though the probe saw a refusal", async () => {
    const w = await world();
    const sneaky = async (c: string, t: Target, x: string, f: ProbeFetch) => {
      const v = await w.write(c, t, x, f);
      // Something else changed B's throwaway during the cross leg.
      if (c === "ta" && t === w.o.b) await w.write("tb", t, x, f);
      return c === "ta" && t === w.o.b ? "deny" : v;
    };
    await expect(crossWrite(sneaky, w.o)).rejects.toThrow(NotRefused);
    expect([...w.disposed].sort()).toEqual([...w.made].sort());
  });

  it("fails when B accepts A's write, and still disposes every throwaway", async () => {
    const w = await world(true);
    await expect(crossWrite(w.write, w.o)).rejects.toThrow(NotRefused);
    expect(w.made).toHaveLength(3);
    expect([...w.disposed].sort()).toEqual([...w.made].sort());
  });

  it("fails when B's own write is refused (a broken B)", async () => {
    const w = await world();
    const broken = { ...w.o, credB: "nope" };
    await expect(crossWrite(w.write, broken)).rejects.toThrow(
      /B's own credential failed at B/,
    );
    expect([...w.disposed].sort()).toEqual([...w.made].sort());
  });
});

describe("citations and cleanup", () => {
  it("every drop's covering tests exist (file, describe and test)", () => {
    expect(citationGaps(readRepoFile)).toEqual([]);
  });

  it("flag a citation whose describe or test isn't in the file", () => {
    const gaps = citationGaps(() => 'describe("something else")');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((g) => /no describe "instance routes"/.test(g))).toBe(
      true,
    );
    expect(citationGaps(() => null).some((g) => /missing file/.test(g))).toBe(
      true,
    );
  });

  it("cleanup treats a 404 as a failure, not as clean", async () => {
    const f = await fake((_q, res) => res.writeHead(404).end("{}"));
    const side = {
      t: { name: "rl-b", app: f.origin } as Target,
      pat: { kind: "pat", token: "tb" },
    } as unknown as Side;
    await expect(cleanup(side, "/api/v1/artifacts/x")).rejects.toThrow(
      /status 404/,
    );
  });
});

describe("viaTarget", () => {
  const t = {
    app: "http://rl-b.app.localhost:4001",
    content: "http://rl-b.content.localhost:4001",
  } as Target;
  const seen: string[] = [];
  const f = viaTarget(t, async (r) => {
    seen.push(r.url);
    return new Response(null, { status: 204 });
  });

  it("sends a portless loopback content URL to the target's origin", async () => {
    await f(new Request("http://rl-b.content.localhost/c/x/y/v1/?dl=1"));
    expect(seen.at(-1)).toBe(
      "http://rl-b.content.localhost:4001/c/x/y/v1/?dl=1",
    );
  });

  it("never rewrites a non-loopback host", async () => {
    await f(new Request("https://rl-b.open-artifacts-staging.page/c/x"));
    expect(seen.at(-1)).toBe("https://rl-b.open-artifacts-staging.page/c/x");
  });
});

describe("worldSpaces (fixed hook spaces per TEST_DOMAIN)", () => {
  it("ids carry 8 hex of sha256(testDomain) and match the hook's SPACE_ID rule", () => {
    const a = worldSpaces("guests.oa-redline-a.fyi");
    expect(a).toEqual({
      world: expect.stringMatching(/^test-redline-space-[0-9a-f]{8}$/),
      guard: expect.stringMatching(/^test-redline-guard-[0-9a-f]{8}$/),
    });
    expect(a.world.slice(-8)).toBe(a.guard.slice(-8));
    for (const id of Object.values(a))
      expect(HOOK_SPACE_ID.test(id)).toBe(true);
    // Stable per domain (case-insensitive), different for another domain.
    expect(worldSpaces("GUESTS.oa-redline-a.fyi")).toEqual(a);
    expect(worldSpaces("oa-redline-a.fyi").world).not.toBe(a.world);
  });
});

describe("setup hooks", () => {
  const body404 = (reason?: unknown) =>
    JSON.stringify({
      error: {
        code: "not_found",
        message: "Not found secret-body-text",
        ...(reason === undefined ? {} : { details: { reason } }),
      },
    });

  /** /healthz for loadTargets; every hook a 404 with `body`. */
  const refusing =
    (installId: string, body: string): Parameters<typeof fakeServer>[0] =>
    (req, res) =>
      req.url === "/healthz"
        ? json(res, 200, { ok: true, testHooks: true, installId })
        : res.writeHead(404).end(body);

  it("hookReason reads only the fixed enum word", () => {
    expect(hookReason(body404("spaces_blocked"))).toBe("spaces_blocked");
    expect(hookReason(body404("grant_refused"))).toBe("grant_refused");
    expect(hookReason(body404())).toBe("no_reason");
    expect(hookReason(body404("anything else"))).toBe("no_reason");
    expect(hookReason("not json")).toBe("no_reason");
    expect(hookReason("null")).toBe("no_reason");
  });

  it("a setup hook's refusal is infra with the reason and a body hash, never body text", async () => {
    const a = await fake(refusing("rl-a-id", body404("spaces_blocked")));
    const b = await fake(install("rl-b-id", "x"));
    const T = await pair(a, b);
    const e = await hook(T.a, "/__test/session", {}, { setup: true }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SetupHookError);
    const m = (e as Error).message;
    expect(m).toMatch(
      /^infra: setup \/__test\/session spaces_blocked on rl-a \(status 404, body sha256:[0-9a-f]{16} \(\d+ bytes\)\)$/,
    );
    expect(m).not.toContain("secret-body-text");
    // Outside setup, the same answer stays an HttpError (a verdict).
    const v = await hook(T.a, "/__test/session", {}).catch((x: unknown) => x);
    expect(v).toBeInstanceOf(HttpError);
    expect(v).not.toBeInstanceOf(SetupHookError);
  });

  it("a refusal before the key (no reason in the body) says no_reason", async () => {
    const a = await fake(refusing("rl-a-id", body404()));
    const T = await pair(a, await fake(install("rl-b-id", "x")));
    await expect(
      hook(T.a, "/__test/session", {}, { setup: true }),
    ).rejects.toThrow(/^infra: setup \/__test\/session no_reason on rl-a /);
  });
});

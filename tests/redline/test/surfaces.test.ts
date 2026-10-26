import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ORG_SURFACES,
  SPACE_SURFACES,
  SURFACES,
} from "../../../apps/server/test/authz/surfaces.ts";
import {
  crossProbe,
  NotRefused,
  type ProbeFetch,
  registerMarker,
  type Verdict,
} from "../src/refused.ts";
import { parseManifest } from "../src/report.ts";
import { coverageGaps, probeCases, viaTarget } from "../src/surfaces.ts";
import { loadTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const toDispose: (() => unknown)[] = [];
afterEach(async () => {
  for (const d of toDispose.splice(0)) await d();
});

describe("probe cases (derived from Backend's surfaces)", () => {
  const cases = probeCases();

  it("cover every ROUTE_POLICY route, MCP tool and content route", () => {
    expect(coverageGaps(cases)).toEqual([]);
  });

  it("flag a route, a tool or a content route no case reaches", () => {
    const drop = (r: string) =>
      coverageGaps(cases.filter((c) => !c.routes.includes(r)));
    expect(drop("GET /api/v1/me")).toContain("no case: GET /api/v1/me");
    expect(drop("tool:list_spaces")).toContain("no case: tool:list_spaces");
    expect(drop("content:GET /*")).toContain("no case: content:GET /*");
  });

  it("flag a case list shorter than the policy manifest", () => {
    const gaps = coverageGaps(cases.slice(0, 10));
    expect(gaps.some((g) => / cases < \d+ scoped routes/.test(g))).toBe(true);
  });

  it("have unique names, one or more per surface", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
    const prefixes = [
      ...SURFACES.map((s) => `artifact ${s.name}`),
      ...ORG_SURFACES.map((s) => `org ${s.route}`),
      ...SPACE_SURFACES.map((s) => `space ${s.name}`),
    ];
    for (const p of prefixes)
      expect(
        cases.some((c) => c.name === p || c.name.startsWith(`${p} [`)),
      ).toBe(true);
  });

  it("never run a mutating probe; skipped cases carry a non-pass level and a reason", () => {
    const mutating = new Set([
      ...SURFACES.filter((s) => s.mutates).map((s) => `artifact ${s.name}`),
      ...ORG_SURFACES.filter((s) => s.mutates).map((s) => `org ${s.route}`),
      ...SPACE_SURFACES.filter((s) => s.mutates).map((s) => `space ${s.name}`),
    ]);
    expect(mutating.size).toBeGreaterThan(0);
    for (const c of cases) {
      if (mutating.has(c.name)) expect(c.skip).toBeDefined();
      if (c.skip) {
        expect(c.run).toBeUndefined();
        expect(c.skip.reason).not.toBe("");
      } else expect(c.run && c.variant).toBeTruthy();
    }
  });

  it("are all in the required-case manifest", () => {
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
      crossProbe(me, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).resolves.toBeUndefined();
  });

  it("fails when B's own credential is denied (a B that refuses everything)", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "ta")),
      await fake(install("rl-b-id", "nothing")),
    );
    await expect(
      crossProbe(me, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).rejects.toThrow(/B's own credential failed at B/);
  });

  it("fails when A's credential is denied at A", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "nothing")),
      await fake(install("rl-b-id", "tb")),
    );
    await expect(
      crossProbe(me, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).rejects.toThrow(/A's credential failed at A/);
  });

  it("fails when B allows A's credential", async () => {
    const T = await pair(
      await fake(install("rl-a-id", "shared")),
      await fake(install("rl-b-id", "shared")),
    );
    await expect(
      crossProbe(me, { a: T.a, b: T.b, credA: "shared", credB: "shared" }),
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
      crossProbe(me, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).rejects.toThrow(/seeded marker/);
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
      crossProbe(run, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).rejects.toThrow(/no request reached B/);
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
      crossProbe(run, { a: T.a, b: T.b, credA: "ta", credB: "tb" }),
    ).resolves.toBeUndefined();
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

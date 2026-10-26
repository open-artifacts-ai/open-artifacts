import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  apiReq,
  call,
  createThrowaway,
  deleteThrowaways,
} from "../src/fixtures.ts";
import {
  type Cred,
  describeRes,
  fromContentApp,
  parseJson,
  readBody,
  send,
  withCred,
} from "../src/http.ts";
import {
  allMarkers,
  crossCheck,
  expectRefused,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import { proof } from "../src/report.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";
import { rawRequest } from "../src/ws.ts";

// P5 Task 5: the content host, and the dispatch edge. Cases that need the
// dispatch Worker, staging DNS or the platform HOSTS map report staging-only
// in local mode; on staging they run for real (or say why they can't).

let T: Targets;
let A: Side;
let B: Side;

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
});

const made = new Map<Side, string[]>();

afterAll(async () => {
  let bad = 0;
  for (const s of [A, B]) {
    if (!s) continue;
    bad += await deleteThrowaways(s.t, s.pat, [
      ...(made.get(s) ?? []),
      s.markerId,
    ]);
  }
  if (bad) throw new Error(`${bad} throwaway artifacts were not deleted`);
});

const sideOf = (k: "a" | "b") => (k === "a" ? A : B);
const hashOf = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);
const hostOf = (origin: string) => new URL(origin).host;
const STAGING_ONLY = "needs the dispatch Worker and staging DNS";

describe("content host", () => {
  const APP_ROUTES = [
    "/api/v1/me",
    "/api/v1/artifacts",
    "/api/v1/tokens",
    "/api/v1/settings",
    "/mcp",
  ];
  for (const k of ["a", "b"] as const) {
    it(`${k}: never serves app routes, with the install's own session or PAT`, async () => {
      const s = sideOf(k);
      // Success leg: the same credential works on the app host.
      for (const cred of [s.cookie, s.pat]) {
        const r = await send(
          new Request(`${s.t.app}/api/v1/me`, withCred(cred)),
        );
        const b = await readBody(r);
        if (r.status !== 200)
          throw new Error(`app host /api/v1/me: ${describeRes(r, b)}`);
      }
      for (const path of APP_ROUTES)
        for (const cred of [s.cookie, s.pat]) {
          const r = await send(
            new Request(`${s.t.content}${path}`, withCred(cred)),
          );
          if (!fromContentApp(r))
            throw new Error(
              `content ${path}: not answered by the content app (status ${r.status})`,
            );
          await expectRefused(r, s.t);
        }
    });

    it(`${k}: ignores cookies`, async () => {
      const s = sideOf(k);
      const other = k === "a" ? B : A;
      // An html throwaway: served as stored, no renderer needed.
      const w = await createThrowaway(s.t, s.pat);
      made.set(s, [...(made.get(s) ?? []), w.id]);
      const { res, text } = await call(
        apiReq(
          s.t,
          s.pat,
          "GET",
          `/api/v1/artifacts/${encodeURIComponent(w.id)}/content-url`,
        ),
        `${s.t.name} content-url`,
      );
      const url = (parseJson(res, text, "content-url") as { url?: unknown })
        .url;
      const u = typeof url === "string" ? new URL(url) : null;
      // Hostname only: under ENVIRONMENT=dev the server's content origin has no port.
      if (!u || u.hostname !== new URL(s.t.content).hostname)
        throw new Error(`${s.t.name} content-url: not on its content host`);
      const signed = `${s.t.content}${u.pathname}${u.search}`;
      for (const target of [signed, `${s.t.content}/robots.txt`]) {
        const seen = new Set<string>();
        let first = "";
        for (const cred of [{ kind: "none" } as Cred, s.cookie, other.cookie]) {
          const r = await send(new Request(target, withCred(cred)));
          const b = await readBody(r);
          if (r.headers.getSetCookie().length)
            throw new Error("content host set a cookie");
          if (r.status !== 200)
            throw new Error(`content request: ${describeRes(r, b)}`);
          const key = `${r.status} ${hashOf(b)}`;
          if (!first) first = key;
          seen.add(key);
        }
        if (seen.size !== 1)
          throw new Error(
            `a Cookie header changed the content response (${[...seen].join(" / ")})`,
          );
      }
    });
  }
});

/** The dispatch Worker's (and the server's foreign-host) generic 404. */
async function expectGeneric404(r: Response, what: string): Promise<void> {
  const b = await readBody(r);
  const bad = (why: string) => {
    throw new Error(`${what}: ${why} (${describeRes(r, b)})`);
  };
  if (r.status !== 404) bad("not a 404");
  if (r.headers.get("location")) bad("has a Location");
  if (r.headers.getSetCookie().length) bad("sets a cookie");
  r.headers.forEach((_, h) => {
    if (h.startsWith("x-oa")) bad("has an install header");
  });
  if (fromContentApp(r)) bad("answered by a content app");
  if (b.trim() !== "Not found") bad("not the generic body");
  for (const m of allMarkers()) if (b.includes(m)) bad("holds a marker");
}

const healthzId = async (r: Response): Promise<unknown> => {
  const b = await readBody(r);
  if (r.status !== 200) return undefined;
  try {
    return (JSON.parse(b) as { installId?: unknown }).installId;
  } catch {
    return undefined;
  }
};

describe("mapping integrity", () => {
  it("X-Forwarded-Host set to the other install is ignored", async () => {
    const xfh = (t: Target) => hostOf((t === T.a ? T.b : T.a).app);
    for (const t of [T.a, T.b]) {
      const r = await fetch(`${t.app}/healthz`, {
        redirect: "manual",
        headers: { "x-forwarded-host": xfh(t) },
      });
      if ((await healthzId(r)) !== t.installId)
        throw new Error(
          `${t.name} /healthz with X-Forwarded-Host: not its own installId`,
        );
    }
    await crossCheck(
      (cred, t) =>
        new Request(
          `${t.app}/api/v1/me`,
          withCred(cred, { headers: { "x-forwarded-host": xfh(t) } }),
        ),
      { a: T.a, b: T.b, credA: A.cookie, credB: B.cookie },
    );
  });

  it("a host that is neither APP_HOST nor CONTENT_HOST gets the server's own 404", async (ctx) => {
    if (T.mode !== "local")
      return proof(
        ctx,
        "unproven-live",
        "needs a test mapping to a stray host on stg (not configured)",
      );
    // Local mode reaches each server directly: a stray name, and the other
    // install's hosts, sent to this install's port.
    for (const t of [T.a, T.b]) {
      const o = t === T.a ? T.b : T.a;
      const port = new URL(t.app).port;
      for (const host of [
        `redline-stray.app.localhost:${port}`,
        hostOf(o.app),
        hostOf(o.content),
      ]) {
        const r = await rawRequest({
          url: `${t.app}/healthz`,
          headers: new Headers(),
          host,
        });
        await expectGeneric404(r, `${t.name} with a foreign Host`);
      }
    }
  });

  it("HOSTS maps each install's hosts to its own id, and no host to two", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    for (const t of [T.a, T.b]) {
      const r = await fetch(`${t.app}/healthz`, { redirect: "manual" });
      if ((await healthzId(r)) !== t.installId)
        throw new Error(
          `${t.name}: the app host does not report its own installId`,
        );
      const c = await fetch(`${t.content}/robots.txt`, { redirect: "manual" });
      await readBody(c);
      if (c.status !== 200 || !fromContentApp(c))
        throw new Error(
          `${t.name}: the content host is not served by a content app`,
        );
    }
    return proof(
      ctx,
      "unproven-live",
      "no read access to the platform HOSTS map in REDLINE_TARGETS",
    );
  });
});

/** The zone of a tenant host: everything after the slug. */
const zoneOf = (origin: string) =>
  new URL(origin).hostname.split(".").slice(1).join(".");
const slugOf = (origin: string) => new URL(origin).hostname.split(".")[0] ?? "";

/** A request through the edge: TLS to `connect`, Host (and SNI) `host`. */
const edge = (
  connect: string,
  host: string,
  extra: Record<string, string> = {},
) =>
  rawRequest({
    url: `https://${connect}/healthz`,
    headers: new Headers(extra),
    host,
    servername: host.replace(/\.$/, "").split(":")[0],
  });

describe("unmapped host", () => {
  it("unmapped names get the generic 404, never an install", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    for (const origin of [T.a.app, T.a.content]) {
      const zone = zoneOf(origin);
      const slug = slugOf(origin);
      const names = [
        `${slug}x.${zone}`,
        `${slug.slice(0, -1)}.${zone}`,
        zone,
        `www.${zone}`,
        `deadbeef.${zone}`,
      ];
      for (const n of names)
        await expectGeneric404(await edge(n, n), `unmapped ${n}`);
      // X-Forwarded-Host set to B on an unmapped name changes nothing.
      const n = `deadbeef.${zone}`;
      await expectGeneric404(
        await edge(n, n, { "x-forwarded-host": hostOf(T.b.app) }),
        "unmapped with X-Forwarded-Host B",
      );
    }
  });

  it("A's host spelled differently (case, trailing dot, :443) never reaches another install", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    // The dispatch Worker normalizes these to A's own host (hostOf in
    // apps/dispatch), so A answering is allowed; B or a 5xx never is.
    const h = hostOf(T.a.app);
    for (const host of [h.toUpperCase(), `${h}.`, `${h}:443`]) {
      const r = await edge(h, host);
      if (r.status === 404) {
        await expectGeneric404(r, `A as ${host}`);
        continue;
      }
      if ((await healthzId(r)) !== T.a.installId)
        throw new Error(
          `A's host as a variant: answered by another install or failed (status ${r.status})`,
        );
    }
  });

  it("a deleted install's old host gets the generic 404", async (ctx) => {
    if (T.mode !== "staging") return proof(ctx, "staging-only", STAGING_ONLY);
    const raw = process.env.REDLINE_DELETED_HOSTS;
    if (!raw)
      return proof(
        ctx,
        "unproven-live",
        "REDLINE_DELETED_HOSTS not set (the job must delete an install first)",
      );
    for (const n of raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean))
      await expectGeneric404(await edge(n, n), "a deleted install's host");
  });
});

describe("cross-site cookies (PSL)", () => {
  it("app and content are different sites, and so are the two installs", async (ctx) => {
    if (T.mode !== "staging")
      return proof(
        ctx,
        "staging-only",
        "local hosts are not on the public suffix list",
      );
    const site = (origin: string) =>
      getDomain(new URL(origin).hostname, { allowPrivateDomains: true });
    const prod = (slug: string, zone: string) => `https://${slug}.${zone}`;
    const pairs: [string, string, string][] = [
      ["staging", T.a.app, T.a.content],
      ["staging", T.b.app, T.b.content],
      [
        "prod",
        prod("x", "open-artifacts.app"),
        prod("x", "open-artifacts.page"),
      ],
    ];
    for (const [env, app, content] of pairs)
      if (site(app) === site(content))
        throw new Error(`${env}: the app and content hosts are the same site`);
    const unlisted: string[] = [];
    const tenants: [string, string][] = [
      [T.a.app, T.b.app],
      [T.a.content, T.b.content],
      [prod("x", "open-artifacts.app"), prod("y", "open-artifacts.app")],
      [prod("x", "open-artifacts.page"), prod("y", "open-artifacts.page")],
    ];
    for (const [x, y] of tenants)
      if (site(x) === site(y)) unlisted.push(zoneOf(x));
    if (unlisted.length)
      return proof(
        ctx,
        "unproven-live",
        `not yet in tldts's PSL snapshot: ${unlisted.join(", ")}`,
      );
  });
});

describe("scheduler", () => {
  it("no /__oa/nightly route on either install", async () => {
    for (const t of [T.a, T.b])
      for (const method of ["GET", "POST"]) {
        const r = await fetch(`${t.app}/__oa/nightly`, {
          method,
          redirect: "manual",
        });
        await expectRefused(r, t);
        if (r.status !== 404)
          throw new Error(`${t.name} ${method} /__oa/nightly: not a 404`);
      }
  });

  it("a /__oa/nightly signature replayed at B, stale or twice is refused", async (ctx) => {
    return proof(
      ctx,
      "not-applicable",
      "P1 Task 7 took no fallback: the scheduler calls scheduled() through the dispatch namespace; signed /__oa/nightly is parked for M2",
    );
  });
});

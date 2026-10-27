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
  hook,
  send as httpSend,
  parseJson,
  readBody,
  sessionCred,
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
import { labelTurnstileTestKey, ownCodeRequestReq } from "../src/signin.ts";
import {
  inventoryKeyOf,
  loadTargets,
  type Target,
  type Targets,
} from "../src/targets.ts";
import { rawRequest } from "../src/ws.ts";

// P5 Task 5: the content host, and the dispatch edge. Cases that need the
// dispatch Worker, staging DNS or the platform HOSTS map report staging-only
// in local mode; on staging they run for real (or say why they can't).

let T: Targets;
let A: Side;
let B: Side;

/** Every artifact a side created (marker first), recorded as it is made. */
const made = new Map<Side, string[]>();

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  made.set(A, [A.markerId]);
  B = await prepareSide(T.b);
  made.set(B, [B.markerId]);
});

afterAll(async () => {
  let bad = 0;
  for (const [s, ids] of made) bad += await deleteThrowaways(s.t, s.pat, ids);
  if (bad) throw new Error(`${bad} throwaway artifacts were not deleted`);
});

/** Per-request bound: a timeout is a FAIL (an abort error), never a refusal. */
const TIMEOUT_MS = 15_000;
const send = (r: Request) =>
  httpSend(new Request(r, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
const fetchT = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

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
      const r = await fetchT(`${t.app}/healthz`, {
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
    if (T.mode === "staging") {
      // Platform's test mapping: HOSTS sends strayHost to an rl install that
      // serves neither name. The inventory proves the request reaches that
      // install, so the 404 is the server's, not the dispatch Worker's.
      const stray = T.strayHost;
      if (!stray || !T.inventory)
        return proof(
          ctx,
          "unproven-live",
          "needs strayHost and the inventory in REDLINE_TARGETS",
        );
      const mapped = (await inventory(
        `/hosts?host=${encodeURIComponent(stray)}`,
      )) as { installId?: unknown };
      const t = [T.a, T.b].find((x) => x.installId === mapped.installId);
      if (!t)
        throw new Error("strayHost: HOSTS doesn't map it to rl-a or rl-b");
      const cred = t === T.a ? A.cookie : B.cookie;
      for (const [path, c] of [
        ["/healthz", null],
        ["/api/v1/me", cred],
      ] as const) {
        const r = await fetchT(
          `https://${stray}${path}`,
          c ? withCred(c) : { redirect: "manual" },
        );
        await expectGeneric404(r, `${t.name} via strayHost ${path}`);
      }
      return;
    }
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
      const r = await fetchT(`${t.app}/healthz`, { redirect: "manual" });
      if ((await healthzId(r)) !== t.installId)
        throw new Error(
          `${t.name}: the app host does not report its own installId`,
        );
      const c = await fetchT(`${t.content}/robots.txt`, { redirect: "manual" });
      await readBody(c);
      if (c.status !== 200 || !fromContentApp(c))
        throw new Error(
          `${t.name}: the content host is not served by a content app`,
        );
    }
    if (!T.inventory)
      return proof(
        ctx,
        "unproven-live",
        "no inventory configured (REDLINE_STG_INVENTORY_URL and key)",
      );
    const listing = (await inventory("/hosts")) as {
      hosts?: unknown;
      complete?: unknown;
    };
    if (!Array.isArray(listing.hosts))
      throw new Error("inventory /hosts: no hosts array");
    // A truncated listing can't prove "every host": FAIL, never pass.
    if (listing.complete !== true)
      throw new Error("inventory /hosts: the listing is not complete");
    const hosts = new Map<string, unknown>();
    for (const h of listing.hosts as { host?: unknown; installId?: unknown }[])
      if (typeof h?.host === "string") hosts.set(h.host, h.installId);
    const raw = await inventory("/installs");
    const rows = (
      Array.isArray(raw) ? raw : (raw as { installs?: unknown }).installs
    ) as Record<string, unknown>[] | undefined;
    if (!Array.isArray(rows) || rows.length === 0)
      throw new Error("inventory /installs: missing or empty");
    // No host in /hosts is claimed by two installs (app or content).
    const claims = new Map<string, Set<string>>();
    for (const row of rows)
      for (const h of [row?.appHost, row?.contentHost])
        if (typeof h === "string" && typeof row.id === "string")
          claims.set(h, (claims.get(h) ?? new Set()).add(row.id));
    for (const h of hosts.keys())
      if ((claims.get(h)?.size ?? 0) > 1)
        throw new Error("inventory: a host is claimed by two installs");
    // Every rl host is in /hosts, mapped to its own install.
    for (const t of [T.a, T.b])
      for (const o of [t.app, t.content]) {
        const h = new URL(o).hostname;
        if (!hosts.has(h))
          throw new Error(`inventory: a ${t.name} host is missing from /hosts`);
        if (hosts.get(h) !== t.installId)
          throw new Error(
            `inventory: a ${t.name} host maps to another install id`,
          );
      }
  });
});

/** GET <inventory><path> with its key; status and body hash on failure. */
async function inventory(path: string): Promise<unknown> {
  const inv = T.inventory;
  if (!inv) throw new Error("no inventory configured");
  const res = await fetchT(`${inv.url}${path}`, {
    redirect: "manual",
    headers: { authorization: `Bearer ${inventoryKeyOf(inv)}` },
  });
  const text = await readBody(res);
  if (res.status !== 200)
    throw new Error(
      `inventory ${path.split("?")[0]}: ${describeRes(res, text)}`,
    );
  return parseJson(res, text, "inventory");
}

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
    if (!T.deletedHosts)
      return proof(
        ctx,
        "unproven-live",
        "REDLINE_DELETED_HOSTS not set (Platform sets it once rl-del is deleted)",
      );
    if (!T.inventory)
      return proof(
        ctx,
        "unproven-live",
        "no inventory configured (REDLINE_STG_INVENTORY_URL and key)",
      );
    for (const n of T.deletedHosts) {
      await expectGeneric404(await edge(n, n), "a deleted install's host");
      const h = (await inventory(`/hosts?host=${encodeURIComponent(n)}`)) as {
        host?: unknown;
        installId?: unknown;
      };
      if (h.host !== n || h.installId !== null)
        throw new Error("a deleted install's host is still mapped in HOSTS");
    }
  });
});

describe("scheduler", () => {
  it("no /__oa/nightly route on either install", async () => {
    for (const t of [T.a, T.b])
      for (const method of ["GET", "POST"]) {
        const r = await fetchT(`${t.app}/__oa/nightly`, {
          method,
          redirect: "manual",
        });
        await expectRefused(r, t);
        if (r.status !== 404)
          throw new Error(`${t.name} ${method} /__oa/nightly: not a 404`);
      }
  });
});

// Cross-site isolation that holds without the PSL listing (the manager's
// ruling on #649): the "rl-a and rl-b are different sites" check waits for the
// PSL entries and runs as scripts/psl-listed.ts, outside the gate.

/** eTLD+1 per the PSL snapshot tldts ships, private section included (as browsers). */
const siteOf = (origin: string) =>
  getDomain(new URL(origin).hostname, { allowPrivateDomains: true });

interface SetCookie {
  name: string;
  attrs: Map<string, string>;
}

function parseSetCookie(line: string): SetCookie {
  const [pair = "", ...rest] = line.split(";");
  const eq = pair.indexOf("=");
  const attrs = new Map<string, string>();
  for (const a of rest) {
    const i = a.indexOf("=");
    const k = (i === -1 ? a : a.slice(0, i)).trim().toLowerCase();
    if (k) attrs.set(k, i === -1 ? "" : a.slice(i + 1).trim());
  }
  return { name: pair.slice(0, eq).trim(), attrs };
}

/** Problems with one app-host Set-Cookie (names only, never values). */
function cookieProblems(c: SetCookie, strict: boolean): string[] {
  const out: string[] = [];
  if (c.attrs.has("domain")) out.push(`${c.name} has a Domain`);
  if (c.attrs.get("path") !== "/") out.push(`${c.name} Path is not /`);
  if (strict) {
    if (!c.name.startsWith("__Host-")) out.push(`${c.name} is not __Host-`);
    if (!c.attrs.has("secure")) out.push(`${c.name} is not Secure`);
  }
  return out;
}

const sameOriginJson = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-oa-request": "1",
  "sec-fetch-site": "same-origin",
  ...extra,
});

describe("cross-site isolation", () => {
  it("artifact content is served on a registrable domain cross-site to every app host", async () => {
    const apps = [T.a.app, T.b.app];
    for (const s of [A, B]) {
      const c = siteOf(s.t.content);
      if (!c)
        throw new Error(
          `${s.t.name}: the content host has no registrable domain`,
        );
      for (const app of apps) {
        const a = siteOf(app);
        if (!a) throw new Error("an app host has no registrable domain");
        if (a === c)
          throw new Error(
            `${s.t.name}'s content host is same-site with an app host`,
          );
      }
      // Direct check: the content URL the install issues is on that host.
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
      if (
        typeof url !== "string" ||
        new URL(url).hostname !== new URL(s.t.content).hostname
      )
        throw new Error(`${s.t.name}: content-url is not on its content host`);
      if (siteOf(url) !== c)
        throw new Error(`${s.t.name}: content-url site differs`);
    }
  });

  it("every app-host Set-Cookie is __Host- (Secure, Path=/, no Domain), on hook and code sign-in", async (ctx) => {
    labelTurnstileTestKey(ctx, [T.a, T.b]);
    const strict = T.mode === "staging";
    const notes: string[] = [];
    for (const t of [T.a, T.b]) {
      const email = `redline-cookies@${t.testDomain}`;
      const seen: SetCookie[] = [];
      const take = async (r: Response) => {
        await readBody(r);
        for (const l of r.headers.getSetCookie()) seen.push(parseSetCookie(l));
        return r;
      };
      // Session hook sign-in, then app routes and sign-out with that cookie.
      const cookie = await sessionCred(t, email, "member");
      for (const path of ["/", "/sign-in", "/api/v1/me", "/auth/providers"])
        await take(
          await send(new Request(`${t.app}${path}`, withCred(cookie))),
        );
      const out = await take(
        await send(
          new Request(
            `${t.app}/auth/logout`,
            withCred(cookie, {
              method: "POST",
              headers: { "x-oa-request": "1" },
            }),
          ),
        ),
      );
      if (!out.headers.getSetCookie().length)
        throw new Error(
          `${t.name} sign-out: no Set-Cookie (status ${out.status})`,
        );
      // Code sign-in: request (with the target's Turnstile token), the code
      // from the hook, verify.
      const req = await take(await send(ownCodeRequestReq(t, email)));
      const pending = req.headers
        .getSetCookie()
        .map((l) => l.split(";")[0] ?? "")
        .filter((p) => p.includes("="));
      let code: string | null = null;
      if (req.status === 202 && pending.length) {
        // Delivery runs after the response: poll the hook briefly.
        for (let i = 0; i < 20 && !code; i++) {
          code = await hook(t, "/__test/otp/latest", { email })
            .then((o) => {
              const c = (o as { code?: unknown }).code;
              return typeof c === "string" ? c : null;
            })
            .catch(() => null);
          if (!code) await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!code)
        notes.push(
          `${t.name}: code sign-in unavailable (request status ${req.status})`,
        );
      else {
        const v = await take(
          await send(
            new Request(`${t.app}/auth/code/verify`, {
              method: "POST",
              redirect: "manual",
              headers: sameOriginJson({ cookie: pending.join("; ") }),
              body: JSON.stringify({ code }),
            }),
          ),
        );
        const names = v.headers
          .getSetCookie()
          .map((l) => parseSetCookie(l).name);
        if (v.status !== 200 || !names.includes(t.cookieName))
          throw new Error(
            `${t.name} code verify: no session cookie (status ${v.status})`,
          );
      }
      const bad = seen.flatMap((c) => cookieProblems(c, strict));
      if (bad.length) throw new Error(`${t.name}: ${bad.join("; ")}`);
    }
    if (!strict)
      return proof(
        ctx,
        "staging-only",
        `ENVIRONMENT=dev sets unprefixed, non-Secure cookies; Path and Domain checked${notes.length ? `; ${notes.join("; ")}` : ""}`,
      );
    if (notes.length) return proof(ctx, "unproven-live", notes.join("; "));
  });

  it("state-changing app requests without X-OA-Request are refused, and accepted with it", async () => {
    for (const s of [A, B]) {
      let failure: unknown = null;
      try {
        await csrfWrites(s);
      } catch (e) {
        failure = e;
      }
      // Always revoke the PAT minted by the tokens write; a live one left
      // behind fails the case.
      try {
        await revokeTokens(s, "redline-csrf");
      } catch (e) {
        failure ??= e;
      }
      if (failure) throw failure;
    }
  });
});

async function csrfWrites(s: Side): Promise<void> {
  const t = s.t;
  const w = await createThrowaway(t, s.pat, { capabilities: { db: true } });
  made.set(s, [...(made.get(s) ?? []), w.id]);
  const art = `/api/v1/artifacts/${encodeURIComponent(w.id)}`;
  const read = async (path: string) => {
    const r = await send(apiReq(t, s.pat, "GET", path));
    return `${r.status}\n${await readBody(r)}`;
  };
  const writes: {
    method: string;
    path: string;
    body?: unknown;
    state: string;
  }[] = [
    {
      method: "POST",
      path: "/api/v1/artifacts",
      body: { title: "redline-csrf", format: "html", content: "<p>x</p>" },
      state: "/api/v1/artifacts",
    },
    {
      method: "PATCH",
      path: art,
      body: { title: "redline-csrf-patched" },
      state: art,
    },
    {
      method: "PUT",
      path: `${art}/data/c/csrf`,
      body: { v: 1 },
      state: `${art}/data/c/csrf`,
    },
    {
      method: "POST",
      path: "/api/v1/tokens",
      body: { label: "redline-csrf" },
      state: "/api/v1/tokens",
    },
    { method: "DELETE", path: art, state: art },
  ];
  for (const wr of writes) {
    const init = (csrf: boolean) => {
      const headers: Record<string, string> = {};
      if (csrf) headers["x-oa-request"] = "1";
      if (wr.body !== undefined) headers["content-type"] = "application/json";
      return new Request(
        `${t.app}${wr.path}`,
        withCred(s.cookie, {
          method: wr.method,
          headers,
          ...(wr.body !== undefined ? { body: JSON.stringify(wr.body) } : {}),
        }),
      );
    };
    const before = await read(wr.state);
    const r = await send(init(false));
    const rb = await readBody(r);
    let code: unknown;
    try {
      code = (JSON.parse(rb) as { error?: { code?: unknown } }).error?.code;
    } catch {
      code = undefined;
    }
    if (r.status !== 403 || code !== "csrf")
      throw new Error(
        `${t.name} ${wr.method} without X-OA-Request: ${describeRes(r, rb)}`,
      );
    if ((await read(wr.state)) !== before)
      throw new Error(
        `${t.name} ${wr.method} without X-OA-Request changed state`,
      );
    const ok = await send(init(true));
    const ob = await readBody(ok);
    if (ok.status < 200 || ok.status > 299)
      throw new Error(
        `${t.name} ${wr.method} with X-OA-Request: ${describeRes(ok, ob)}`,
      );
    if (wr.method === "POST" && wr.path === "/api/v1/artifacts") {
      const id = (JSON.parse(ob) as { id?: unknown }).id;
      if (typeof id === "string") made.set(s, [...(made.get(s) ?? []), id]);
    }
  }
}

/** Revokes every token of `s`'s user labelled `label`; throws unless all are gone. */
async function revokeTokens(s: Side, label: string): Promise<void> {
  const t = s.t;
  const list = async () => {
    const r = await send(apiReq(t, s.pat, "GET", "/api/v1/tokens"));
    const b = await readBody(r);
    if (r.status !== 200)
      throw new Error(`${t.name} list tokens: ${describeRes(r, b)}`);
    const raw = parseJson(r, b, `${t.name} list tokens`);
    const all = Array.isArray(raw)
      ? raw
      : (raw as { tokens?: unknown } | null)?.tokens;
    if (!Array.isArray(all)) throw new Error(`${t.name} list tokens: no list`);
    return (all as { id?: unknown; label?: unknown }[]).filter(
      (tk) => tk.label === label,
    );
  };
  for (const tk of await list()) {
    if (typeof tk.id !== "string")
      throw new Error(`${t.name}: a ${label} token has no id`);
    const r = await send(
      apiReq(t, s.pat, "DELETE", `/api/v1/tokens/${encodeURIComponent(tk.id)}`),
    );
    const b = await readBody(r);
    if (r.status < 200 || r.status > 299)
      throw new Error(`${t.name} revoke ${label}: ${describeRes(r, b)}`);
  }
  if ((await list()).length)
    throw new Error(`${t.name}: a ${label} token is still live`);
}

import { createHash } from "node:crypto";
import {
  adminCreds,
  type Cred,
  describeRes,
  newMarker,
  publishMarker,
  readBody,
  send,
} from "./http.ts";
import type { Target } from "./targets.ts";

// What counts as B refusing A's credential, and the crossCheck every
// cross-tenant case goes through (Review Focus 1 and 2).

const SIGN_IN_PAGE = "/sign-in";
const SESSION_COOKIES = ["__Host-oa_session", "oa_session"];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const markers = new Map<string, Set<string>>();

/** Records a marker seeded into `t` (title and content of a private artifact). */
export function registerMarker(t: Target, marker: string): void {
  const s = markers.get(t.name) ?? new Set<string>();
  s.add(marker);
  markers.set(t.name, s);
}

/** Every marker seeded so far, on any install. */
export const allMarkers = (): string[] =>
  [...markers.values()].flatMap((s) => [...s]);

/** Seeds one marker artifact on `t` with its admin PAT and registers it. */
export async function seedMarker(
  t: Target,
  pat: Cred,
): Promise<{ marker: string; id: string }> {
  const marker = newMarker(t);
  const id = await publishMarker(t, pat, marker);
  registerMarker(t, marker);
  return { marker, id };
}

export class NotRefused extends Error {}

/** True when a Set-Cookie line sets a session cookie to a non-empty value. */
function setsSession(lines: string[]): boolean {
  return lines.some((l) => {
    const [pair = ""] = l.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    return eq > 0 && SESSION_COOKIES.includes(name) && value !== "";
  });
}

/**
 * B refused: 401, 403 or 404; or a 3xx with no Set-Cookie whose Location is
 * B's own sign-in page. Never a session cookie, and the body holds no marker
 * from any install. Anything else (a 200 included) throws NotRefused.
 */
export async function expectRefused(res: Response, b: Target): Promise<void> {
  const body = await readBody(res);
  const what = `${b.name} did not refuse (${describeRes(res, body)})`;
  const cookies = res.headers.getSetCookie();
  if (REDIRECTS.has(res.status)) {
    if (cookies.length > 0)
      throw new NotRefused(`${what}: a redirect that sets a cookie`);
    const loc = res.headers.get("location");
    let to: URL | null = null;
    try {
      to = loc ? new URL(loc, b.app) : null;
    } catch {
      to = null;
    }
    if (!to || to.origin !== b.app || to.pathname !== SIGN_IN_PAGE)
      throw new NotRefused(`${what}: a redirect not to B's own sign-in`);
  } else if (![401, 403, 404].includes(res.status)) {
    throw new NotRefused(what);
  }
  if (setsSession(cookies))
    throw new NotRefused(`${what}: sets a session cookie`);
  for (const m of allMarkers())
    if (body.includes(m))
      throw new NotRefused(`${what}: the body holds a seeded marker`);
}

export const defaultOk = (r: Response) =>
  (r.status >= 200 && r.status < 300) || r.status === 101;

export interface CrossCheck<C = Cred> {
  a: Target;
  b: Target;
  credA: C;
  credB: C;
  /** A success leg's verdict; `host` is the install the leg was sent to. */
  ok?: (r: Response, host: Target) => boolean;
  /** How each leg is sent (default: fetch, redirect manual); e.g. wsHandshake. */
  send?: (r: Request) => Promise<Response>;
  /**
   * Judges the A-at-B leg: what counts as B refusing, when a refusal isn't a
   * 401/403/404 (an OAuth 400 invalid_grant, a sign-in redirect). Default
   * expectRefused.
   */
  refused?: (res: Response, b: Target) => Promise<void>;
  /**
   * Single-use credentials (a one-time code, a Google code): refuse A's at B
   * before A's own success, so the success proves the refused value was still
   * valid. Order: B at B, A at B (refused), A at A.
   */
  refuseFirst?: boolean;
}

/**
 * B's own credential succeeds at B, A's succeeds at A, then A's is refused at
 * B. A broken B (refusing everything) fails the first step, never passes.
 */
export async function crossCheck<C = Cred>(
  req: (cred: C, host: Target) => Request,
  o: CrossCheck<C>,
): Promise<void> {
  const ok = o.ok ?? defaultOk;
  const go = o.send ?? send;
  const refused = o.refused ?? expectRefused;
  const rb = await go(req(o.credB, o.b));
  const tb = await readBody(rb);
  if (!ok(rb, o.b))
    throw new Error(`B's own credential failed at B (${describeRes(rb, tb)})`);
  if (o.refuseFirst) await refused(await go(req(o.credA, o.b)), o.b);
  const ra = await go(req(o.credA, o.a));
  const ta = await readBody(ra);
  if (!ok(ra, o.a))
    throw new Error(`A's credential failed at A (${describeRes(ra, ta)})`);
  if (!o.refuseFirst) await refused(await go(req(o.credA, o.b)), o.b);
}

/** A Backend surface probe's answer (apps/server/test/authz/surfaces.ts). */
export type Verdict = "allow" | "deny";
export type ProbeFetch = (req: Request) => Promise<Response>;

export interface CrossProbe<C> {
  a: Target;
  b: Target;
  credA: C;
  credB: C;
  /** True when `req` carries `cred` (its cookie or bearer token). */
  carries: (req: Request, cred: C) => boolean;
}

/** True when a request carrying A's credential went to B's app or content origin. */
function reachedB<C>(reqs: readonly Request[], o: CrossProbe<C>): boolean {
  const own = new Set([new URL(o.b.app).origin, new URL(o.b.content).origin]);
  return reqs.some((r) => {
    try {
      return own.has(new URL(r.url).origin) && o.carries(r, o.credA);
    } catch {
      return false;
    }
  });
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Runs one leg, recording every response the probe got (redirect: "manual"). */
async function leg(
  what: string,
  run: (fetch: ProbeFetch) => Promise<Verdict>,
): Promise<{ verdict: Verdict; seen: Response[]; reqs: Request[] }> {
  const seen: Response[] = [];
  const reqs: Request[] = [];
  // Buffered, not clone(): a probe that cancels its body would wait on the
  // unread tee branch forever.
  const f: ProbeFetch = async (req) => {
    // URL and headers only: a clone would tee the body.
    reqs.push(new Request(req.url, { headers: req.headers }));
    const r = await send(req);
    const buf = NULL_BODY.has(r.status) ? null : await r.arrayBuffer();
    const copy = () =>
      new Response(buf, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      });
    seen.push(copy());
    return copy();
  };
  try {
    return { verdict: await run(f), seen, reqs };
  } catch (e) {
    // A probe error quotes the body: show its hash and the last status only.
    const last = seen.at(-1);
    const at = last ? describeRes(last, await readBody(last)) : "no response";
    throw new Error(
      `${what}: the probe failed (${at}; error sha256:${digest(String((e as Error)?.message ?? e))})`,
    );
  }
}

/**
 * crossCheck for a Backend surface probe (many requests, one verdict): B's
 * own credential is allowed at B, A's at A, then A's is denied at B and
 * every response B gave passes expectRefused. A probe that sends nothing to
 * B proves nothing and fails.
 */
export async function crossProbe<C>(
  run: (cred: C, host: Target, fetch: ProbeFetch) => Promise<Verdict>,
  o: CrossProbe<C>,
): Promise<void> {
  const b = await leg("B's own credential at B", (f) => run(o.credB, o.b, f));
  if (b.verdict !== "allow")
    throw new Error("B's own credential failed at B (the probe said deny)");
  const a = await leg("A's credential at A", (f) => run(o.credA, o.a, f));
  if (a.verdict !== "allow")
    throw new Error("A's credential failed at A (the probe said deny)");
  const x = await leg("A's credential at B", (f) => run(o.credA, o.b, f));
  if (!reachedB(x.reqs, o))
    throw new NotRefused(
      `${o.b.name}: no request carrying A's credential reached B`,
    );
  for (const r of x.seen) await expectRefused(r, o.b);
  if (x.verdict !== "deny")
    throw new NotRefused(`${o.b.name} allowed A's credential (the probe)`);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const same = (x: unknown, y: unknown) =>
  JSON.stringify(x) === JSON.stringify(y);
const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Keys of two objects whose values differ (names only, sorted). */
const keysDiffering = (
  x: Record<string, unknown>,
  y: Record<string, unknown>,
): string[] =>
  [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((k) => !same(x[k], y[k]))
    .sort();

/** A snapshot's "<path> <body>" lines, by path. */
function byPath(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of s.split("\n")) {
    const sp = l.indexOf(" ");
    if (sp > 0 && l.startsWith("/")) m.set(l.slice(0, sp), l.slice(sp + 1));
  }
  return m;
}

/** What differs in one path's body, by name: keys, or per-entry keys of a list. */
function bodyDiff(x: string, y: string): string[] {
  const jx = parse(x);
  const jy = parse(y);
  if (isObj(jx) && isObj(jy)) return keysDiffering(jx, jy);
  if (!Array.isArray(jx) || !Array.isArray(jy)) return [];
  const out: string[] = [];
  for (let i = 0; i < Math.max(jx.length, jy.length); i++) {
    const ex: unknown = jx[i];
    const ey: unknown = jy[i];
    if (i >= jx.length) out.push(`[${i}] added`);
    else if (i >= jy.length) out.push(`[${i}] removed`);
    else if (isObj(ex) && isObj(ey))
      out.push(...keysDiffering(ex, ey).map((k) => `[${i}].${k}`));
    else if (!same(ex, ey)) out.push(`[${i}]`);
  }
  return out;
}

/**
 * What differs between two snapshots (lines of "<path> <body>"), by name only:
 * each path whose body differs, with the top-level JSON keys that differ, or
 * for a list (/versions) the per-entry keys ("[0].textIndexed"). Never a
 * value (ids in paths redacted). Empty when nothing can be named.
 */
export function snapshotDiff(before: string, after: string): string {
  const b = byPath(before);
  const a = byPath(after);
  const parts: string[] = [];
  for (const p of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(p);
    const y = a.get(p);
    if (x === y) continue;
    const at = p.replace(/[A-Za-z0-9_-]{16,}/g, ":id");
    if (x === undefined || y === undefined) {
      parts.push(`${at} ${x === undefined ? "added" : "missing"}`);
      continue;
    }
    const keys = bodyDiff(x, y);
    parts.push(
      keys.length ? `${at} keys ${keys.join(", ")}` : `${at} body differs`,
    );
  }
  return parts.length ? `; differs: ${parts.join("; ")}` : "";
}

export interface CrossWrite<C, X> extends CrossProbe<C> {
  /** A throwaway on `host`, made with host's own credential. */
  fresh: (host: Target) => Promise<X>;
  /** What the write would change on a throwaway, as host's own credential reads it. */
  snapshot: (host: Target, x: X) => Promise<string>;
  /**
   * Settles what the server changes on its own (indexing, thumbnails) on the
   * throwaway A's credential targets, before its "before" snapshot.
   */
  settle?: (host: Target, x: X) => Promise<void>;
  /** Deletes a throwaway; called for every one made, even on failure. */
  dispose: (host: Target, x: X) => Promise<void>;
}

/**
 * crossProbe for a probe that writes when allowed. Each leg gets its own
 * throwaway on the install it targets: B's own credential is allowed on B's,
 * A's on A's, then A's is denied on a fresh one of B's, every response B gave
 * passes expectRefused, and that throwaway reads back unchanged.
 */
export async function crossWrite<C, X>(
  run: (cred: C, host: Target, x: X, fetch: ProbeFetch) => Promise<Verdict>,
  o: CrossWrite<C, X>,
): Promise<void> {
  const made: [Target, X][] = [];
  const fresh = async (t: Target) => {
    const x = await o.fresh(t);
    made.push([t, x]);
    return x;
  };
  const body = async () => {
    const xb = await fresh(o.b);
    const b = await leg("B's own credential at B", (f) =>
      run(o.credB, o.b, xb, f),
    );
    if (b.verdict !== "allow")
      throw new Error("B's own credential failed at B (the probe said deny)");
    const xa = await fresh(o.a);
    const a = await leg("A's credential at A", (f) => run(o.credA, o.a, xa, f));
    if (a.verdict !== "allow")
      throw new Error("A's credential failed at A (the probe said deny)");
    const xx = await fresh(o.b);
    await o.settle?.(o.b, xx);
    const before = await o.snapshot(o.b, xx);
    const x = await leg("A's credential at B", (f) => run(o.credA, o.b, xx, f));
    if (!reachedB(x.reqs, o))
      throw new NotRefused(
        `${o.b.name}: no request carrying A's credential reached B`,
      );
    for (const r of x.seen) await expectRefused(r, o.b);
    if (x.verdict !== "deny")
      throw new NotRefused(`${o.b.name} allowed A's credential (the probe)`);
    const after = await o.snapshot(o.b, xx);
    if (after !== before)
      throw new NotRefused(
        `${o.b.name}: the throwaway changed (sha256:${digest(before)} -> sha256:${digest(after)})${snapshotDiff(before, after)}`,
      );
  };
  let failed: { e: unknown } | undefined;
  await body().catch((e) => {
    failed = { e };
  });
  // Every throwaway, even on failure; a failed cleanup fails the case.
  let bad: { e: unknown } | undefined;
  for (const [t, x] of made)
    await o.dispose(t, x).catch((e) => {
      bad ??= { e };
    });
  if (failed) throw failed.e;
  if (bad) throw bad.e;
}

export interface Side {
  t: Target;
  cookie: Cred;
  pat: Cred;
  marker: string;
  markerId: string;
}

/** Credentials and a seeded marker for one install. */
export async function prepareSide(t: Target): Promise<Side> {
  const { cookie, pat } = await adminCreds(t);
  const { marker, id } = await seedMarker(t, pat);
  return { t, cookie, pat, marker, markerId: id };
}

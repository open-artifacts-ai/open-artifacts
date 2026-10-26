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

export interface CrossCheck {
  a: Target;
  b: Target;
  credA: Cred;
  credB: Cred;
  ok?: (r: Response) => boolean;
  /**
   * What counts as B refusing, when a refusal isn't a 401/403/404 (an OAuth
   * 400 invalid_grant or invalid_client). Default expectRefused.
   */
  refused?: (res: Response, b: Target) => Promise<void>;
}

/**
 * B's own credential succeeds at B, A's succeeds at A, then A's is refused at
 * B. A broken B (refusing everything) fails the first step, never passes.
 */
export async function crossCheck(
  req: (cred: Cred, host: Target) => Request,
  o: CrossCheck,
): Promise<void> {
  const ok = o.ok ?? defaultOk;
  const rb = await send(req(o.credB, o.b));
  const tb = await readBody(rb);
  if (!ok(rb))
    throw new Error(`B's own credential failed at B (${describeRes(rb, tb)})`);
  const ra = await send(req(o.credA, o.a));
  const ta = await readBody(ra);
  if (!ok(ra))
    throw new Error(`A's credential failed at A (${describeRes(ra, ta)})`);
  await (o.refused ?? expectRefused)(await send(req(o.credA, o.b)), o.b);
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

export interface CrossWrite<C, X> extends CrossProbe<C> {
  /** A throwaway on `host`, made with host's own credential. */
  fresh: (host: Target) => Promise<X>;
  /** What the write would change on a throwaway, as host's own credential reads it. */
  snapshot: (host: Target, x: X) => Promise<string>;
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
        `${o.b.name}: the throwaway changed (sha256:${digest(before)} -> sha256:${digest(after)})`,
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

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
  ok?: (r: Response) => boolean;
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
  const refused = o.refused ?? expectRefused;
  const rb = await send(req(o.credB, o.b));
  const tb = await readBody(rb);
  if (!ok(rb))
    throw new Error(`B's own credential failed at B (${describeRes(rb, tb)})`);
  if (o.refuseFirst) await refused(await send(req(o.credA, o.b)), o.b);
  const ra = await send(req(o.credA, o.a));
  const ta = await readBody(ra);
  if (!ok(ra))
    throw new Error(`A's credential failed at A (${describeRes(ra, ta)})`);
  if (!o.refuseFirst) await refused(await send(req(o.credA, o.b)), o.b);
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

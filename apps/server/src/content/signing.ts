import { LIMITS } from "@oa/shared";
import { contentKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";

/** Clock-skew allowance on top of the TTL when rejecting far-future exps. */
const SKEW_SEC = 60;
const TOKEN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;
/** `{exp}.{uid}.{epoch}.{sig}`: uid a user id (isId), epoch users.session_epoch. */
const VIEWER_TOKEN =
  /^([1-9]\d{0,11})\.([1-9A-HJ-NP-Za-km-z]{16})\.(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]{43})$/;

/**
 * What a signed URL may do. "frame" (the default): the viewer iframe and its
 * sub-resources; a top-level navigation redirects to the app. "dl": an
 * explicit download (`?dl=1`), Content-Disposition attachment, served even top
 * level since an attachment renders nothing.
 */
export type SignMode = "frame" | "dl";

/**
 * The signed-in viewer a /c/ token is bound to (P3 T11): the content host
 * serves it only while that user is active and their session_epoch is still
 * `epoch`. Every status change bumps the epoch, so an unsuspend never revives
 * a URL minted before the suspension.
 */
export type ContentViewer = { uid: string; epoch: number };

/**
 * The viewer to bind into a minted /c/ token: the signed-in user at their
 * current epoch, on every install (parity 1: the content_revocation flag no
 * longer gates it, so a removal cuts content access at once everywhere).
 * Null only without a signed-in user (the two-part token). Fails closed: a
 * user without an epoch throws rather than getting an unbound token.
 */
export function contentViewer(
  _env: Env,
  uid: string | null | undefined,
  epoch: number | null | undefined,
): ContentViewer | null {
  if (!uid) return null;
  if (epoch == null)
    throw new Error("content_revocation: a signed-in viewer needs an epoch");
  return { uid, epoch };
}

/**
 * Server-side thumbnail capture sends this header (`{exp}.{sig}`) on its
 * main-frame document requests to the content origin; with it, and only with
 * it, the content host renders top level. It is never in a URL, so the
 * artifact's script can't read it (thumbs.ts shoot()).
 */
export const CAPTURE_HEADER = "X-OA-Capture";
/** Upper bound on a capture header's lifetime. */
export const CAPTURE_MAX_TTL_SEC = 120;

/** Content tokens and capture headers: the "oa:content-url" subkey (never the upload one). */
const signingKey = (env: Env) => contentKey(env, "oa:content-url");

/**
 * The mode is in the MAC: a frame token can't be turned into dl. So is the
 * viewer: a uid-bound token can't be cut down to the two-part form or moved
 * to another user or epoch.
 */
const payload = (
  id: string,
  v: number,
  exp: number,
  mode: SignMode,
  viewer: ContentViewer | null,
) => {
  const base =
    mode === "frame" ? `${id}:${v}:${exp}` : `${id}:${v}:${exp}:${mode}`;
  return viewer ? `${base}:u:${viewer.uid}:${viewer.epoch}` : base;
};
const capturePayload = (id: string, v: number, exp: number) =>
  `${id}:${v}:${exp}:capture`;

/**
 * `now` is epoch ms; returns the prefix and its expiry (epoch seconds).
 * `ttlSec` may only shorten LIMITS.signedUrlTtlSec (verification caps it).
 * A "dl" prefix is valid only with `?dl=1` (see signDownload). With a
 * `viewer` the token is `{exp}.{uid}.{epoch}.{sig}` (see ContentViewer).
 */
export async function signContent(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
  ttlSec: number = LIMITS.signedUrlTtlSec,
  mode: SignMode = "frame",
  viewer: ContentViewer | null = null,
): Promise<{ prefix: string; exp: number }> {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, LIMITS.signedUrlTtlSec);
  const sig = await hmacSign(
    await signingKey(env),
    payload(id, v, exp, mode, viewer),
  );
  const t = viewer
    ? `${exp}.${viewer.uid}.${viewer.epoch}.${sig}`
    : `${exp}.${sig}`;
  return { prefix: `/c/${t}/${id}/v${v}/`, exp };
}

/** "/c/{exp}.{sig}/{id}/v{v}/", valid for LIMITS.signedUrlTtlSec. */
export async function signContentPrefix(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
): Promise<string> {
  return (await signContent(env, id, v, now)).prefix;
}

/**
 * A download URL path for one file: `/c/{exp}.{sig}/{id}/v{v}/{path}?dl=1`,
 * signed in the "dl" mode. `path` is a manifest path (encoded here).
 */
export async function signDownload(
  env: Env,
  id: string,
  v: number,
  path: string,
  now = Date.now(),
  viewer: ContentViewer | null = null,
): Promise<{ path: string; exp: number }> {
  const { prefix, exp } = await signContent(
    env,
    id,
    v,
    now,
    LIMITS.signedUrlTtlSec,
    "dl",
    viewer,
  );
  const p = path.split("/").map(encodeURIComponent).join("/");
  return { path: `${prefix}${p}?dl=1`, exp };
}

/** `{exp}.{sig}` within (now, now + maxTtl + skew]; null when malformed or out of window. */
function window_(token: string, maxTtl: number, now: number) {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const exp = Number(m[1]);
  return inWindow(exp, maxTtl, now) ? { exp, sig: m[2] ?? "" } : null;
}

function inWindow(exp: number, maxTtl: number, now: number): boolean {
  const nowSec = Math.floor(now / 1000);
  return exp > nowSec && exp <= nowSec + maxTtl + SKEW_SEC;
}

/** A content token's parts: two-part (viewer null) or uid-bound. */
function parseContentToken(token: string, now: number) {
  const t = window_(token, LIMITS.signedUrlTtlSec, now);
  if (t) return { ...t, viewer: null };
  const m = VIEWER_TOKEN.exec(token);
  if (!m) return null;
  const exp = Number(m[1]);
  if (!inWindow(exp, LIMITS.signedUrlTtlSec, now)) return null;
  const viewer: ContentViewer = { uid: m[2] ?? "", epoch: Number(m[3]) };
  return { exp, sig: m[4] ?? "", viewer };
}

/**
 * Strict `{exp}.{sig}` or `{exp}.{uid}.{epoch}.{sig}`: unexpired, not
 * far-future, constant-time HMAC check. `dl` is whether the request carries
 * `?dl=1`: it selects the "dl" mode, so adding or removing it breaks the
 * signature. Returns the mode and the bound viewer (null for a two-part
 * token), or null. The viewer's status and epoch are the caller's to check
 * (content/app.ts load(), in its one statement).
 */
export async function verifyContentToken(
  env: Env,
  token: string,
  id: string,
  v: number,
  dl: boolean,
  now = Date.now(),
): Promise<{ mode: SignMode; viewer: ContentViewer | null } | null> {
  const t = parseContentToken(token, now);
  if (!t) return null;
  const mode: SignMode = dl ? "dl" : "frame";
  const ok = await hmacVerify(
    await signingKey(env),
    payload(id, v, t.exp, mode, t.viewer),
    t.sig,
  );
  return ok ? { mode, viewer: t.viewer } : null;
}

/** A frame-mode `{exp}.{sig}` token for id and v (see verifyContentToken). */
export async function verifyContentPrefix(
  env: Env,
  token: string,
  id: string,
  v: number,
  now = Date.now(),
): Promise<boolean> {
  return (
    (await verifyContentToken(env, token, id, v, false, now))?.mode === "frame"
  );
}

/** The CAPTURE_HEADER value for one capture of id at v. */
export async function signCapture(
  env: Env,
  id: string,
  v: number,
  now = Date.now(),
  ttlSec = 60,
): Promise<string> {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, CAPTURE_MAX_TTL_SEC);
  return `${exp}.${await hmacSign(await signingKey(env), capturePayload(id, v, exp))}`;
}

/** Whether a CAPTURE_HEADER value is valid now for id at v. */
export async function verifyCapture(
  env: Env,
  value: string | undefined,
  id: string,
  v: number,
  now = Date.now(),
): Promise<boolean> {
  if (!value) return false;
  const t = window_(value.trim(), CAPTURE_MAX_TTL_SEC, now);
  if (!t) return false;
  return hmacVerify(await signingKey(env), capturePayload(id, v, t.exp), t.sig);
}

/** "/p/{id}/v{v}/" (public artifacts only; checked per request). */
export function publicPrefix(id: string, v: number): string {
  return `/p/${id}/v${v}/`;
}

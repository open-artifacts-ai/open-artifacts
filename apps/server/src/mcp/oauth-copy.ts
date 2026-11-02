import { z } from "zod";
import { authConfig } from "../auth/config.js";
import type { Env } from "../env.js";
import { ApiError, toErrorResponse } from "../http/errors.js";
import { logInfo } from "../log.js";
import type { AppType } from "../routes/index.js";
import { sameKey } from "../util/crypto.js";
import {
  copyKvToD1,
  OAuthStoreConfigError,
  OAuthStoreMarkersError,
  syncStoreMarkers,
} from "./oauth-store.js";

// POST /__oa/oauth-store/copy (#1008): Platform's job drives the OAuth
// KV -> D1 copy (copyKvToD1) one page per call, on the app host only. On
// only with a 32+ char OAUTH_COPY_KEY (a secret only the copy job puts, per
// job; not HOSTED, which may only tighten); off, it is any unknown route.
// Order per request, as the test hooks: rate limit (RL_ANON; unbound is a
// refusal), then the bearer key (constant time), then the input. Before
// the key verifies every refusal looks like an unknown route (no reason);
// after it, the 404 body's error.details.reason says why (OAuthCopyRefusal,
// a fixed enum). Nothing logged or returned carries a key, a value or the
// cursor. No audit row: the audit log's actions are a shared contract enum
// (AuditActionSchema) with no system-ops entry; each call logs its counts.

export const OAUTH_COPY_PATH = "/__oa/oauth-store/copy";

export type OAuthCopyRefusal = "bad_input" | "not_dual" | "markers";

const MIN_KEY = 32;

type CopyEnv = Pick<Env, "OAUTH_COPY_KEY">;

export function oauthCopyOn(env: CopyEnv): boolean {
  return (
    typeof env.OAUTH_COPY_KEY === "string" &&
    env.OAUTH_COPY_KEY.length >= MIN_KEY
  );
}

/**
 * True for the copy route's requests while it is on: serveAppHost skips its
 * serve-path marker check for them, so the copy reports a markers refusal
 * as such once the key verifies (unknownRoute keeps the 503 before it).
 */
export const isOAuthCopyRequest = (env: CopyEnv, path: string) =>
  path === OAUTH_COPY_PATH && oauthCopyOn(env);

// `{}` starts a pass; a cursor is the previous call's nextCursor. Strict: an
// unknown key, a non-object or an empty body is bad_input.
const CopyInputSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
});

const notFound = () => toErrorResponse(new ApiError("not_found", "Not found"));
/** A refusal after the key verified: the same 404, plus a fixed-enum reason. */
const refused = (reason: OAuthCopyRefusal) =>
  toErrorResponse(new ApiError("not_found", "Not found", { reason }));
/**
 * What any unknown route answers here: the serve-path marker check first
 * (skipped for this path in serveAppHost), so a refused install's 503 shows
 * here too, then the standard 404.
 */
async function unknownRoute(env: Env): Promise<Response> {
  await syncStoreMarkers(env);
  return notFound();
}
const log = (outcome: string, counts: Record<string, number | null> = {}) =>
  logInfo(`oauth_copy.${outcome}`, counts);
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

/** The body's JSON, or undefined when it is empty or not JSON. */
async function bodyOf(req: Request): Promise<unknown> {
  const text = await req.text().catch(() => "");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Registered always; answers 404 like any unknown route unless oauthCopyOn. */
export function mountOAuthCopy(app: AppType): void {
  app.post(OAUTH_COPY_PATH, async (c) => {
    const env = c.env;
    if (!oauthCopyOn(env)) return notFound();
    // Rate limit first, before any key work; no limiter bound means refuse.
    const rl = env.RL_ANON;
    if (!rl) return unknownRoute(env);
    const ip = c.req.header("cf-connecting-ip") ?? "";
    const limited = !(
      await rl.limit({
        key: `oauth-copy:${authConfig(env).installKey}:${ip}`,
      })
    ).success;
    if (limited) {
      log("limited");
      return unknownRoute(env);
    }
    const given = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    if (!(await sameKey(given, env.OAUTH_COPY_KEY as string))) {
      log("denied");
      return unknownRoute(env);
    }
    const input = CopyInputSchema.safeParse(await bodyOf(c.req.raw));
    if (!input.success) {
      log("refused");
      return refused("bad_input");
    }
    try {
      const counts = await copyKvToD1(env, { cursor: input.data.cursor });
      log("ok", {
        kvKeys: counts.kvKeys,
        copied: counts.copied,
        skippedExpiring: counts.skippedExpiring,
        d1Rows: counts.d1Rows,
      });
      c.header("cache-control", "no-store");
      return c.json({ ...counts, backfilled: counts.nextCursor === null });
    } catch (e) {
      // Subclass first: a markers refusal is an OAuthStoreConfigError too.
      if (e instanceof OAuthStoreMarkersError) {
        log("refused");
        return refused("markers");
      }
      if (e instanceof OAuthStoreConfigError) {
        log("refused");
        return refused("not_dual");
      }
      throw e;
    }
  });
}

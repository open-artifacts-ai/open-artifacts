import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { normalizeEmail } from "@oa/auth-core";
import { newId, type Role } from "@oa/shared";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { getDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { runtimeStub } from "../src/runtime/do.js";

/** Inserts the user and mints a session cookie for them. */
export async function login(
  email: string,
  role: Role = "member",
): Promise<{ cookie: string; userId: string }> {
  const userId = newId();
  const e = normalizeEmail(email);
  if (!e) throw new Error(`invalid test email: ${email}`);
  await getDb(env)
    .insert(users)
    .values({
      id: userId,
      email: e,
      name: e.split("@")[0] ?? e,
      role,
      createdAt: Date.now(),
    });
  // The real epoch, like a real sign-in: a hand-signed e:0 cookie would hide
  // epoch bugs (the #369 Access regression).
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  return {
    cookie: `${sessionCookieName(env)}=${await signSession(
      env,
      userId,
      Date.now(),
      {
        provider: "access",
        epoch: row?.e ?? 0,
      },
    )}`,
    userId,
  };
}

type Fetcher = {
  fetch: (r: Request, e: typeof env, c: never) => Response | Promise<Response>;
};

/**
 * Calls `app` with a real ExecutionContext and awaits its waitUntil work
 * (e.g. search indexing after publish) before returning, so tests never race
 * background tasks.
 */
export async function fetchAndWait(
  app: Fetcher,
  req: Request,
  e: unknown = env,
  /** The invocation's ctx.props (the platform's broker capabilities). */
  props?: Record<string, unknown>,
): Promise<Response> {
  const ctx = createExecutionContext();
  if (props) Object.defineProperty(ctx, "props", { value: props });
  const r = await app.fetch(req, e as typeof env, ctx as never);
  await waitOnExecutionContext(ctx);
  return r;
}

/** Calls the app with a session cookie (and the CSRF header) or anonymously. */
export function api(
  app: Fetcher,
  path: string,
  auth: string | null,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-oa-request": "1",
    ...init.headers,
  };
  if (auth?.startsWith("oa_pat_")) headers.authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

export const errOf = async (r: Response) =>
  (
    (await r.json()) as {
      error: { code: string; message: string; details?: unknown };
    }
  ).error;

/**
 * Fires the artifact DO's alarm now (C3: search indexing runs there), so
 * tests index deterministically, without sleeps. True if an alarm was set.
 */
export const runIndex = (id: string, e: { ARTIFACT_RUNTIME: unknown } = env) =>
  runDurableObjectAlarm(
    runtimeStub(e as never, id) as unknown as DurableObjectStub,
  );

/** env with PLAN "paid": the 1 MB data-doc limit and the Paid /mcp body cap. */
export const PAID_ENV = { ...(env as object), PLAN: "paid" } as typeof env;

/**
 * Puts the artifact's runtime DO on the Paid plan (the DO reads PLAN from its
 * own env, which tests can't pass per call).
 */
export const doAsPaid = (stub: unknown) =>
  runInDurableObject(stub as DurableObjectStub, (i) => {
    (i as unknown as { env: object }).env = PAID_ENV;
  });

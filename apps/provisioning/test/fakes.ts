import type { Env } from "../src/env.js";
import { RATE_LIMIT_BINDINGS, type RateBucket } from "../src/limits.js";

export const APP = "hosted.test";
export const ADMIN = `https://admin.${APP}`;
export const API = `https://api.${APP}`;

export type FakeLimiter = RateLimit & { keys: string[]; allow: boolean };
export const limiter = (allow = true): FakeLimiter => {
  const keys: string[] = [];
  const l = {
    keys,
    allow,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: l.allow };
    },
  };
  return l;
};

/** An Env with fake bindings; only what the skeleton reads is real. */
export function fakeEnv(over: Partial<Env> = {}) {
  const limits = Object.fromEntries(
    (Object.values(RATE_LIMIT_BINDINGS) as string[]).map((b) => [b, limiter()]),
  ) as Record<(typeof RATE_LIMIT_BINDINGS)[RateBucket], FakeLimiter>;
  const assets: Request[] = [];
  const env = {
    OA_ENV: "staging",
    APP_DOMAIN: APP,
    ADMIN_IDENTITIES: "me@example.com:123",
    SIGNUPS_ENABLED: "false",
    SELF_SERVE_TIER: "trial",
    MCP_REDIRECT_URIS: "https://claude.ai/api/mcp/auth_callback",
    ADMIN_SESSION_KEY: "k".repeat(32),
    ADMIN_BROKER_KEY: "unused",
    PLATFORM_DB: {} as D1Database,
    PROVISION_INSTALL: {} as Env["PROVISION_INSTALL"],
    MANAGE_INSTALL: {} as Env["MANAGE_INSTALL"],
    PROVISIONER: {} as Env["PROVISIONER"],
    AUTH_BROKER: {} as Fetcher,
    SIGNUPS: {} as Queue,
    OAUTH_KV: {} as KVNamespace,
    ASSETS: {
      fetch: async (r: Request) => {
        assets.push(r);
        return new Response("spa", { status: 200 });
      },
    } as unknown as Fetcher,
    ...limits,
    ...over,
  } as Env;
  return { env, limits, assets };
}

export const ctx = () =>
  ({
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

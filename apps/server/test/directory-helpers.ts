import { env } from "cloudflare:workers";
import { keyId, publicFromPkcs8 } from "@oa/auth-core";
import { R } from "@oa/shared";
import { clearRegistryCache } from "../../../packages/broker-core/src/index.js";
import broker, {
  type Env as BrokerEnv,
} from "../../directory-broker/src/index.js";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { direct, TEST_BROKER_KEY } from "./auth-helpers.js";
import { type FakeDirectory, routeOrigin } from "./fixtures/fake-directory.js";
import { fetchAndWait } from "./helpers.js";

// Shared by the directory connect and transport suites (P3 T12).

export const app = createApp();
export const APP = "http://app.localhost";
export const BROKER = "https://directory.hosted.test";
export const DIR_CID = "dir-cid.apps.googleusercontent.com";
export const BROKER_DIR_CID = "broker-dir-cid.apps.googleusercontent.com";
export const DIR_KEY = "directory-token-key-0123456789abcdef";
const SYNC = "spaces,sync_google";

const brokerRl = () => ({ limit: async () => ({ success: true }) });
/** The directory broker's env (its registry is this pool's KV, read only by it). */
export const brokerEnv = {
  DIRECTORY_REGISTRY: env.OAUTH_KV,
  GOOGLE_DIRECTORY_CLIENT_ID: BROKER_DIR_CID,
  GOOGLE_DIRECTORY_CLIENT_SECRET: "broker-dir-secret",
  DIRECTORY_ORIGIN: BROKER,
  DIRECTORY_STATE_KEY: "s".repeat(40),
  RL_DIRECTORY_IP: brokerRl(),
  RL_DIRECTORY_INSTALL: brokerRl(),
} as unknown as BrokerEnv;

// Every fakeDirectory() spy sends DIRECTORY_BROKER_URL requests here.
routeOrigin(BROKER, (req) => broker.fetch(req as never, brokerEnv));

/** Requests a fake DIRECTORY_BROKER capability forwarded (path and method). */
export type GateCall = { method: string; path: string };

/**
 * The platform's DIRECTORY_BROKER capability, faked: forwards to the real
 * directory broker module (as the platform's stub forwards to its fixed
 * origin) and records each call in `calls`.
 */
export function brokerGate(calls: GateCall[] = []) {
  return {
    calls,
    fetch: (req: Request) => {
      const u = new URL(req.url);
      calls.push({ method: req.method, path: u.pathname });
      return broker.fetch(
        req as never,
        brokerEnv,
      ) as unknown as Promise<Response>;
    },
  };
}

/** ctx.props for a hosted invocation: the directory capability (shared calls log). */
export const gateCalls: GateCall[] = [];
export const hostedProps = (): Record<string, unknown> => ({
  DIRECTORY_BROKER: brokerGate(gateCalls),
});
const propsFor = (e: Env) => (e.HOSTED === "1" ? hostedProps() : undefined);

/** Self-host with its own Google app (direct transport). */
export const directEnv = (over: Partial<Env> = {}): Env =>
  direct({
    FEATURES: SYNC,
    GOOGLE_DIRECTORY_CLIENT_ID: DIR_CID,
    GOOGLE_DIRECTORY_CLIENT_SECRET: "dir-secret",
    DIRECTORY_TOKEN_KEY: DIR_KEY,
    ...over,
  });

/**
 * Hosted (HOSTED=1) through the real directory broker module: every fake
 * Google fetch spy routes DIRECTORY_BROKER_URL to it (routeOrigin).
 */
export const hostedEnv = (over: Partial<Env> = {}): Env => {
  const e = direct({
    HOSTED: "1",
    // Hosted billing: with no BILLING gate the provisioned TIER sets the
    // features (Business: sync_google); without one, free and solo.
    TIER: "business",
    FEATURES: SYNC,
    DIRECTORY_BROKER_URL: BROKER,
    BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    DIRECTORY_TOKEN_KEY: DIR_KEY,
    ...over,
  });
  // Hosted installs never hold a Google client secret.
  delete (e as Partial<Env>).GOOGLE_CLIENT_SECRET;
  return e;
};

/** Registers inst-a with the directory broker (origin app.localhost, hd a.com). */
export async function registerInstall() {
  clearRegistryCache();
  const x = await publicFromPkcs8(TEST_BROKER_KEY);
  await env.OAUTH_KV.put(
    "install:inst-a",
    JSON.stringify({
      installId: "inst-a",
      origin: "https://app.localhost",
      keys: [{ kid: await keyId(x), x }],
      domains: ["a.com"],
    }),
  );
  await env.OAUTH_KV.put(
    "install:inst-b",
    JSON.stringify({
      installId: "inst-b",
      origin: "https://b.localhost",
      keys: [{ kid: await keyId(x), x }],
      domains: ["b.com"],
    }),
  );
}

export const get = (e: Env, path: string, cookie?: string) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}),
    e,
    propsFor(e),
  );
export const loc = (r: Response) => r.headers.get("location") ?? "";

/** The connect redirect: the dir state cookie and the consent URL. */
export async function begin(e: Env, session: string) {
  const r = await get(e, R.directoryConnect, session);
  const dirCookie =
    r.headers
      .getSetCookie()
      .find((c) => /oa_dir=/.test(c))
      ?.split(";")[0] ?? "";
  return { r, dirCookie, to: r.status === 302 ? new URL(loc(r)) : null };
}

export type Grant = {
  sub: string;
  hd?: string | null;
  scope?: string;
  /** Overrides the ID token aud (default: the transport's client id). */
  aud?: string;
};

/**
 * One full connect for `session` on `e` (direct or broker), with Google
 * granting `grant`. Returns the callback redirect's query, plus the raw
 * pieces for attack tests. A consent that passed every check is then
 * confirmed (R.directoryConfirm) unless `confirm: false`; `ok` is true when
 * both steps succeeded.
 */
export async function connect(
  e: Env,
  session: string,
  g: FakeDirectory,
  grant: Grant,
  o: { tamper?: (u: URL) => void; cookie?: string; confirm?: boolean } = {},
) {
  const b = await begin(e, session);
  if (!b.to) throw new Error(`connect ${b.r.status}`);
  const cookie = `${session}; ${o.cookie ?? b.dirCookie}`;
  let back: URL;
  if (b.to.origin === BROKER) {
    const toGoogle = await broker.fetch(new Request(b.to) as never, brokerEnv);
    const gq = new URL(loc(toGoogle)).searchParams;
    const code = g.issueCode(gq.get("code_challenge") as string, {
      ...grant,
      aud: grant.aud ?? BROKER_DIR_CID,
    });
    const viaBroker = await broker.fetch(
      new Request(
        `${BROKER}/google/directory/callback?code=${code}&state=${encodeURIComponent(gq.get("state") ?? "")}`,
      ) as never,
      brokerEnv,
    );
    back = new URL(loc(viaBroker));
  } else {
    const code = g.issueCode(
      b.to.searchParams.get("code_challenge") as string,
      {
        ...grant,
        aud: grant.aud ?? DIR_CID,
      },
    );
    back = new URL(R.directoryCallback, APP);
    back.searchParams.set("code", code);
    back.searchParams.set("state", b.to.searchParams.get("state") ?? "");
  }
  o.tamper?.(back);
  const r = await get(e, `${back.pathname}${back.search}`, cookie);
  const q = new URL(loc(r)).searchParams;
  const consented = r.status === 302 && !q.has("error");
  const confirmed =
    consented && o.confirm !== false
      ? await post(e, R.directoryConfirm, session)
      : null;
  return {
    r,
    back,
    cookie,
    q,
    path: new URL(loc(r)).pathname,
    consented,
    confirmed,
    ok: consented && (o.confirm === false || confirmed?.status === 200),
  };
}

/** A same-origin POST with the CSRF header. */
export const post = (e: Env, path: string, cookie?: string) =>
  fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: { "x-oa-request": "1", ...(cookie ? { cookie } : {}) },
    }),
    e,
    propsFor(e),
  );

/** Wipes the directory connection between tests (one D1 per file). */
export const resetDirectory = () =>
  env.DB.prepare("delete from directory_state").run();

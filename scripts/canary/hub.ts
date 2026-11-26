// The Open Artifacts instance the canary runs against, and the few calls it
// makes to it: a member signed in, a token, a machine approval through the
// real approval form, the bus agent list and a published page's versions.
//
// Staging (the scheduled default) is rl-a, the staging install with test
// hooks (https://rl-a.open-artifacts-staging.app): each run signs in a new
// member through TEST_HOOKS.session, as the dashboard's staging e2e does
// (apps/dashboard/e2e/staging/rl-a/fixtures.ts), and approves its machines on
// the real /bus/approve page. A passing run erases that member again through
// TEST_HOOKS.peoplePurge. The local server, for development only, is
// `wrangler dev` with ENVIRONMENT=dev on a fresh local D1, R2, KV and Durable
// Objects, as the dashboard's real-server e2e starts it
// (apps/dashboard/e2e/real/fixtures.ts).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutSecrets } from "./clients.ts";
import { FETCH_MS, Session, until } from "./lib.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER = join(ROOT, "apps/server");
const WRANGLER = join(SERVER, "node_modules/.bin/wrangler");

/** The paths the canary calls (packages/shared routes.ts and bus-protocol BUS_ROUTES). */
export const PATHS = {
  devLogin: "/auth/dev-login",
  me: "/api/v1/me",
  tokens: "/api/v1/tokens",
  busAgents: "/api/v1/bus/agents",
  artifacts: "/api/v1/artifacts",
  device: "/bus/device",
  deviceToken: "/bus/device/token",
  approve: "/bus/approve",
  healthz: "/healthz",
  hookSession: "/__test/session",
  hookPurge: "/__test/people-purge",
  connect: "/bus/connect",
  mcp: "/mcp",
} as const;

/** wrangler.template.jsonc with placeholders filled for a local dev server on `port`. */
export function devConfig(port: number): Record<string, unknown> {
  const fill: Record<string, string> = {
    WORKER_NAME: "oa-canary",
    APP_HOST: `localhost:${port}`,
    CONTENT_HOST: `content.localhost:${port}`,
    D1_NAME: "oa-canary",
    D1_ID: "00000000-0000-0000-0000-000000000000",
    R2_BUCKET: "oa-canary",
    KV_ID: "oa-canary-kv",
    OWNER_EMAIL: "owner@canary.test",
    EMAIL_FROM: "noreply@mail.canary.test",
    ACCESS_TEAM_DOMAIN: "access.canary.invalid",
    ACCESS_CLIENT_ID: "canary-client",
    CF_ACCOUNT_ID: "canary-account",
  };
  const raw = readFileSync(join(SERVER, "wrangler.template.jsonc"), "utf8");
  const filled = raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = fill[k];
    if (v === undefined) throw new Error(`canary: no value for {{${k}}}`);
    return v;
  });
  const cfg = JSON.parse(filled);
  delete cfg.routes;
  delete cfg.triggers;
  cfg.main = join(SERVER, cfg.main);
  cfg.assets.directory = join(SERVER, cfg.assets.directory);
  for (const db of cfg.d1_databases)
    db.migrations_dir = join(SERVER, db.migrations_dir);
  const secret = () => randomBytes(32).toString("hex");
  cfg.vars = {
    ...cfg.vars,
    ENVIRONMENT: "dev",
    ACCESS_CLIENT_SECRET: secret(),
    SESSION_SECRET: secret(),
    CONTENT_SIGNING_KEY: secret(),
  };
  return cfg;
}

/**
 * Migrates and starts `wrangler dev` on `port` (the server must be built:
 * `pnpm --filter @oa/server build`). Resolves to its origin and teardown once
 * /healthz answers.
 */
export async function startServer(
  port: number,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = `http://localhost:${port}`;
  const dir = mkdtempSync(join(tmpdir(), "oa-canary-server-"));
  const config = join(dir, "wrangler.json");
  const state = join(dir, "state");
  writeFileSync(config, JSON.stringify(devConfig(port), null, 2));
  // The server never needs a canary secret.
  const env: NodeJS.ProcessEnv = { ...withoutSecrets(process.env), CI: "1" };
  delete env.VITE_MOCK;
  execFileSync(
    WRANGLER,
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "-c",
      config,
      "--persist-to",
      state,
    ],
    { cwd: SERVER, stdio: "inherit", env, timeout: 180_000 },
  );
  const logPath = join(dir, "wrangler.log");
  const log = openSync(logPath, "a");
  const child: ChildProcess = spawn(
    WRANGLER,
    [
      "dev",
      "-c",
      config,
      "--persist-to",
      state,
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--show-interactive-dev-session=false",
    ],
    { cwd: SERVER, stdio: ["ignore", log, log], detached: true, env },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  const kill = (signal: NodeJS.Signals) => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  const stop = async () => {
    kill("SIGTERM");
    await until("wrangler dev to stop", () => (exited ? true : undefined), {
      ms: 10_000,
      everyMs: 200,
    }).catch(() => kill("SIGKILL"));
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await until(
      "the local server to answer /healthz",
      async () => {
        if (exited)
          throw new Error(
            `wrangler dev exited\n${readFileSync(logPath, "utf8")}`,
          );
        if (
          !readFileSync(logPath, "utf8").includes(
            `Ready on http://127.0.0.1:${port}`,
          )
        )
          return undefined;
        return (
          await fetch(`${origin}/healthz`, {
            signal: AbortSignal.timeout(10_000),
          })
        ).ok
          ? true
          : undefined;
      },
      { ms: 180_000, everyMs: 500 },
    );
  } catch (e) {
    await stop();
    throw e;
  }
  return { origin, stop };
}

/** rl-a, the staging install with test hooks; CANARY_STAGING_URL (a repo variable) may name another. */
export const STAGING_URL = "https://rl-a.open-artifacts-staging.app";
/** The address domain rl-a's hooks may sign in (its TEST_DOMAIN); CANARY_STAGING_TEST_DOMAIN may name another. */
export const STAGING_TEST_DOMAIN = "oa-redline-a.fyi";
/** The session cookie on an https install (apps/server/src/auth/session.ts). */
export const STAGING_COOKIE = "__Host-oa_session";

/**
 * The staging origin, refused unless it is a bare https origin one label
 * under open-artifacts-staging.app (the staging test-hooks installs), so the
 * hook key and the tokens are never sent anywhere else.
 */
export function stagingOrigin(v: string | undefined): string {
  const raw = v || STAGING_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`CANARY_STAGING_URL is not a URL: ${raw}`);
  }
  if (
    u.protocol !== "https:" ||
    u.origin !== raw ||
    !/^[a-z0-9-]+\.open-artifacts-staging\.app$/.test(u.hostname)
  )
    throw new Error(
      `CANARY_STAGING_URL must be a bare https origin one label under open-artifacts-staging.app, not ${raw}`,
    );
  return raw;
}

/** Hook calls fail by status only: a refusal body is never printed. */
async function hookPost(
  origin: string,
  key: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_MS),
  });
}

/**
 * A new member on rl-a, signed in through TEST_HOOKS.session, with a display
 * name. The install must report test hooks on before the key is sent.
 */
export async function hookMember(
  origin: string,
  key: string,
  email: string,
): Promise<Session> {
  const h = await fetch(`${origin}${PATHS.healthz}`, {
    signal: AbortSignal.timeout(FETCH_MS),
  });
  const health = h.ok ? ((await h.json()) as { testHooks?: boolean }) : {};
  if (health.testHooks !== true)
    throw new Error(
      `${origin} does not report test hooks on (/healthz testHooks): the canary sends its hook key only to a test-hooks install`,
    );
  const res = await hookPost(origin, key, PATHS.hookSession, {
    email,
    role: "member",
  });
  if (res.status === 404)
    throw new Error(
      `${origin} refused the session hook (HTTP 404): check CANARY_RL_A_HOOK_KEY is rl-a's TEST_HOOK_KEY, and that ${email.split("@")[1]} is its TEST_DOMAIN`,
    );
  if (!res.ok) throw new Error(`session hook: HTTP ${res.status}`);
  const { cookie } = (await res.json()) as { cookie: string };
  const s = new Session(origin, { cookies: { [STAGING_COOKIE]: cookie } });
  const me = await s.fetch(PATHS.me, {
    method: "PATCH",
    headers: { "X-OA-Request": "1", "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Client canary" }),
  });
  if (!me.ok) throw new Error(`set name: HTTP ${me.status}`);
  return s;
}

/**
 * Erases the members whose address starts with `prefix` (a t19- prefix: the
 * only one the hook acts on), their pages, tokens and machines with them.
 * How many it erased.
 */
export async function purgeMembers(
  origin: string,
  key: string,
  prefix: string,
): Promise<number> {
  const res = await hookPost(origin, key, PATHS.hookPurge, {
    prefix,
    before: Date.now(),
    limit: 5,
  });
  if (!res.ok) throw new Error(`people purge hook: HTTP ${res.status}`);
  const r = (await res.json()) as { erased: number; failed: number };
  if (r.failed > 0) throw new Error(`people purge: ${r.failed} not erased`);
  return r.erased;
}

/** A member signed in through the dev login (ENVIRONMENT=dev only), with a display name. */
export async function signIn(origin: string, email: string): Promise<Session> {
  const s = new Session(origin);
  const q = new URLSearchParams({ email, role: "member", next: "/" });
  const res = await s.fetch(`${PATHS.devLogin}?${q}`);
  if (res.status !== 302)
    throw new Error(`dev sign-in: HTTP ${res.status} ${await res.text()}`);
  const me = await s.fetch(PATHS.me, {
    method: "PATCH",
    headers: { "X-OA-Request": "1", "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Client canary" }),
  });
  if (!me.ok) throw new Error(`set name: HTTP ${me.status}`);
  return s;
}

/** A personal token for the signed-in member. The value is never printed. */
export async function createToken(s: Session, label: string): Promise<string> {
  const res = await s.fetch(PATHS.tokens, {
    method: "POST",
    headers: { "X-OA-Request": "1", "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw new Error(`create token: HTTP ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

const csrfOf = (html: string): string => {
  const m = /name="csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error("the approval page has no form token");
  return m[1];
};

/** Approves `userCode` the way a person does on /bus/approve: type the code, then Approve. */
export async function approveCode(s: Session, userCode: string): Promise<void> {
  const entry = await s.fetch(PATHS.approve);
  if (entry.status === 404)
    throw new Error(
      `approval page: HTTP 404 on ${s.origin}: the bus is off there (hosted installs need the bus feature on)`,
    );
  if (!entry.ok) throw new Error(`approval page: HTTP ${entry.status}`);
  const post = (form: Record<string, string>) =>
    s.fetch(PATHS.approve, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  const typed = await post({
    step: "code",
    csrf: csrfOf(await entry.text()),
    code: userCode,
  });
  const page = await typed.text();
  if (!typed.ok || !page.includes('name="step" value="decide"'))
    throw new Error(`the code was not accepted: HTTP ${typed.status}`);
  const done = await post({
    step: "decide",
    csrf: csrfOf(page),
    code: userCode,
    decision: "approve",
  });
  if (!done.ok) throw new Error(`approve: HTTP ${done.status}`);
}

/**
 * A second machine for the probe: the device flow by hand, approved by the
 * same member. Returns its machine token (never printed).
 */
export async function approveProbeMachine(
  s: Session,
  label: string,
): Promise<string> {
  const res = await fetch(`${s.origin}${PATHS.device}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine_label: label }),
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (res.status !== 201) throw new Error(`bus/device: HTTP ${res.status}`);
  const dev = (await res.json()) as {
    device_code: string;
    user_code: string;
    interval: number;
  };
  await approveCode(s, dev.user_code);
  return until(
    "the probe machine token",
    async () => {
      const t = await fetch(`${s.origin}${PATHS.deviceToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: dev.device_code }),
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (t.status === 429) return undefined;
      const j = (await t.json()) as { machine_token?: string };
      return j.machine_token;
    },
    { ms: 60_000, everyMs: (dev.interval + 0.5) * 1000 },
  );
}

export type BusAgent = {
  name: string;
  kind: string;
  namespace: string;
  state: string;
  machineLabel: string;
  status?: string;
};

/** The member's bus agents, as the Bus page lists them. */
export async function busAgents(s: Session): Promise<BusAgent[]> {
  const res = await s.fetch(PATHS.busAgents);
  if (!res.ok) throw new Error(`bus agents: HTTP ${res.status}`);
  return ((await res.json()) as { agents: BusAgent[] }).agents;
}

export type VersionAgent = {
  name: string;
  linked?: boolean;
  product?: string;
};

/** The newest version's agent of the member's artifact titled `title`, or undefined. */
export async function publishedBy(
  s: Session,
  title: string,
): Promise<VersionAgent | null | undefined> {
  const res = await s.fetch(
    `${PATHS.artifacts}?${new URLSearchParams({ scope: "mine", limit: "100" })}`,
  );
  if (!res.ok) throw new Error(`artifacts: HTTP ${res.status}`);
  const page = (await res.json()) as {
    items?: { id: string; title: string }[];
  };
  const hit = (page.items ?? []).find((a) => a.title === title);
  if (!hit) return undefined;
  const v = await s.fetch(
    `${PATHS.artifacts}/${encodeURIComponent(hit.id)}/versions`,
  );
  if (!v.ok) throw new Error(`versions: HTTP ${v.status}`);
  const versions = (await v.json()) as { agent?: VersionAgent | null }[];
  return versions[0]?.agent ?? null;
}

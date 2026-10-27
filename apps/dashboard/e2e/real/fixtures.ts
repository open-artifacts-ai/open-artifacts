/// <reference types="node" />
// Real-server e2e: `wrangler dev` for @oa/server (ENVIRONMENT=dev) on a fresh
// local D1/R2/KV/DO persisted to a temp dir, serving the built dashboard.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH,
  LIMITS,
  type PublishInput,
  type PublishResult,
  R,
  type Role,
  type TokenCreated,
} from "@oa/shared";
import { test as base, expect, type Page } from "@playwright/test";

export const PORT = Number(process.env.OA_E2E_PORT ?? 8787);
// The app on plain `localhost` (an OAuth loopback host): the MCP resource can
// then be http://localhost:PORT/mcp, matching what the OAuth provider derives
// from request URLs. `app.localhost` is NOT loopback per
// @cloudflare/workers-oauth-provider, so its resource must be https and can
// never match dev's http origin (token audience mismatch). The content host
// keeps a separate origin for the app/content split.
export const APP_HOST = `localhost:${PORT}`;
export const CONTENT_HOST = `content.localhost:${PORT}`;
export const APP = `http://${APP_HOST}`;
/**
 * A page on another loopback origin that frames `?src=` (an /a/<id>/full on
 * APP), allowed by EMBED_ORIGINS. Served by global-setup: a page.route page
 * counts as public, and Chrome's local network access check would block it
 * from framing localhost.
 */
export const EMBEDDER_PORT = PORT + 1;
export const EMBEDDER = `http://embedder.localhost:${EMBEDDER_PORT}`;
/** OIDC issuer host: reserved, so the IdP leg of a login never leaves the machine. */
export const ACCESS_TEAM_DOMAIN = "access.e2e.invalid";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SERVER = join(ROOT, "apps/server");
const WRANGLER = join(SERVER, "node_modules/.bin/wrangler");

const run = (cmd: string, args: string[], cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: devEnv() });

/** The child env: never the mock build. */
function devEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITE_MOCK;
  return env;
}

/** wrangler.template.jsonc with placeholders filled, routes dropped and dev vars. */
export function devConfig(): Record<string, unknown> {
  const fill: Record<string, string> = {
    WORKER_NAME: "oa-e2e",
    APP_HOST,
    CONTENT_HOST,
    D1_NAME: "oa-e2e",
    D1_ID: "00000000-0000-0000-0000-000000000000",
    R2_BUCKET: "oa-e2e",
    KV_ID: "oa-e2e-kv",
    OWNER_EMAIL: "owner@e2e.test",
    // wrangler dev simulates send_email locally: nothing is sent.
    EMAIL_FROM: "noreply@mail.e2e.test",
    ACCESS_TEAM_DOMAIN,
    ACCESS_CLIENT_ID: "e2e-client",
    CF_ACCOUNT_ID: "e2e-account",
  };
  const raw = readFileSync(join(SERVER, "wrangler.template.jsonc"), "utf8");
  const filled = raw.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = fill[k];
    if (v === undefined) throw new Error(`fixtures: no value for {{${k}}}`);
    return v;
  });
  const cfg = JSON.parse(filled);
  // Custom-domain routes would make wrangler dev rewrite the request host.
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
    // A test-only page that frames /a/<id>/full (artifact-links.spec, embed mode).
    EMBED_ORIGINS: EMBEDDER,
    EMBED_ALLOW_SAME_SITE: "1",
    // The spaces suite (playwright.spaces.config.ts): a direct-sign-in install
    // (only those report features in Me) with hosted features on.
    ...(process.env.OA_E2E_FEATURES
      ? { FEATURES: process.env.OA_E2E_FEATURES, AUTH_PROVIDERS: "email" }
      : {}),
    ACCESS_CLIENT_SECRET: secret(),
    SESSION_SECRET: secret(),
    CONTENT_SIGNING_KEY: secret(),
  };
  return cfg;
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${APP}/healthz`)).ok;
  } catch {
    return false;
  }
}

/** Whether anything accepts connections on 127.0.0.1:PORT. */
const portBusy = () =>
  new Promise<boolean>((resolve) => {
    const sock = connect({ host: "127.0.0.1", port: PORT });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });

/** Builds, migrates and starts the server; resolves to its teardown once /healthz answers. */
export async function startServer(): Promise<() => Promise<void>> {
  if (await portBusy())
    throw new Error(
      `fixtures: port ${PORT} is already in use (a leftover wrangler dev?). Stop it, or set OA_E2E_PORT to a free port.`,
    );
  if (!process.env.OA_E2E_SKIP_BUILD) {
    run("pnpm", ["--filter", "@oa/shared", "build"]);
    run("pnpm", ["--filter", "@oa/server", "build"]);
  }
  const dir = mkdtempSync(join(tmpdir(), "oa-e2e-"));
  let child: ChildProcess | undefined;
  let exited = false;
  // The group (wrangler and workerd), only while wrangler is alive: once it has
  // exited, its group id may be reused (on a shared machine, by anyone's
  // processes), so signalling -pid then could hit something else.
  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (child?.pid === undefined || exited) return;
    try {
      process.kill(-child.pid, signal);
    } catch (e) {
      // Gone already, or no longer ours.
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw e;
    }
  };
  const onExit = () => kill();
  process.once("exit", onExit);
  try {
    const config = join(dir, "wrangler.json");
    const state = join(dir, "state");
    writeFileSync(config, JSON.stringify(devConfig(), null, 2));
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
      { cwd: SERVER, stdio: "inherit", env: { ...devEnv(), CI: "1" } },
    );
    const log = openSync(join(dir, "wrangler.log"), "a");
    child = spawn(
      WRANGLER,
      [
        "dev",
        "-c",
        config,
        "--persist-to",
        state,
        "--port",
        String(PORT),
        "--ip",
        "127.0.0.1",
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: SERVER,
        stdio: ["ignore", log, log],
        detached: true,
        env: devEnv(),
      },
    );
    const proc = child;
    proc.on("exit", () => {
      exited = true;
    });
    const deadline = Date.now() + 120_000;
    while (!(await healthy())) {
      if (exited || Date.now() > deadline) {
        const out = readFileSync(join(dir, "wrangler.log"), "utf8");
        throw new Error(`fixtures: wrangler dev did not start\n${out}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return async () => {
      const gone = new Promise<boolean>((r) =>
        exited ? r(true) : proc.once("exit", () => r(true)),
      );
      kill();
      const timeout = new Promise<boolean>((r) =>
        setTimeout(() => r(false), 10_000).unref(),
      );
      // Still up after SIGTERM: kill the whole group (workerd too) while the
      // group is certainly still ours.
      if (!(await Promise.race([gone, timeout]))) kill("SIGKILL");
      process.removeListener("exit", onExit);
      rmSync(dir, { recursive: true, force: true });
    };
  } catch (e) {
    kill("SIGKILL");
    process.removeListener("exit", onExit);
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Alphanumeric, so it is one search token. */
export const uniq = () => randomBytes(6).toString("hex");

/** A fresh address per test and project, so specs never see each other's data. */
export const freshEmail = (tag: string) => `${tag}-${uniq()}@e2e.test`;

/** Signs `page`'s context in through AUTH.devLogin (the request shares the context's cookies). */
/**
 * Signs in. Dev login names users after the email's local part, which the
 * dashboard asks to replace with a real name (a dialog over every page), so
 * this sets one unless `named` is false.
 */
export async function loginAs(
  page: Page,
  email: string,
  role: Role,
  { named = true }: { named?: boolean } = {},
) {
  const q = new URLSearchParams({ email, role, next: "/" });
  const res = await page.request.get(`${APP}${AUTH.devLogin}?${q}`, {
    maxRedirects: 0,
  });
  expect(res.status(), await res.text()).toBe(302);
  if (!named) return;
  const me = await page.request.patch(`${APP}${R.me}`, {
    headers: { "X-OA-Request": "1" },
    data: { displayName: `E2E ${email.split("@")[0]}` },
  });
  expect(me.ok(), await me.text()).toBe(true);
}

/** A PAT for the signed-in user of `page`. */
export async function createToken(page: Page, label = "e2e") {
  const res = await page.request.post(`${APP}${R.tokens}`, {
    headers: { "X-OA-Request": "1" },
    data: { label },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as TokenCreated).token;
}

export async function publishViaApi(
  pat: string,
  input: PublishInput,
): Promise<PublishResult> {
  // Every fixture publishes inline; a larger one must go through R.uploads instead.
  const body = JSON.stringify(input);
  expect(
    new TextEncoder().encode(body).length,
    "publishViaApi: inline publish over LIMITS.inlineBytes",
  ).toBeLessThan(LIMITS.inlineBytes);
  const res = await fetch(`${APP}${R.artifacts}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body,
  });
  const text = await res.text();
  expect(res.ok, text).toBe(true);
  return JSON.parse(text) as PublishResult;
}

export type Member = { email: string; pat: string };

export const test = base.extend<{ member: Member }>({
  // A fresh member signed in on `page`, with a PAT for API publishing.
  member: async ({ page }, use, info) => {
    const email = freshEmail(info.project.name);
    await loginAs(page, email, "member");
    await use({ email, pat: await createToken(page) });
  },
});
export { expect };

/** The artifact iframe in the viewer. */
export const artifactFrame = (page: Page) =>
  page.frameLocator("iframe.oa-vframe");

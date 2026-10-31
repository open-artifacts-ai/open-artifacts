import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformNames } from "@oa/provision";
import { afterEach, describe, expect, it } from "vitest";
import {
  REDLINE_TOKEN_WARN_MS,
  run,
  SCHEDULER_STALE_MS,
} from "../scripts/prodclean-monitor.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ACCT = "0123456789abcdef0123456789abcdef";
const BUCKET = platformNames("prod").releases;
const ID = "iabcdefghijk";
const HOST = "acme.open-artifacts.app";
const INV = "https://oa-p-inventory.example.workers.dev";
const MINT = "https://pipelines.actions.test/idtoken?api-version=2.0";
const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJvYS1wLWludmVudG9yeSJ9.c2lnbmF0dXJl";
const REQ_TOKEN = "gh-request-token-value";
const R2_TOKEN = "r2-token-value";
const SCRIPTS_TOKEN = "scripts-token-value";
const LINE = /^prod-clean: (pass|fail \([a-z][a-z0-9_]{0,39}\))\n$/;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function secrets() {
  const d = mkdtempSync(join(tmpdir(), "oa-monitor-test-"));
  dirs.push(d);
  writeFileSync(join(d, "REDLINE_PROD_R2_TOKEN"), R2_TOKEN, { mode: 0o600 });
  writeFileSync(join(d, "REDLINE_PROD_SCRIPTS_TOKEN"), SCRIPTS_TOKEN, {
    mode: 0o600,
  });
  return d;
}

const baseEnv = () => ({
  INVENTORY_URL: INV,
  INVENTORY_OIDC_AUDIENCE: "oa-p-inventory",
  REDLINE_PROD_ACCOUNT_ID: ACCT,
  REDLINE_PROD_SECRETS_DIR: secrets(),
  ACTIONS_ID_TOKEN_REQUEST_URL: MINT,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQ_TOKEN,
});

interface World {
  mint: number | { value?: unknown };
  health: number | { schedulerTickAt: number | null };
  installs: object[];
  healthz: Record<string, unknown>;
  tokens: Record<string, { status: string; expires_on?: string } | number>;
  report: number;
  r2Throws?: boolean;
}

const world = (): World => ({
  mint: { value: JWT },
  health: { schedulerTickAt: NOW - 60_000 },
  installs: [],
  healthz: { ok: true, installId: ID },
  tokens: {
    [R2_TOKEN]: { status: "active", expires_on: "2027-10-01T00:00:00Z" },
    [SCRIPTS_TOKEN]: { status: "active" },
  },
  report: 204,
});

const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A fake GitHub id-token endpoint, Cloudflare API, inventory and /healthz. */
function fake(w: World) {
  const calls: { url: string; auth: string | null; body?: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({
      url,
      auth,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const u = new URL(url);
    if (url.startsWith("https://pipelines.actions.test/")) {
      if (auth !== `bearer ${REQ_TOKEN}`) return res(401);
      return typeof w.mint === "number" ? res(w.mint) : res(200, w.mint);
    }
    if (u.origin === INV) {
      if (auth !== `Bearer ${JWT}`) return res(401);
      if (u.pathname === "/health")
        return typeof w.health === "number"
          ? res(w.health)
          : res(200, w.health);
      if (u.pathname === "/installs") return res(200, { installs: w.installs });
      if (u.pathname === "/prodclean") return res(w.report);
    }
    if (u.origin === "https://api.cloudflare.com") {
      const p = u.pathname;
      if (p.endsWith("/tokens/verify")) {
        const t = w.tokens[(auth ?? "").replace("Bearer ", "")];
        if (!t || typeof t === "number")
          return res(typeof t === "number" ? t : 401);
        return res(200, { success: true, result: t });
      }
      if (p === `/client/v4/accounts/${ACCT}/r2/buckets/${BUCKET}/objects`) {
        if (w.r2Throws) throw new TypeError("fetch failed");
        return res(200, {
          success: true,
          result: [],
          result_info: { is_truncated: false },
        });
      }
      const script = `/client/v4/accounts/${ACCT}/workers/dispatch/namespaces/oa-prod/scripts/oa-p-${ID}`;
      if (p === `${script}/secrets`)
        return res(200, { success: true, result: [] });
      if (p === `${script}/settings`)
        return res(200, { success: true, result: { bindings: [] } });
    }
    if (u.origin === `https://${HOST}` && u.pathname === "/healthz")
      return res(200, w.healthz);
    return res(404);
  }) as typeof fetch;
  return { f, calls };
}

async function monitor(
  w: World,
  env: Record<string, string | undefined> = baseEnv(),
  now = NOW,
) {
  const { f, calls } = fake(w);
  const out: string[] = [];
  const code = await run(
    env,
    { out: (l) => out.push(`${l}\n`) },
    { fetch: f, now: () => now },
  );
  const text = out.join("");
  // The one public line: one of the two fixed forms, nothing else.
  expect(text).toMatch(LINE);
  for (const leak of [ID, HOST, ACCT, JWT, REQ_TOKEN, R2_TOKEN, SCRIPTS_TOKEN])
    expect(text).not.toContain(leak);
  // The JWT is a header, never in a URL.
  for (const c of calls) expect(c.url).not.toContain(JWT);
  for (const c of calls) expect(c.url).not.toContain(REQ_TOKEN);
  const posted = calls
    .filter((c) => c.url === `${INV}/prodclean`)
    .map((c) => JSON.parse(c.body ?? "null"));
  return { code, line: text.trimEnd(), posted, calls };
}

const dirtyInstall = (w: World) => {
  w.installs = [
    {
      id: ID,
      appHost: HOST,
      contentHost: "c.example",
      state: "active",
      testHooks: false,
      mode: "serving",
    },
  ];
  w.healthz = { ok: true, installId: ID, testHooks: true };
};

describe("prodclean-monitor", () => {
  it("a clean, configured prod with no release or install passes and reports", async () => {
    const r = await monitor(world());
    expect(r).toMatchObject({ code: 0, line: "prod-clean: pass" });
    expect(r.posted).toEqual([{ ok: true, code: "pass" }]);
    const mint = r.calls.find((c) => c.url.startsWith(MINT));
    expect(new URL(mint?.url ?? "").searchParams.get("audience")).toBe(
      "oa-p-inventory",
    );
  });

  it("a dirty install: the code only in the line, the detail only in the report", async () => {
    const w = world();
    dirtyInstall(w);
    const r = await monitor(w);
    expect(r).toMatchObject({
      code: 1,
      line: "prod-clean: fail (install_dirty)",
    });
    expect(r.posted).toEqual([
      {
        ok: false,
        code: "install_dirty",
        installId: ID,
        detail: `prodClean ${ID}: /healthz testHooks is true`,
      },
    ]);
  });

  for (const k of [
    "INVENTORY_URL",
    "INVENTORY_OIDC_AUDIENCE",
    "REDLINE_PROD_ACCOUNT_ID",
    "REDLINE_PROD_SECRETS_DIR",
  ])
    it(`${k} missing -> not_configured, no request`, async () => {
      const r = await monitor(world(), { ...baseEnv(), [k]: "" });
      expect(r).toMatchObject({
        code: 1,
        line: "prod-clean: fail (not_configured)",
      });
      expect(r.calls).toEqual([]);
    });

  it("an inventory URL that is not a bare https origin -> not_configured", async () => {
    for (const u of ["http://inv.example", `${INV}/installs`, "nope"]) {
      const r = await monitor(world(), { ...baseEnv(), INVENTORY_URL: u });
      expect(r.line).toBe("prod-clean: fail (not_configured)");
    }
  });

  it("no token files in the secrets dir -> not_configured", async () => {
    const empty = mkdtempSync(join(tmpdir(), "oa-monitor-test-"));
    dirs.push(empty);
    const r = await monitor(world(), {
      ...baseEnv(),
      REDLINE_PROD_SECRETS_DIR: empty,
    });
    expect(r.line).toBe("prod-clean: fail (not_configured)");
  });

  it("no id-token: missing request env, a refused mint, no JWT -> oidc_unavailable, nothing posted", async () => {
    const cases: [World["mint"], Record<string, string>][] = [
      [{ value: JWT }, { ACTIONS_ID_TOKEN_REQUEST_URL: "" }],
      [{ value: JWT }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }],
      [500, {}],
      [{}, {}],
      [{ value: "not-a-jwt" }, {}],
    ];
    for (const [mint, over] of cases) {
      const r = await monitor({ ...world(), mint }, { ...baseEnv(), ...over });
      expect(r).toMatchObject({
        code: 1,
        line: "prod-clean: fail (oidc_unavailable)",
      });
      expect(r.posted).toEqual([]);
    }
  });

  it("the scheduler tick: absent fails; the window comes from SCHEDULER_STALE_MS", async () => {
    const at = (t: number | null) => ({
      ...world(),
      health: { schedulerTickAt: t },
    });
    expect((await monitor(at(null))).line).toBe(
      "prod-clean: fail (scheduler_absent)",
    );
    expect((await monitor(at(NOW - SCHEDULER_STALE_MS))).line).toBe(
      "prod-clean: pass",
    );
    const stale = await monitor(at(NOW - SCHEDULER_STALE_MS - 1));
    expect(stale.line).toBe("prod-clean: fail (scheduler_stale)");
    expect(stale.posted[0]).toMatchObject({
      ok: false,
      code: "scheduler_stale",
    });
  });

  it("an unreadable /health -> inventory_bad", async () => {
    expect((await monitor({ ...world(), health: 500 })).line).toBe(
      "prod-clean: fail (inventory_bad)",
    );
  });

  it("red-line token expiry: the window comes from REDLINE_TOKEN_WARN_MS", async () => {
    const exp = (t: number) => {
      const w = world();
      w.tokens[SCRIPTS_TOKEN] = {
        status: "active",
        expires_on: new Date(t).toISOString(),
      };
      return w;
    };
    expect((await monitor(exp(NOW + REDLINE_TOKEN_WARN_MS))).line).toBe(
      "prod-clean: pass",
    );
    expect((await monitor(exp(NOW + REDLINE_TOKEN_WARN_MS - 1))).line).toBe(
      "prod-clean: fail (redline_token_expiring)",
    );
  });

  it("an inactive or unverifiable red-line token -> redline_token_invalid", async () => {
    for (const t of [{ status: "disabled" }, 401, 500] as const) {
      const w = world();
      w.tokens[R2_TOKEN] = t;
      expect((await monitor(w)).line).toBe(
        "prod-clean: fail (redline_token_invalid)",
      );
    }
  });

  it("a dirty prod outranks a stale scheduler and an expiring token", async () => {
    const w = world();
    dirtyInstall(w);
    w.health = { schedulerTickAt: null };
    w.tokens[R2_TOKEN] = { status: "disabled" };
    expect((await monitor(w)).line).toBe("prod-clean: fail (install_dirty)");
  });

  it("an unexpected error -> error", async () => {
    const r = await monitor({ ...world(), r2Throws: true });
    expect(r.line).toBe("prod-clean: fail (error)");
    expect(r.posted[0]).toMatchObject({ ok: false, code: "error" });
  });

  it("a report inventory refuses fails even after a pass", async () => {
    for (const status of [401, 500, 200]) {
      const r = await monitor({ ...world(), report: status });
      expect(r).toMatchObject({
        code: 1,
        line: "prod-clean: fail (report_failed)",
      });
    }
  });

  it("runs under plain node: stdout is the one line, stderr is empty", () => {
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "scripts", "prodclean-monitor.ts")],
      {
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
        encoding: "utf8",
      },
    );
    expect(r.stdout).toBe("prod-clean: fail (not_configured)\n");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(1);
  });
});

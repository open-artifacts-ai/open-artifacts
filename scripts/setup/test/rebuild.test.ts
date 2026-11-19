import { describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { execReadOnly, wranglerReadOnly } from "../src/readonly.ts";
import type { Step } from "../src/step.ts";
import { ROOT, STATE } from "./fakes.ts";
import { app, HOSTS, POLICY, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const statuses = (w: W) => parsed(w).map((j) => `${j.step}:${j.status}`);
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
];
const CONFIG = `${ROOT}/apps/server/wrangler.jsonc`;
const UPGRADE = [...HOSTS, "--upgrade"];
const CHECK = [...HOSTS.filter((a) => a !== "--yes"), "--check"];

/** A cloud side that a full setup already built, with no local state file. */
const VARS = {
  ENVIRONMENT: "production",
  APP_HOST: "app.example.com",
  CONTENT_HOST: "a.b.usercontent.example.com",
  OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_CLIENT_ID: "cid-open-artifacts",
};
const cloud = (o: Parameters<typeof world>[0] = {}) =>
  world({
    d1: [{ uuid: "d1-live", name: "open-artifacts" }],
    r2: [{ name: "open-artifacts" }],
    kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
    policies: [POLICY],
    apps: [app("open-artifacts")],
    secrets: SECRETS,
    worker: VARS,
    ...o,
  });

const READ_ONLY = [
  /^whoami --json$/,
  /^auth token --json$/,
  /^secret list --name [\w-]+ --format json$/,
  /^d1 execute [\w-]+ --remote --json --command SELECT [^;]*;$/,
];
/** Fails (and records) any mutating wrangler call or non-GET API request. */
function strict(w: W) {
  const violations: string[] = [];
  const { exec, fetch } = w.deps;
  w.deps.exec = async (cmd, args, opts) => {
    if (args.includes("wrangler")) {
      const a = args.slice(args.indexOf("wrangler") + 1).join(" ");
      if (!READ_ONLY.some((re) => re.test(a))) {
        violations.push(`wrangler ${a}`);
        return { code: 1, stdout: "", stderr: "mutation refused by test" };
      }
    } else if (cmd === "pnpm" && args[0] !== "--version") {
      violations.push(`${cmd} ${args.join(" ")}`);
      return { code: 1, stdout: "", stderr: "refused" };
    }
    return exec(cmd, args, opts);
  };
  w.deps.fetch = async (input, init) => {
    const m = init?.method ?? "GET";
    if (m !== "GET") {
      violations.push(`${m} ${new URL(String(input)).pathname}`);
      return new Response("refused", { status: 599 });
    }
    return fetch(input, init);
  };
  return violations;
}

describe("--upgrade with no state rebuilds it from Cloudflare by name", () => {
  it("fills every id by lookup and creates nothing", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(w.files.has(STATE)).toBe(false);
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.creates).toEqual([]);
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.state()).toMatchObject({
      accountId: "acc1",
      d1Id: "d1-live",
      r2Bucket: "open-artifacts",
      kvId: "kv-live",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-open-artifacts",
      teamDomain: "team.cloudflareaccess.com",
    });
    expect(w.deployed()).toContain('"ACCESS_CLIENT_ID": "cid-open-artifacts"');
  });

  it("a missing resource is action_required, never created", async () => {
    const w = cloud({ kv: [] });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.creates).toEqual([]);
    expect(line(w, "resources")).toMatchObject({ status: "action_required" });
    expect(line(w, "resources").message).toContain("run a full setup first");
    expect(line(w, "resources").message).toContain("open-artifacts-oauth");
  });

  it("a missing Access app is action_required, no Access writes", async () => {
    const w = cloud({ apps: [], policies: [] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
    expect(line(w, "access")).toMatchObject({ status: "action_required" });
    expect(line(w, "access").message).toContain("run a full setup first");
  });

  it("a missing generated secret is action_required, never put", async () => {
    const w = cloud({ secrets: ["ACCESS_CLIENT_SECRET"] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
    expect(line(w, "secrets").message).toContain("run a full setup first");
  });

  it("policy drift is noted, not reconciled, under --upgrade", async () => {
    const w = cloud({ policies: [{ ...POLICY, require: [{ x: 1 }] }] });
    w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(line(w, "access").message).toContain("not reconciled");
  });
});

describe("team domain: app field, then organizations, then OA_TEAM_DOMAIN", () => {
  const orgCalls = (w: W) =>
    w.auths.filter((a) => a.includes("/access/organizations"));

  it("an app field naming <team>.cloudflareaccess.com wins, no org call", async () => {
    const withDomain = {
      ...app("open-artifacts"),
      domain: "team2.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid",
    };
    const w = cloud({
      apps: [withDomain],
      org: "forbidden",
      worker: { ...VARS, ACCESS_TEAM_DOMAIN: "team2.cloudflareaccess.com" },
    });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("team2.cloudflareaccess.com");
    expect(orgCalls(w)).toEqual([]);
  });

  it("otherwise the organizations endpoint", async () => {
    const w = cloud();
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("team.cloudflareaccess.com");
    expect(orgCalls(w).length).toBeGreaterThan(0);
  });

  it("on an organizations 403, OA_TEAM_DOMAIN", async () => {
    const w = cloud({
      org: "forbidden",
      worker: { ...VARS, ACCESS_TEAM_DOMAIN: "envteam.cloudflareaccess.com" },
    });
    w.deps.env.OA_TEAM_DOMAIN = "EnvTeam.cloudflareaccess.com";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().teamDomain).toBe("envteam.cloudflareaccess.com");
  });

  it("under --check, OA_TEAM_DOMAIN never stands in when no app is visible (an unscoped token lists none)", async () => {
    const w = cloud({ apps: [], org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "envteam.cloudflareaccess.com";
    const violations = strict(w);
    expect(await run(CHECK, w.deps, ROOT)).toBe(0);
    expect(violations).toEqual([]);
    expect(line(w, "access").status).toBe("todo");
    expect(line(w, "access").message).toContain("OA_ACCESS_TOKEN");
  });

  it("an invalid OA_TEAM_DOMAIN is an error", async () => {
    const w = cloud({ org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "not a host";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(1);
    expect(line(w, "access").message).toContain("OA_TEAM_DOMAIN");
  });

  it("every source failing is action_required naming OA_TEAM_DOMAIN", async () => {
    const w = cloud({ org: "forbidden" });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(line(w, "access")).toMatchObject({ status: "action_required" });
    expect(line(w, "access").message).toContain("OA_TEAM_DOMAIN");
    expect(w.ops).toEqual([]);
  });
});

describe("--check is read-only", () => {
  it("never calls apply", async () => {
    const apply = vi.fn(async () => undefined);
    const steps: Step[] = [
      { name: "a", check: async () => "todo", apply },
      { name: "b", check: async () => "done", apply },
    ];
    const w = world();
    expect(await run(CHECK, w.deps, ROOT, steps)).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(statuses(w)).toEqual(["a:todo", "b:done", "state:ok"]);
  });

  it("on an installed account: no mutations, no files, state in --json data", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa-secret-access-token";
    w.deps.env.CLOUDFLARE_API_TOKEN = "cf-secret-api-token";
    const violations = strict(w);
    const before = new Map(w.files);
    expect(await run(CHECK, w.deps, ROOT)).toBe(0);
    expect(violations).toEqual([]);
    expect(w.files).toEqual(before);
    expect(w.files.has(STATE)).toBe(false);
    expect(w.files.has(CONFIG)).toBe(false);
    expect(statuses(w)).toEqual([
      "prereqs:done",
      "resources:done",
      "access:done",
      "secrets:done",
      "email:done",
      "deploy:todo",
      "healthcheck:todo",
      "owner-token:todo",
      "selftest:todo",
      "agent-config:todo",
      "state:ok",
    ]);
    expect(line(w, "state").data).toEqual({
      browser: false,
      plan: "unknown",
      team: false,
      email: false,
      name: "open-artifacts",
      accountId: "acc1",
      appHost: "app.example.com",
      contentHost: "a.b.usercontent.example.com",
      ownerEmail: "owner@example.com",
      d1Id: "d1-live",
      r2Bucket: "open-artifacts",
      kvId: "kv-live",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-open-artifacts",
      teamDomain: "team.cloudflareaccess.com",
    });
    const out = w.lines.join("\n");
    for (const s of ["oa-secret-access-token", "cf-secret-api-token"])
      expect(out).not.toContain(s);
  });

  it("on an empty account: everything todo, still nothing mutated", async () => {
    const w = world({ org: "forbidden" });
    const violations = strict(w);
    expect(await run(CHECK, w.deps, ROOT)).toBe(0);
    expect(violations).toEqual([]);
    expect(w.files.has(STATE)).toBe(false);
    expect(w.creates).toEqual([]);
    expect(statuses(w).slice(1, 4)).toEqual([
      "resources:todo",
      "access:todo",
      "secrets:todo",
    ]);
    expect(line(w, "access").message).toContain("OA_ACCESS_TOKEN");
  });

  it("refuses mutating calls even if a step tried one", async () => {
    const rogue: Step = {
      name: "rogue",
      check: async (_s, ctx) => {
        await ctx.wrangler(["d1", "create", "x"]);
        return "done";
      },
      apply: async () => undefined,
    };
    const rogueApi: Step = {
      name: "rogue-api",
      check: async (_s, ctx) => {
        await ctx.accessApi("DELETE", "/accounts/acc1/access/apps/x");
        return "done";
      },
      apply: async () => undefined,
    };
    for (const step of [rogue, rogueApi]) {
      const w = world();
      expect(await run(CHECK, w.deps, ROOT, [step])).toBe(1);
      expect(w.creates).toEqual([]);
      expect(w.ops).toEqual([]);
      expect(w.lines.at(-1)).toContain("--check is read-only");
    }
  });

  it("human output marks done and todo", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    const argv = CHECK.filter((a) => a !== "--json");
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(w.lines[0]).toMatch(/^✓ prereqs: done/);
    expect(w.lines.find((l) => l.includes("deploy"))).toMatch(
      /^○ deploy: todo/,
    );
  });
});

describe("B16-5 review fixes", () => {
  const ar = (w: W, step: string) => {
    expect(line(w, step)).toMatchObject({ status: "action_required" });
    return line(w, step).message as string;
  };

  it("no state: --upgrade, --check, --yes or --json each need an explicit --name", async () => {
    const bare = HOSTS.filter(
      (a, i) => a !== "--name" && HOSTS[i - 1] !== "--name",
    );
    const base = bare.filter((a) => a !== "--yes" && a !== "--json");
    for (const flag of ["--upgrade", "--check", "--yes", "--json"]) {
      const w = cloud();
      const argv = [...base, flag, ...(flag === "--json" ? [] : ["--json"])];
      expect(await run(argv, w.deps, ROOT)).toBe(2);
      expect(ar(w, "args")).toContain("--name");
      expect(w.creates).toEqual([]);
    }
    // Saved state supplies the name.
    const w = cloud({ state: { name: "open-artifacts" } });
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run([...bare, "--upgrade"], w.deps, ROOT)).toBe(0);
  });

  it("an app lacking the callback in redirect_uris is action_required (upgrade and full)", async () => {
    const bad = app("open-artifacts");
    bad.saas_app.redirect_uris = ["https://old.example.com/auth/callback"];
    for (const argv of [UPGRADE, HOSTS]) {
      const w = cloud({ apps: [bad] });
      expect(await run(argv, w.deps, ROOT)).toBe(2);
      expect(ar(w, "access")).toContain("redirect_uris");
      expect(w.ops).toEqual([]);
    }
  });

  it("no state: live Worker vars must match the flags and rebuilt values, names only", async () => {
    const w = cloud({
      worker: {
        ...VARS,
        APP_HOST: "old.example.com",
        ACCESS_CLIENT_ID: "cid-old",
      },
    });
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    const msg = ar(w, "access");
    expect(msg).toContain("APP_HOST");
    expect(msg).toContain("ACCESS_CLIENT_ID");
    expect(msg).not.toContain("CONTENT_HOST");
    expect(msg).not.toContain("old.example.com");
    expect(msg).not.toContain("cid-old");
    expect(w.ops).toEqual([]);
    const c = cloud({ worker: { ...VARS, OWNER_EMAIL: "x@example.com" } });
    expect(await run(CHECK, c.deps, ROOT)).toBe(2);
    expect(ar(c, "access")).toContain("OWNER_EMAIL");
    // The Worker doesn't exist yet: a fresh install skips the comparison.
    const fresh = world();
    expect(await run(HOSTS, fresh.deps, ROOT)).toBe(0);
  });

  it("OA_TEAM_DOMAIN must be <team>.cloudflareaccess.com", async () => {
    const w = cloud({ org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "evil.example.com";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(1);
    expect(line(w, "access").message).toContain("OA_TEAM_DOMAIN");
    expect(w.state().teamDomain).toBeUndefined();
  });

  it("OA_TEAM_DOMAIN whose OIDC issuer differs is refused", async () => {
    const w = cloud({
      org: "forbidden",
      issuer:
        "https://evil.cloudflareaccess.com/cdn-cgi/access/sso/oidc/cid-open-artifacts",
    });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(ar(w, "access")).toContain("issuer");
    expect(w.state().teamDomain).toBeUndefined();
  });

  it("fresh install, no apps visible, verified OA_TEAM_DOMAIN: proceeds and creates", async () => {
    const w = world({ org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops).toContain("POST apps");
    expect(w.state()).toMatchObject({
      teamDomain: "team.cloudflareaccess.com",
      accessClientId: "cid-new",
    });
  });

  it("fresh install with OA_TEAM_DOMAIN: a POST 403 is action_required", async () => {
    const w = world({ org: "forbidden", appsPostForbidden: true });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(ar(w, "access")).toContain("OA_ACCESS_TOKEN");
    expect(w.apps).toEqual([]);
  });

  it("fresh install with OA_TEAM_DOMAIN: an issuer mismatch after the POST rolls back", async () => {
    const w = world({
      org: "forbidden",
      issuer: "https://evil.cloudflareaccess.com/x",
    });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).not.toBe(0);
    expect(w.apps).toEqual([]);
    expect(w.ops).toContain("DELETE apps/app-open-artifacts");
    expect(w.ops).not.toContain("put ACCESS_CLIENT_SECRET");
  });

  it("#4: fresh install without OA_TEAM_DOMAIN names Organizations Read and drops the OA_TEAM_DOMAIN alternative", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const msg = ar(w, "access");
    expect(msg).toContain("Organizations: Read");
    expect(msg).not.toContain("OA_TEAM_DOMAIN");
  });

  it("empty apps under --upgrade stays action_required even with OA_TEAM_DOMAIN", async () => {
    const w = cloud({ apps: [], org: "forbidden" });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(2);
    expect(ar(w, "access")).toContain("OA_ACCESS_TOKEN");
    expect(w.ops).toEqual([]);
  });

  it("several Access apps with the name are action_required, listing ids", async () => {
    const two = [
      app("open-artifacts"),
      { ...app("open-artifacts"), id: "app-dup" },
    ];
    for (const argv of [UPGRADE, HOSTS, CHECK]) {
      const w = cloud({ apps: two });
      expect(await run(argv, w.deps, ROOT)).toBe(2);
      const msg = ar(w, "access");
      expect(msg).toContain("app-open-artifacts");
      expect(msg).toContain("app-dup");
      expect(w.ops).toEqual([]);
    }
  });

  it("the D1 lookup pages past the first page", async () => {
    const others = Array.from({ length: 120 }, (_, i) => ({
      uuid: `o${i}`,
      name: `open-artifacts-x${i}`,
    }));
    const w = cloud({
      d1: [...others, { uuid: "d1-live", name: "open-artifacts" }],
    });
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(w.state().d1Id).toBe("d1-live");
  });

  it("--check refuses direct deps.fetch writes and deps.exec outside the allowlist", async () => {
    const steps: Step[] = [
      {
        name: "post",
        check: async (_s, ctx) => {
          await ctx.deps.fetch("https://api.cloudflare.com/client/v4/x", {
            method: "POST",
          });
          return "done";
        },
        apply: async () => undefined,
      },
      {
        name: "build",
        check: async (_s, ctx) => {
          await ctx.deps.exec("pnpm", ["--dir", ROOT, "build"]);
          return "done";
        },
        apply: async () => undefined,
      },
    ];
    for (const step of steps) {
      const w = world();
      const violations = strict(w);
      expect(await run(CHECK, w.deps, ROOT, [step])).toBe(1);
      expect(violations).toEqual([]);
      expect(w.lines.at(-1)).toContain("--check is read-only");
    }
  });

  it("the wrangler allowlist rejects bypass strings", () => {
    const d1 = (...rest: string[]) => ["d1", "execute", "db", ...rest];
    const ok = [
      ["whoami", "--json"],
      ["auth", "token", "--json"],
      ["secret", "list", "--name", "w", "--format", "json"],
      d1(
        "--remote",
        "--json",
        "--command",
        "SELECT id FROM tokens WHERE id = 'x';",
      ),
    ];
    const bad = [
      d1("--remote", "--json", "--command", "SELECT 1; DROP TABLE users;"),
      d1("--remote", "--json", "--command", "DELETE FROM tokens;"),
      d1(
        "--remote",
        "--json",
        "--command",
        " select 1; update users set role='owner'",
      ),
      d1("--json", "--command", "SELECT 1;"),
      d1("--remote", "--json", "--file", "x.sql"),
      d1("--remote", "--json", "--command", "SELECT 1;", "--file", "x.sql"),
      d1("--remote", "--json", "--command=DELETE FROM tokens"),
      d1("--remote", "--json", "--file=x.sql", "--command", "SELECT 1;"),
      d1(
        "--remote",
        "--json",
        "--command",
        "SELECT 1;",
        "--command",
        "DELETE FROM t;",
      ),
      d1(
        "--remote",
        "--json",
        "--command",
        "WITH x AS (SELECT 1) DELETE FROM t;",
      ),
      ["d1", "create", "x"],
      ["d1", "migrations", "apply", "db", "--remote"],
      ["secret", "put", "X", "--name", "w"],
      ["secret", "delete", "X", "--name", "w"],
      [
        "secret",
        "list",
        "--name",
        "w",
        "--format",
        "json",
        "--config",
        "evil.toml",
      ],
      ["deploy"],
      ["kv", "namespace", "create", "x"],
      ["whoami", "--json", "&&", "deploy"],
    ];
    for (const a of ok) expect(wranglerReadOnly(a)).toBe(true);
    for (const a of bad) expect([a, wranglerReadOnly(a)]).toEqual([a, false]);
    const w = (args: string[]) => [
      "--dir",
      "/r/apps/server",
      "exec",
      "wrangler",
      ...args,
    ];
    expect(execReadOnly("pnpm", ["--version"])).toBe(true);
    expect(execReadOnly("pnpm", w(["whoami", "--json"]))).toBe(true);
    expect(execReadOnly("pnpm", w(["deploy"]))).toBe(false);
    expect(
      execReadOnly("pnpm", [
        "--dir",
        "/r",
        "--filter",
        "@oa/server...",
        "build",
      ]),
    ).toBe(false);
    expect(execReadOnly("sh", ["-c", "wrangler whoami"])).toBe(false);
  });

  it("--strict with --check exits 2 when a step is todo", async () => {
    const step = (r: "done" | "todo"): Step => ({
      name: r,
      check: async () => r,
      apply: async () => undefined,
    });
    const strictArgv = [...CHECK, "--strict"];
    const a = world();
    expect(await run(strictArgv, a.deps, ROOT, [step("done")])).toBe(0);
    const b = world();
    expect(
      await run(strictArgv, b.deps, ROOT, [step("done"), step("todo")]),
    ).toBe(2);
    expect(parsed(b).at(-1).step).toBe("state");
    const c = world();
    expect(await run(CHECK, c.deps, ROOT, [step("todo")])).toBe(0);
    const d = world();
    expect(
      await run([...HOSTS, "--strict"], d.deps, ROOT, [step("todo")]),
    ).toBe(1);
  });

  it("--strict ignores the steps that run on every setup (deploy, selftest)", async () => {
    const w = cloud();
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run([...CHECK, "--upgrade", "--strict"], w.deps, ROOT)).toBe(
      0,
    );
    expect(line(w, "deploy").status).toBe("todo");
  });

  it("round 2: a transient discovery failure after the POST is retried, the app kept", async () => {
    const w = world({ org: "forbidden", discoveryFails: 2 });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops).not.toContain("DELETE apps/app-open-artifacts");
    expect(w.state().accessClientId).toBe("cid-new");
    expect(w.sleeps.slice(0, 2)).toEqual([1000, 2000]);
  });

  it("round 2: a persistent discovery failure rolls back and says so", async () => {
    const w = world({ org: "forbidden", discoveryFails: 99 });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(w.ops).toContain("DELETE apps/app-open-artifacts");
    expect(w.sleeps).toEqual([1000, 2000, 4000, 8000]);
    const msg = line(w, "access").message;
    expect(msg).toContain("discovery failed");
    expect(msg).toContain("HTTP 503");
    expect(msg).not.toContain("mismatch");
  });

  it("round 2: an issuer mismatch rolls back at once and says mismatch", async () => {
    const w = world({
      org: "forbidden",
      issuer: "https://evil.cloudflareaccess.com/x",
    });
    w.deps.env.OA_TEAM_DOMAIN = "team.cloudflareaccess.com";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(w.ops).toContain("DELETE apps/app-open-artifacts");
    expect(w.sleeps).toEqual([]);
    expect(line(w, "access").message).toContain("issuer mismatch");
  });

  it("round 2: --check --strict exits 2 when the Worker was never deployed", async () => {
    const STRICT = [...CHECK, "--upgrade", "--strict"];
    for (const o of [
      { secrets: undefined, worker: undefined },
      { worker: undefined },
    ]) {
      const w = cloud(o);
      w.deps.env.OA_ACCESS_TOKEN = "oa";
      const violations = strict(w);
      expect(await run(STRICT, w.deps, ROOT)).toBe(2);
      expect(violations).toEqual([]);
      expect(line(w, "deploy").status).toBe("todo");
      expect(line(w, "deploy").message).toContain("never deployed");
    }
    const ok = cloud();
    ok.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run(STRICT, ok.deps, ROOT)).toBe(0);
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../apps/server/src/util/crypto.ts";
import { isId, isPat } from "../../../packages/shared/src/ids.ts";
import { run } from "../src/index.ts";
import { deploy } from "../src/steps/deploy.ts";
import {
  demoteStatements,
  newPat,
  ownerSql,
  tokenHash,
} from "../src/steps/owner-token.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
// The final \`state\` line (every successful --json run) is not a step.
const statuses = (w: W) =>
  parsed(w)
    .filter((j) => j.step !== "state")
    .map((j) => `${j.step}:${j.status}`);
const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
];
const ALL = [
  "prereqs",
  "resources",
  "access",
  "secrets",
  "email",
  "deploy",
  "healthcheck",
  "owner-token",
  "selftest",
  "agent-config",
];
const WELCOME = readFileSync(
  join(import.meta.dirname, "../welcome.md"),
  "utf8",
);
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
/** The PAT as saved to its 0600 file (the owner-token line carries only the path). */
const patOf = (w: W): string => {
  const file = line(w, "owner-token").data.tokenFile as string;
  return (w.files.get(file) ?? "").trim();
};

/** The PAT is only in its token file: never in a line, state, other files, argv or prompts. */
function patContained(w: W, pat: string) {
  expect(isPat(pat)).toBe(true);
  const file = [...w.files.keys()].find((k) => k.endsWith("-pat-token")) ?? "";
  expect(w.secretWrites).toContain(file);
  const others = [...w.files].filter(([k]) => k !== file).map(([, v]) => v);
  const hay = [...w.lines, ...others, ...w.argv, ...w.prompts];
  expect(hay.join("\n")).not.toContain(pat);
  expect(w.sqls.join("\n")).toContain(
    createHash("sha256").update(pat).digest("hex"),
  );
}

const SIGNED = /usercontent\.example\.com\/s\/sig/;
/** The signed content URL is a bearer capability: never in any line, json or file. */
function noSignedUrl(w: W) {
  const decoded = w.lines.map((l) =>
    l.startsWith("{") ? JSON.stringify(JSON.parse(l)) : l,
  );
  for (const l of [...w.lines, ...decoded, ...w.files.values()])
    expect(l).not.toMatch(SIGNED);
}

/** A world whose cloud side is fully set up, then run once. */
async function installed() {
  const w = world();
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.lines.length = 0;
  w.ops.length = 0;
  w.hits.length = 0;
  w.mcpCalls.length = 0;
  return w;
}

/** State and config as after the access step, for running `deploy` alone. */
function deployWorld(vars: Record<string, string>, secrets = SECRETS) {
  const w = world({
    secrets,
    state: { name: "open-artifacts", accountId: "acc1" },
  });
  const cfg = {
    name: "open-artifacts",
    vars: {
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_CLIENT_ID: "cid",
      CF_ACCOUNT_ID: "acc1",
      ...vars,
    },
  };
  w.files.set(CONFIG, `// rendered\n${JSON.stringify(cfg, null, 2)}`);
  return w;
}

describe("deploy, owner-token, selftest, agent-config", () => {
  it("a first run over an empty account runs every step in order, exit 0", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(statuses(w)).toEqual([
      "prereqs:ok",
      ...ALL.slice(1).map((s) => `${s}:${s === "email" ? "skipped" : "ok"}`),
    ]);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      ...SECRETS.map((s) => `put ${s}`),
      "build",
      "migrate open-artifacts",
      "deploy",
      "d1 owner+token",
    ]);
    expect(w.hits).toEqual([
      "GET /healthz",
      "GET /cdn-cgi/access/sso/oidc/cid-new/.well-known/openid-configuration",
      "mcp initialize",
      "mcp notifications/initialized",
      "mcp tools/list",
      "mcp tools/call", // no saved id: look the Welcome page up by title first
      "mcp tools/call",
      "GET content-url",
      "GET content no auth",
      "GET content no auth",
    ]);
    expect(w.mcpCalls.map((c) => c.name)).toEqual([
      "search_artifacts",
      "publish_artifact",
    ]);
    expect(w.mcpCalls[1]).toEqual({
      name: "publish_artifact",
      arguments: {
        title: "Welcome to Open Artifacts",
        format: "markdown",
        content: WELCOME,
      },
    });
    expect(w.db.users).toEqual([
      { id: expect.any(String), email: "owner@example.com", role: "owner" },
    ]);
    const st = w.state();
    expect(st.deployedVersion).toBe("0.1.0");
    expect(st.ownerTokenId).toBe(w.db.tokens[0].id);
    expect(JSON.parse(w.deployed() ?? "").vars.ENVIRONMENT).toBe("production");
    expect(line(w, "selftest").data).toEqual({
      mcp: "ok",
      artifactId: "art1",
      content: "https://a.b.usercontent.example.com/…",
      welcomeUrl: "https://app.example.com/a/art1",
    });
    noSignedUrl(w);
    expect(st.welcomeArtifactId).toBe("art1");
    expect(isId(st.ownerTokenId)).toBe(true);
    expect(isId(w.db.users[0].id)).toBe(true);
    expect(w.argv.some((a) => a.includes("--filter @oa/server... build"))).toBe(
      true,
    );
    expect([...w.files.keys()].some((k) => k.includes("dashboard"))).toBe(
      false,
    );
    const pat = patOf(w);
    patContained(w, pat);
    const cfg = line(w, "agent-config").data;
    expect(cfg.url).toBe("https://app.example.com/mcp");
    for (const s of Object.values(cfg.snippets) as string[]) {
      expect(s).toContain("https://app.example.com/mcp");
      expect(s).not.toContain(pat);
    }
    expect(JSON.stringify(cfg)).not.toContain(pat);
    // #2: OAuth clients get only the URL; no token or header in any command.
    expect(cfg.snippets.claudeCode).toBe(
      "claude mcp add --transport http open-artifacts https://app.example.com/mcp",
    );
    expect(cfg.snippets.codex).toContain("[mcp_servers.open-artifacts]");
    expect(JSON.parse(cfg.snippets.cursor)).toEqual({
      mcpServers: { "open-artifacts": { url: "https://app.example.com/mcp" } },
    });
    expect(JSON.parse(cfg.snippets.opencode).mcp["open-artifacts"]).toEqual({
      type: "remote",
      url: "https://app.example.com/mcp",
      enabled: true,
    });
    expect(JSON.parse(cfg.snippets.json).mcpServers["open-artifacts"]).toEqual({
      type: "http",
      url: "https://app.example.com/mcp",
      headers: { Authorization: "Bearer <YOUR_TOKEN>" },
    });
  });

  it("a rerun runs deploy, healthcheck, selftest and agent-config; selftest uses the saved PAT file", async () => {
    const w = await installed();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const always = [
      "prereqs",
      "deploy",
      "healthcheck",
      "selftest",
      "agent-config",
    ];
    expect(statuses(w)).toEqual(
      ALL.map((s) => `${s}:${always.includes(s) ? "ok" : "skipped"}`),
    );
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.db.tokens).toHaveLength(1);
    expect(w.hits).toEqual([
      "GET /healthz", // the version guard (prereqs), then healthcheck's
      "GET /healthz",
      "GET /cdn-cgi/access/sso/oidc/cid-new/.well-known/openid-configuration",
      "mcp initialize",
      "mcp notifications/initialized",
      "mcp tools/list",
      "GET content-url",
      "GET content no auth",
      "GET content no auth",
    ]);
    expect(line(w, "selftest").data).toMatchObject({
      mcp: "ok",
      welcomeUrl: "https://app.example.com/a/art1",
    });
    // The Welcome text is unchanged, so it is not published again.
    expect(w.mcpCalls).toEqual([]);
    expect(line(w, "selftest").message).toContain("Welcome page unchanged");
    const cfg = line(w, "agent-config");
    expect(cfg.data.snippets.claudeCode).not.toContain("--header");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("#6: an --upgrade without the PAT file skips the MCP check with a note", async () => {
    const w = await installed();
    for (const k of [...w.files.keys()])
      if (k.endsWith("-pat-token")) w.files.delete(k);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "selftest").message).toMatch(
      /MCP check skipped.*--new-owner-token/,
    );
    expect(line(w, "selftest").data).toEqual({ mcp: "skipped" });
    expect(w.hits.some((h) => h.startsWith("mcp"))).toBe(false);
  });

  it("#6: a saved PAT rejected with 401 or 403 is action_required (exit 2) with tokenRejected", async () => {
    for (const status of [401, 403]) {
      const w = await installed();
      for (const k of w.files.keys())
        if (k.endsWith("-pat-token"))
          w.files.set(k, `oa_pat_${"1".repeat(32)}\n`);
      const real = w.deps.fetch;
      w.deps.fetch = async (u, init) =>
        String(u).endsWith("/mcp") && status === 403
          ? new Response("{}", { status: 403 })
          : real(u, init);
      expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
      const l = line(w, "selftest");
      expect(l.status).toBe("action_required");
      expect(l.message).toContain("saved agent token was rejected");
      expect(l.message).toContain("--new-owner-token");
      expect(l.data).toMatchObject({ tokenRejected: true });
      // exit 2 still prints agent-config
      expect(line(w, "agent-config")).toMatchObject({ status: "ok" });
    }
  });

  it("#6: a 5xx from MCP on a saved PAT stays an error (exit 1)", async () => {
    const w = await installed();
    const real = w.deps.fetch;
    w.deps.fetch = async (u, init) =>
      String(u).endsWith("/mcp")
        ? new Response("{}", { status: 503 })
        : real(u, init);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").status).toBe("error");
    expect(line(w, "selftest").data?.tokenRejected).toBeUndefined();
  });

  it("--ci never reads the PAT file", async () => {
    const w = world({ env: { HOME: "/home/test" } });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const file =
      [...w.files.keys()].find((k) => k.endsWith("-pat-token")) ?? "";
    const fs = w.deps.fs as unknown as { read: (p: string) => string | null };
    const real = fs.read;
    const reads: string[] = [];
    fs.read = (p) => {
      reads.push(p);
      return real(p);
    };
    const ci = [...HOSTS.filter((a) => a !== "--yes"), "--ci"];
    expect(await run(ci, w.deps, ROOT)).toBe(0);
    expect(reads).not.toContain(file);
  });

  it("#6: Welcome is published again only when its text changed", async () => {
    const w = await installed();
    const WELCOME =
      [...w.files.keys()].find((k) => k.endsWith("welcome.md")) ?? "";
    expect(w.state().welcomeHash).toMatch(/^[0-9a-f]{64}$/);
    w.files.set(WELCOME, `${w.files.get(WELCOME)}\nMore.\n`);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.mcpCalls).toHaveLength(1);
    expect(w.mcpCalls[0].arguments.id).toBe("art1");
    const hash = w.state().welcomeHash;
    w.mcpCalls.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.mcpCalls).toEqual([]);
    expect(w.state().welcomeHash).toBe(hash);
  });

  it("#6: an unchanged Welcome page that was deleted is published again", async () => {
    const w = await installed();
    w.deleted.push("art1");
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.mcpCalls.map((c) => c.arguments.id)).toEqual(["art1", undefined]);
    expect(w.state().welcomeArtifactId).toBe("art2");
  });

  it("#6: a failing health check mints nothing, and agent-config still prints the OAuth snippets", async () => {
    const w = world({ healthzDown: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "healthcheck")).toMatchObject({ status: "error" });
    expect(line(w, "owner-token")).toBeUndefined();
    expect(w.db.tokens).toHaveLength(0);
    expect(w.secretWrites).toEqual([]);
    const cfg = line(w, "agent-config");
    expect(cfg.status).toBe("ok");
    expect(cfg.data.snippets.claudeCode).toBe(
      "claude mcp add --transport http open-artifacts https://app.example.com/mcp",
    );
    expect(cfg.data.snippets).not.toHaveProperty("opencodeToken");
    expect(cfg.data.tokenNote).toMatch(/fallback snippets appear once/);
  });

  it("#21: agent-config still prints when the selftest fails, and the run exits 1", async () => {
    const w = world({ noPublishTool: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest")).toMatchObject({ status: "error" });
    const cfg = line(w, "agent-config");
    expect(cfg).toMatchObject({ status: "ok" });
    expect(cfg.data.url).toBe("https://app.example.com/mcp");
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("--new-owner-token mints another; a revoked token is re-minted", async () => {
    const w = await installed();
    const first = w.state().ownerTokenId;
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(0);
    expect(w.db.tokens).toHaveLength(2);
    expect(w.state().ownerTokenId).not.toBe(first);
    expect(w.db.tokens[0]).toMatchObject({
      id: first,
      revoked_at: expect.any(Number),
    });
    expect(w.db.tokens[1].revoked_at).toBeUndefined();
    expect(w.sqls.at(-2)).toMatch(
      /UPDATE tokens SET revoked_at = \d+ WHERE user_id/,
    );
    // M5: the unchanged welcome artifact is neither duplicated nor published again.
    expect(w.mcpCalls).toEqual([]);
    expect(w.state().welcomeArtifactId).toBe("art1");
    patContained(w, patOf(w));
    w.lines.length = 0;
    w.db.tokens[1].revoked_at = 1;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(line(w, "owner-token").status).toBe("ok");
    expect(w.db.tokens).toHaveLength(3);
  });

  it("--upgrade runs only the always-steps; --new-owner-token adds a token", async () => {
    const w = await installed();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(statuses(w)).toEqual(
      ALL.map(
        (s) =>
          `${s}:${["prereqs", "deploy", "healthcheck", "selftest", "agent-config"].includes(s) ? "ok" : "skipped"}`,
      ),
    );
    expect(w.ops).toEqual(["build", "migrate open-artifacts", "deploy"]);
    expect(w.sqls).toHaveLength(3); // the first run's mint, revoke and demote commands only
    w.lines.length = 0;
    const argv = [...HOSTS, "--upgrade", "--new-owner-token"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(statuses(w).slice(5)).toEqual([
      "deploy:ok",
      "healthcheck:ok",
      "owner-token:ok",
      "selftest:ok",
      "agent-config:ok",
    ]);
  });

  it("refuses a dev config before building or deploying", async () => {
    const w = deployWorld({ ENVIRONMENT: "dev" });
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
    expect(line(w, "deploy")).toMatchObject({ status: "error" });
    expect(line(w, "deploy").message).toMatch(/refusing.*ENVIRONMENT.*dev/);
    expect(w.ops).toEqual([]);
  });

  it("refuses empty ACCESS_TEAM_DOMAIN or ACCESS_CLIENT_ID", async () => {
    for (const k of ["ACCESS_TEAM_DOMAIN", "ACCESS_CLIENT_ID"]) {
      const w = deployWorld({ [k]: "" });
      expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
      expect(line(w, "deploy").message).toMatch(new RegExp(`refusing.*${k}`));
      expect(w.ops).toEqual([]);
    }
  });

  it("refuses when a required Worker secret is missing", async () => {
    const w = deployWorld({}, SECRETS.slice(0, 2));
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(1);
    expect(line(w, "deploy").message).toContain("CONTENT_SIGNING_KEY");
    expect(w.ops).toEqual([]);
  });

  it("deletes a secret that shadows a rendered var before deploying, names only", async () => {
    const w = deployWorld({}, [...SECRETS, "CF_ACCOUNT_ID", "ANALYTICS_TOKEN"]);
    expect(await run(HOSTS, w.deps, ROOT, [deploy])).toBe(0);
    expect(w.ops).toEqual([
      "build",
      "delete secret CF_ACCOUNT_ID",
      "migrate open-artifacts",
      "deploy",
    ]);
    expect(line(w, "deploy").message).toContain("CF_ACCOUNT_ID");
    expect(w.state().deployedVersion).toBe("0.1.0");
  });

  it("selftest follows the markdown render shell to its entry file", async () => {
    const w = world({});
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(line(w, "selftest").status).toBe("ok");
  });

  it("selftest fails when the render shell's entry lacks the welcome text", async () => {
    const w = world({ entryBody: "# Something else" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").message).toMatch(
      /content.*Welcome to Open Artifacts/,
    );
    noSignedUrl(w);
  });

  it("selftest fetches the signed content URL and checks the welcome text", async () => {
    const w = world({ contentBody: "<html>an SPA shell</html>" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").message).toMatch(
      /content.*Welcome to Open Artifacts/,
    );
    expect(line(w, "selftest").message).toContain(
      "https://a.b.usercontent.example.com/…",
    );
    noSignedUrl(w);
    const denied = world({ contentStatus: 403 });
    expect(await run(HOSTS, denied.deps, ROOT)).toBe(1);
    expect(line(denied, "selftest").message).toMatch(/HTTP 403/);
    noSignedUrl(denied);
  });

  it("owner-token restores state when the command fails, and fails clearly when the row is missing", async () => {
    const down = world({ d1Fails: true });
    expect(await run(HOSTS, down.deps, ROOT)).toBe(2);
    expect(line(down, "owner-token").status).toBe("action_required");
    expect(down.state().ownerTokenId).toBeUndefined();
    const lost = world({ dropTokenInsert: true });
    expect(await run(HOSTS, lost.deps, ROOT)).toBe(1);
    expect(line(lost, "owner-token").message).toMatch(/token row .* missing/);
    expect(lost.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("normalises the owner email (trim, lowercase, ASCII) for state and SQL", async () => {
    const argv = HOSTS.map((a) =>
      a === "owner@example.com" ? "  Owner@Example.COM " : a,
    );
    const w = world();
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(w.state().ownerEmail).toBe("owner@example.com");
    expect(w.sqls.at(-1)).toContain("'owner@example.com'");
    const bad = world();
    const nonAscii = HOSTS.map((a) =>
      a === "owner@example.com" ? "o\u212a@example.com" : a,
    );
    expect(await run(nonAscii, bad.deps, ROOT)).toBe(1);
    expect(line(bad, "args").message).toContain("--owner-email");
  });

  it("a deleted welcome artifact is republished fresh; other publish errors fail", async () => {
    const w = await installed();
    expect(w.state().welcomeArtifactId).toBe("art1");
    w.deleted.push("art1");
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(0);
    expect(w.mcpCalls.map((c) => c.arguments.id)).toEqual(["art1", undefined]);
    expect(w.state().welcomeArtifactId).toBe("art2");
    expect(line(w, "selftest").data).toMatchObject({
      mcp: "ok",
      artifactId: "art2",
    });
    const bad = world({ publishError: "forbidden: nope" });
    expect(await run(HOSTS, bad.deps, ROOT)).toBe(1);
    expect(line(bad, "selftest").message).toContain("forbidden: nope");
  });

  it("selftest retries propagation with bounded backoff", async () => {
    const w = world({ healthFails: 3 });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.sleeps).toEqual([1000, 2000, 4000]);
    const down = world({ healthFails: 1000 });
    expect(await run(HOSTS, down.deps, ROOT)).toBe(1);
    expect(line(down, "healthcheck").message).toContain("/healthz");
    const total = down.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(55_000);
    expect(total).toBeLessThanOrEqual(65_000);
    expect(down.db.tokens).toHaveLength(0); // #6: nothing minted before the health check passes
  });

  it("selftest errors when tools/list lacks publish_artifact", async () => {
    const w = world({ noPublishTool: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "selftest").message).toContain("publish_artifact");
    expect(w.mcpCalls).toEqual([]);
  });

  it("human output names the token file in owner-token, never the token, plus agent-config snippets", async () => {
    const w = world();
    const human = HOSTS.filter((a) => a !== "--json");
    expect(await run(human, w.deps, ROOT)).toBe(0);
    const tokenId = JSON.parse(w.files.get(STATE) ?? "").ownerTokenId;
    const own = w.lines.find((l) => l.startsWith("✓ owner-token")) ?? "";
    expect(own).not.toMatch(/oa_pat_/);
    const file =
      [...w.files.keys()].find((k) => k.endsWith("-pat-token")) ?? "";
    const pat = (w.files.get(file) ?? "").trim();
    expect(own).toContain(tokenId);
    expect(own).toContain("-pat-token");
    const cfg = w.lines.find((l) => l.startsWith("✓ agent-config")) ?? "";
    expect(cfg).toContain("claude mcp add --transport http");
    expect(cfg).toContain("claude mcp add --transport http");
    expect(cfg).toContain(`${file}`);
    expect(cfg).not.toMatch(/--header|Bearer \$\(cat/);
    expect(cfg).not.toContain(pat);
    expect(cfg).toContain("bearer_token_env_var");
    patContained(w, pat);
  });

  it("every --json line parses, across first run, rerun and upgrade", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    await run(HOSTS, w.deps, ROOT);
    await run([...HOSTS, "--upgrade", "--new-owner-token"], w.deps, ROOT);
    expect(w.lines.length).toBe(33); // + a final state line per run
    for (const l of w.lines)
      expect(Object.keys(JSON.parse(l))).toEqual(
        expect.arrayContaining(["step", "status", "message"]),
      );
  });

  it("the local PAT matches @oa/shared's format; SQL escapes and carries only the hash", async () => {
    for (let i = 0; i < 50; i++) {
      const pat = newPat();
      expect(isPat(pat)).toBe(true);
      expect(tokenHash(pat)).toBe(await sha256Hex(pat));
    }
    const sql = ownerSql("o'brien@example.com", "tid", "ab".repeat(32), 1);
    expect(sql).toContain("'o''brien@example.com'");
    expect(sql).not.toMatch(/oa_pat_/);
    expect(sql).toContain(
      "ON CONFLICT(email) DO UPDATE SET role = 'owner' WHERE users.status = 'active'",
    );
  });
});

describe("B16-6 owner token hardening", () => {
  const seeded = (over: Record<string, unknown> = {}) =>
    world({
      seed: {
        users: [{ id: "u1", email: "owner@example.com", role: "owner" }],
        tokens: [
          { id: "old1", user_id: "u1", label: "setup", token_hash: "h1" },
          { id: "old2", user_id: "u1", label: "setup", token_hash: "h2" },
          { id: "keep", user_id: "u1", label: "laptop", token_hash: "h3" },
          {
            id: "gone",
            user_id: "u1",
            label: "setup",
            token_hash: "h4",
            revoked_at: 5,
          },
        ],
      },
      ...over,
    });
  const live = (w: W) =>
    w.db.tokens.filter((t) => !t.revoked_at).map((t) => t.id);

  it("a re-mint with lost state revokes prior setup tokens (and only those)", async () => {
    const w = seeded();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(live(w)).toEqual(["keep", w.state().ownerTokenId]);
    expect(w.db.tokens.find((t) => t.id === "gone").revoked_at).toBe(5);
  });

  it("--new-owner-token revokes prior setup tokens too", async () => {
    const w = await installed();
    w.db.tokens.push({
      id: "x",
      user_id: w.db.users[0].id,
      label: "setup",
      token_hash: "hx",
    });
    expect(await run([...HOSTS, "--new-owner-token"], w.deps, ROOT)).toBe(0);
    expect(live(w)).toEqual([w.state().ownerTokenId]);
  });

  const capped = (extra: Record<string, unknown> = {}) =>
    world({
      seed: {
        users: [
          { id: "u1", email: "owner@example.com", role: "member" },
          { id: "u0", email: "old@example.com", role: "owner" },
        ],
        tokens: [
          { id: "old1", user_id: "u1", label: "setup", token_hash: "h1" },
          ...Array.from({ length: 49 }, (_, i) => ({
            id: `t${i}`,
            user_id: "u1",
            label: "api",
            token_hash: `h${i}`,
          })),
        ],
      },
      ...extra,
    });
  const role = (w: W, id: string) => w.db.users.find((u) => u.id === id)?.role;

  it("a cap hit is action_required, revokes nobody and demotes nobody", async () => {
    const w = capped();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "owner-token")).toMatchObject({
      status: "action_required",
      message: expect.stringMatching(
        /50 active tokens.*Settings.*old setup token still counts toward the cap; revoke it in Settings/,
      ),
    });
    expect(live(w)).toHaveLength(50);
    expect(live(w)).toContain("old1");
    expect(role(w, "u0")).toBe("owner");
    expect(w.sqls).toHaveLength(1);
    expect(w.state().ownerTokenId).toBeUndefined();
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
  });

  it("a failed insert leaves old tokens live and the old owner in place", async () => {
    const w = seeded({ d1Fails: true });
    w.db.users.push({ id: "u0", email: "old@example.com", role: "owner" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(live(w)).toEqual(expect.arrayContaining(["old1", "old2", "keep"]));
    expect(role(w, "u0")).toBe("owner");
    expect(w.sqls).toHaveLength(1);
    expect(line(w, "owner-token").message).toContain(
      "owner token state uncertain; rerun with --new-owner-token",
    );
  });

  it("a short result is uncertain: state restored, action_required", async () => {
    const w = seeded({ shortResult: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "owner-token")).toMatchObject({
      status: "action_required",
      message: expect.stringContaining("owner token state uncertain"),
    });
    expect(w.state().ownerTokenId).toBeUndefined();
    expect(w.lines.join("\n")).not.toMatch(/oa_pat_/);
    expect(w.sqls).toHaveLength(1);
  });

  it("#22: a revoke failure after the file is saved is action_required, keeps file and state, and still demotes", async () => {
    const w = seeded({ failOn: /^UPDATE tokens SET revoked_at/ });
    w.db.users.push({ id: "u0", email: "old@example.com", role: "owner" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "owner-token");
    expect(l.status).toBe("action_required");
    expect(l.message).toMatch(
      /the new token is saved to \/.*pat-token, but the old token couldn't be revoked; rerun setup, or revoke it in the dashboard \(Settings → Agents\)/,
    );
    expect(w.state().ownerTokenId).toBeTruthy();
    expect(w.state().pendingRevokeTokenId).toBe(w.state().ownerTokenId);
    expect(w.secretWrites).toHaveLength(1);
    expect(role(w, "u0")).toBe("admin");
  });

  it("reports the revoked count only when above zero", async () => {
    const w = seeded();
    await run(HOSTS, w.deps, ROOT);
    expect(line(w, "owner-token").message).toContain(
      "revoked 2 prior setup tokens",
    );
    const fresh = world();
    await run(HOSTS, fresh.deps, ROOT);
    expect(line(fresh, "owner-token").message).not.toMatch(/revoked \d+ prior/);
  });

  it("an owner change demotes the previous owner to admin and says so", async () => {
    const w = world({
      seed: { users: [{ id: "u0", email: "old@example.com", role: "owner" }] },
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.db.users.find((u) => u.id === "u0")?.role).toBe("admin");
    expect(w.db.users.find((u) => u.email === "owner@example.com")?.role).toBe(
      "owner",
    );
    expect(line(w, "owner-token").message).toContain(
      "demoted 1 previous owner to admin",
    );
    // A count, not the email: CI logs may be public.
    expect(line(w, "owner-token").message).not.toContain("old@example.com");
  });

  for (const status of ["suspended", "removed"])
    it(`refuses a ${status} new owner: no demote, no token, the old owner stays`, async () => {
      const w = world({
        seed: {
          users: [
            { id: "u0", email: "old@example.com", role: "owner" },
            { id: "u1", email: "owner@example.com", role: "member", status },
          ],
        },
      });
      expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
      const l = line(w, "owner-token");
      expect(l.message).toContain(
        `setup won't make a ${status} user the owner: nothing was changed`,
      );
      expect(l.message).not.toContain("owner@example.com");
      expect(role(w, "u0")).toBe("owner");
      expect(role(w, "u1")).toBe("member");
      expect(w.db.tokens).toHaveLength(0);
      expect(w.sqls.join("; ")).not.toContain("SET role = 'admin'");
      expect(w.state().ownerTokenId).toBeUndefined();
      expect(w.secretWrites).toHaveLength(0);
    });

  it("the demote only runs once the target is an active owner", () => {
    const [sel, upd] = demoteStatements("o@example.com");
    const guard =
      "EXISTS (SELECT 1 FROM users WHERE email = 'o@example.com' AND role = 'owner' AND status = 'active')";
    expect(sel).toContain(guard);
    expect(upd).toContain(guard);
  });

  it("the same owner is not demoted", async () => {
    const w = seeded();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.db.users.map((u) => u.role)).toEqual(["owner"]);
    expect(line(w, "owner-token").message).not.toMatch(/demoted/);
  });

  it("sends the mint command (upsert, capped insert, verify), then revoke and demote after the file is saved", async () => {
    const w = seeded();
    await run(HOSTS, w.deps, ROOT);
    expect(w.sqls).toHaveLength(3);
    expect(w.sqls[0]).not.toContain("SET role = 'admin'");
    const all = w.sqls.join("; ");
    const at = (re: RegExp) => all.search(re);
    const order = [
      /ON CONFLICT\(email\)/,
      /\) < 50/,
      /SELECT id FROM tokens WHERE id/,
      /SET revoked_at/,
      /SET role = 'admin'/,
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

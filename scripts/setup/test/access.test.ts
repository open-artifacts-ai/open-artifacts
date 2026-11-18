import { describe, expect, it, vi } from "vitest";
import { realDeps } from "../src/cf.ts";
import { run, STEPS } from "../src/index.ts";
import type { Ctx, Step } from "../src/step.ts";
import { ROOT } from "./fakes.ts";
import { app, HOSTS, POLICY, STAGING, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
// The final \`state\` line (every successful --json run) is not a step.
const statuses = (w: W) =>
  parsed(w)
    .filter((j) => j.step !== "state")
    .map((j) => `${j.step}:${j.status}`);
/** Prompts need a TTY-style run: neither --yes nor --json. */
const interactive = HOSTS.filter((a) => a !== "--yes" && a !== "--json");
const SECRETS = [
  "ACCESS_CLIENT_SECRET",
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
];
const CONFIG = `${ROOT}/apps/server/wrangler.jsonc`;
/** The B16-2 scope: prereqs, resources, access, secrets. */
const B16_2 = STEPS.slice(0, 4);

/** Every secret value the fake saw must be absent from output, json, state and files. */
function noLeak(w: W, extra: string[] = []) {
  const decoded = w.lines.map((l) => {
    if (!l.startsWith("{")) return l;
    const j = JSON.parse(l);
    return `${j.message} ${JSON.stringify(j.data ?? "")}`;
  });
  const haystack = [
    ...w.lines,
    ...decoded,
    ...w.prompts,
    ...w.files.values(),
  ].join("\n");
  for (const v of [...w.values, ...extra]) {
    expect(v.length).toBeGreaterThan(0);
    expect(haystack).not.toContain(v);
    expect(haystack).not.toContain(JSON.stringify(v).slice(1, -1));
  }
}

describe("access + secrets", () => {
  it("first run creates everything in order and fills the config", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      ...SECRETS.map((s) => `put ${s}`),
    ]);
    expect(statuses(w)).toEqual([
      "prereqs:ok",
      "resources:ok",
      "access:ok",
      "secrets:ok",
    ]);
    expect(w.apps[0]).toMatchObject({
      name: "open-artifacts",
      policies: [{ id: "pol1" }],
    });
    expect(w.apps[0].saas_app).toMatchObject({
      auth_type: "oidc",
      redirect_uris: ["https://app.example.com/auth/callback"],
      grant_types: ["authorization_code_with_pkce"],
      allow_pkce_without_client_secret: false,
      scopes: ["openid", "email", "profile"],
    });
    expect(w.state()).toMatchObject({
      teamDomain: "team.cloudflareaccess.com",
      accessAppId: "app-open-artifacts",
      accessClientId: "cid-new",
    });
    const vars = JSON.parse(w.files.get(CONFIG) ?? "").vars;
    expect(vars).toMatchObject({
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_CLIENT_ID: "cid-new",
    });
    // SESSION_SECRET, CONTENT_SIGNING_KEY and the 32-byte VAPID private scalar.
    expect(w.values.filter((v) => /^[A-Za-z0-9_-]{43}$/.test(v))).toHaveLength(
      3,
    );
    noLeak(w);
  });

  it("a rerun is all skipped; --upgrade skips even with policy drift", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT, B16_2);
    w.lines.length = 0;
    w.ops.length = 0;
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(
      statuses(w).every((s) => s.endsWith(":skipped") || s === "prereqs:ok"),
    ).toBe(true);
    w.policies[0].include = [{ email: { email: "x@example.com" } }];
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT, B16_2)).toBe(0);
    expect(
      statuses(w).every((s) => s.endsWith(":skipped") || s === "prereqs:ok"),
    ).toBe(true);
    expect(w.ops).toEqual([]);
  });

  it("a 403 on organizations is action_required with the token link, exit 2", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const last = parsed(w).at(-1);
    expect(last).toMatchObject({ step: "access", status: "action_required" });
    expect(last.data.url).toContain(
      "https://dash.cloudflare.com/profile/api-tokens?",
    );
    expect(w.ops).toEqual([]);
  });

  it("prompts for OA_ACCESS_TOKEN without echo and keeps it in memory only", async () => {
    const w = world({ org: "forbidden", answers: ["USER-TOKEN-abc", ""] });
    expect(await run(interactive, w.deps, ROOT)).toBe(0);
    expect(w.prompts[0]).toMatch(/^\[secret\] .*OA_ACCESS_TOKEN/);
    expect(w.ops).toContain("POST apps");
    noLeak(w, ["USER-TOKEN-abc"]);
  });

  it("rolls the app back when the client-secret put fails", async () => {
    const w = world({ putFails: "ACCESS_CLIENT_SECRET" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(w.ops).toEqual([
      "POST policies",
      "POST apps",
      "DELETE apps/app-open-artifacts",
    ]);
    expect(w.apps).toEqual([]);
    expect(parsed(w).at(-1)).toMatchObject({ step: "access", status: "error" });
    noLeak(w);
  });

  it("a failed rollback logs both error names and rethrows the original", async () => {
    const w = world({ putFails: "ACCESS_CLIENT_SECRET", deleteFails: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    const last = parsed(w).at(-1);
    expect(last.message).toContain("secret put ACCESS_CLIENT_SECRET failed");
    expect(last.message).toContain("rollback");
    noLeak(w);
  });

  it("an existing app without the Worker secret is action_required", async () => {
    const w = world({
      policies: [POLICY],
      apps: [app("open-artifacts")],
      secrets: [],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1)).toMatchObject({
      step: "access",
      status: "action_required",
    });
    expect(parsed(w).at(-1).message).toMatch(/delete the Access app/i);
    expect(w.ops).toEqual([]);
  });

  it("an existing app without the policy is action_required, never PUT", async () => {
    const w = world({
      policies: [POLICY],
      apps: [app("open-artifacts", [])],
      secrets: SECRETS,
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain("Open Artifacts – everyone");
    expect(w.ops).toEqual([]);
  });

  it("no organization is action_required with the Zero Trust link", async () => {
    const w = world({ org: "none" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain(
      "https://one.dash.cloudflare.com/",
    );
  });

  it("reconciles policy drift in place, keeping session_duration", async () => {
    const drifted = {
      ...POLICY,
      include: [{ email: { email: "x@example.com" } }],
      session_duration: "24h",
    };
    const w = world({ policies: [drifted] });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops[0]).toBe("PUT policies/pol1");
    expect(w.policies[0]).toMatchObject({
      include: [{ everyone: {} }],
      session_duration: "24h",
    });
  });

  it("adopts staging: app, policy and all four secrets present → skipped", async () => {
    const secrets = [...SECRETS, "CF_ACCOUNT_ID"];
    const w = world({
      ...STAGING,
      policies: [POLICY],
      apps: [app("open-artifacts-staging")],
      secrets,
    });
    expect(
      await run(
        [...HOSTS, "--name", "open-artifacts-staging"],
        w.deps,
        ROOT,
        B16_2,
      ),
    ).toBe(0);
    expect(statuses(w)).toEqual([
      "prereqs:ok",
      "resources:skipped",
      "access:skipped",
      "secrets:skipped",
    ]);
    expect(w.ops).toEqual([]);
    expect(w.state()).toMatchObject({
      accessClientId: "cid-open-artifacts-staging",
    });
  });

  it("ANALYTICS_TOKEN is prompted interactively and optional", async () => {
    const w = world({ answers: ["ANALYTICS-val"] });
    expect(await run(interactive, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops.at(-1)).toBe("put ANALYTICS_TOKEN");
    noLeak(w);
  });

  it("the ANALYTICS_TOKEN prompt carries the read-only token link", async () => {
    const w = world({ answers: [""] });
    expect(await run(interactive, w.deps, ROOT, B16_2)).toBe(0);
    const q = w.prompts.find((p) => p.includes("ANALYTICS_TOKEN")) ?? "";
    expect(q).toContain("Enter to skip");
    expect(q).toContain(
      `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent('[{"key":"account_analytics","type":"read"}]')}`,
    );
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });

  const ANALYTICS = "analytics-ENV-value";
  it("env ANALYTICS_TOKEN is put via stdin under --json, no prompt", async () => {
    const w = world();
    w.deps.env.ANALYTICS_TOKEN = ANALYTICS;
    w.deps.env.CLOUDFLARE_API_TOKEN = "cf-wrangler-token";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.prompts).toEqual([]);
    expect(w.ops).toContain("put ANALYTICS_TOKEN");
    expect(w.values).toContain(ANALYTICS);
    expect(w.values).not.toContain("cf-wrangler-token");
    expect(w.argv.join("\n")).not.toContain(` ${ANALYTICS}`);
    noLeak(w);
  });

  it("env ANALYTICS_TOKEN is put again on --upgrade (rotation)", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT, B16_2);
    w.deps.env.ANALYTICS_TOKEN = ANALYTICS;
    await run(HOSTS, w.deps, ROOT, B16_2);
    w.ops.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).toEqual(["put ANALYTICS_TOKEN"]);
    noLeak(w);
  });

  it("CLOUDFLARE_API_TOKEN is never stored as ANALYTICS_TOKEN", async () => {
    const w = world();
    w.deps.env.CLOUDFLARE_API_TOKEN = "cf-wrangler-token";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });

  it("refuses an ANALYTICS_TOKEN equal to CLOUDFLARE_API_TOKEN, with a link", async () => {
    const w = world();
    w.deps.env.CLOUDFLARE_API_TOKEN = w.deps.env.ANALYTICS_TOKEN = "same";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
    const msg = parsed(w).find((j) => j.step === "secrets")?.message ?? "";
    expect(msg).toContain("is the deploy token");
    expect(msg).toContain(
      encodeURIComponent('[{"key":"account_analytics","type":"read"}]'),
    );
  });

  it("refuses an ANALYTICS_TOKEN that verifies to the deploy token's id", async () => {
    const w = world({ tokenIds: { dep: "tok1", "dep ": "tok1", an: "tok1" } });
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    w.deps.env.ANALYTICS_TOKEN = "an";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });

  it("a dedicated ANALYTICS_TOKEN (different id) is put", async () => {
    const w = world();
    w.deps.env.CLOUDFLARE_API_TOKEN = "dep";
    w.deps.env.ANALYTICS_TOKEN = "an";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).toContain("put ANALYTICS_TOKEN");
  });

  it("--check --strict is clean when the exported ANALYTICS_TOKEN is already set", async () => {
    const w = world();
    w.deps.env.ANALYTICS_TOKEN = ANALYTICS;
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    w.lines.length = 0;
    expect(
      await run([...HOSTS, "--check", "--strict"], w.deps, ROOT, B16_2),
    ).toBe(0);
    expect(parsed(w).find((j) => j.step === "secrets")?.status).toBe("done");
  });

  it("--check reports todo when the exported ANALYTICS_TOKEN is absent on the Worker", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    w.deps.env.ANALYTICS_TOKEN = ANALYTICS;
    w.lines.length = 0;
    expect(
      await run([...HOSTS, "--check", "--strict"], w.deps, ROOT, B16_2),
    ).toBe(2);
  });

  it("an empty env ANALYTICS_TOKEN counts as unset", async () => {
    const w = world();
    w.deps.env.ANALYTICS_TOKEN = "";
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });
});

describe("B16-2 review fixes", () => {
  const probe: Step = {
    name: "probe",
    check: async (_s, ctx) => {
      await ctx.api("GET", "/zones?name=probe");
      return "done";
    },
    apply: async () => undefined,
  };
  const bearer = (w: W, path: string) =>
    w.auths.filter((a) => a.startsWith(path)).map((a) => a.split(" ").at(-1));

  it("Access calls use OA_ACCESS_TOKEN; ctx.api keeps the wrangler token", async () => {
    const w = world({ org: "forbidden" });
    w.deps.env.OA_ACCESS_TOKEN = "oa-tok";
    expect(await run(HOSTS, w.deps, ROOT, [...STEPS, probe])).toBe(0);
    expect(new Set(bearer(w, "/accounts/acc1/access"))).toEqual(
      new Set(["oa-tok"]),
    );
    expect(bearer(w, "/zones")).toContain("t");
    expect(bearer(w, "/zones").at(-1)).toBe("t");
  });

  it("a pasted token stays on the Access client only", async () => {
    const w = world({ org: "forbidden", answers: ["USER-TOKEN-abc", ""] });
    expect(await run(interactive, w.deps, ROOT, [...STEPS, probe])).toBe(0);
    expect(bearer(w, "/zones").at(-1)).toBe("t");
  });

  it("#4: the fresh-install 403 message gives the token link and the save line", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain("--token-links --json");
  });

  it("the wrangler child env drops OA_ACCESS_TOKEN and WRANGLER_LOG*", async () => {
    process.env.OA_ACCESS_TOKEN = "oa-secret";
    process.env.WRANGLER_LOG = "debug";
    process.env.ANALYTICS_TOKEN = "an-secret";
    try {
      const { stdout } = await realDeps().exec("env", [], { env: { X: "1" } });
      expect(stdout).toContain("X=1");
      expect(stdout).not.toContain("OA_ACCESS_TOKEN");
      expect(stdout).not.toContain("WRANGLER_LOG");
      expect(stdout).not.toContain("ANALYTICS_TOKEN");
    } finally {
      delete process.env.OA_ACCESS_TOKEN;
      delete process.env.WRANGLER_LOG;
      delete process.env.ANALYTICS_TOKEN;
    }
  });

  it("SIGINT between POST and put rolls back, then exits 130", async () => {
    const before = process.listenerCount("SIGINT");
    const w = world();
    const exec = w.deps.exec;
    w.deps.exec = async (cmd, args, o) => {
      if (args.includes("put")) process.emit("SIGINT");
      return exec(cmd, args, o);
    };
    expect(await run(HOSTS, w.deps, ROOT)).toBe(130);
    expect(w.ops).toContain("DELETE apps/app-open-artifacts");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("records pendingAccessAppId after the POST and clears it after recording", async () => {
    const w = world({ putFails: "ACCESS_CLIENT_SECRET", deleteFails: true });
    await run(HOSTS, w.deps, ROOT);
    expect(w.state().pendingAccessAppId).toBe("app-open-artifacts");
    const ok = world();
    await run(HOSTS, ok.deps, ROOT);
    expect(ok.state().pendingAccessAppId).toBeUndefined();
  });

  it("a pending app lacking the Worker secret is deleted and recreated", async () => {
    const w = world({
      policies: [POLICY],
      apps: [app("open-artifacts")],
      secrets: [],
      state: { pendingAccessAppId: "app-open-artifacts" },
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(w.ops.slice(0, 3)).toEqual([
      "DELETE apps/app-open-artifacts",
      "POST apps",
      "put ACCESS_CLIENT_SECRET",
    ]);
    expect(w.state().pendingAccessAppId).toBeUndefined();
  });

  it("never puts CF_ACCOUNT_ID as a secret", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    expect(w.ops.join()).not.toContain("CF_ACCOUNT_ID");
  });

  it("a 404 from organizations is the Zero Trust action_required", async () => {
    const w = world({ org: "404" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toContain(
      "https://one.dash.cloudflare.com/",
    );
  });

  it("failed put errors carry no secret, raw or JSON-escaped", async () => {
    const tricky = 'an"al\\ytics';
    const w = world({ answers: [tricky], putFails: "ANALYTICS_TOKEN" });
    expect(await run(interactive, w.deps, ROOT)).toBe(1);
    expect(w.lines.at(-1)).toContain("secret put ANALYTICS_TOKEN failed");
    noLeak(w, [tricky]);
  });

  it("an auth token failure never echoes wrangler stdout", async () => {
    const w = world();
    const exec = w.deps.exec;
    w.deps.exec = async (cmd, args, o) =>
      args.includes("auth")
        ? { code: 1, stdout: '{"token":"LEAKED"}', stderr: "" }
        : exec(cmd, args, o);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(w.lines.join("\n")).not.toContain("LEAKED");
  });

  it("does not touch the policy when an existing app needs action", async () => {
    const drifted = {
      ...POLICY,
      include: [{ email: { email: "x@example.com" } }],
    };
    const w = world({
      policies: [drifted],
      apps: [app("open-artifacts")],
      secrets: [],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
  });

  it("an existing non-SaaS-OIDC app is action_required", async () => {
    const w = world({
      policies: [POLICY],
      apps: [{ ...app("open-artifacts"), type: "self_hosted" }],
      secrets: SECRETS,
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(parsed(w).at(-1).message).toMatch(/SaaS OIDC/);
  });

  it("an app whose redirect_uris lack the app host callback is action_required", async () => {
    const odd = app("open-artifacts");
    odd.saas_app.redirect_uris = [
      "https://elsewhere.example.com/auth/callback",
    ];
    const w = world({ policies: [POLICY], apps: [odd], secrets: SECRETS });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const line = parsed(w).find((j) => j.step === "access");
    expect(line.status).toBe("action_required");
    expect(line.message).toContain("https://app.example.com/auth/callback");
  });

  it("--upgrade notes that access was verified from state only", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    w.lines.length = 0;
    await run([...HOSTS, "--upgrade"], w.deps, ROOT);
    expect(parsed(w).find((j) => j.step === "access").message).toMatch(
      /state only/,
    );
  });

  it("pages until a short page when result_info is absent", async () => {
    const filler = Array.from({ length: 150 }, (_, i) => app(`other-${i}`));
    const w = world({
      policies: [POLICY],
      apps: [...filler, app("open-artifacts")],
      secrets: SECRETS,
      noResultInfo: true,
    });
    expect(await run(HOSTS, w.deps, ROOT, B16_2)).toBe(0);
    expect(w.ops).toEqual([]);
  });

  it("a second SIGINT exits 130 at once with a names-only orphan warning", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const err = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const w = world();
      const exec = w.deps.exec;
      w.deps.exec = async (cmd, args, o) => {
        if (args.includes("put")) {
          process.emit("SIGINT");
          process.emit("SIGINT");
        }
        return exec(cmd, args, o);
      };
      await run(HOSTS, w.deps, ROOT);
      expect(exit).toHaveBeenCalledWith(130);
      const warned = err.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toContain("pendingAccessAppId");
      expect(warned).toContain("app-open-artifacts");
      expect(warned).not.toContain("CLIENT-SECRET-xyz");
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });

  it("a pending app whose redirect_uris lack the callback is not deleted", async () => {
    const odd = app("open-artifacts");
    odd.saas_app.redirect_uris = [
      "https://elsewhere.example.com/auth/callback",
    ];
    const w = world({
      policies: [POLICY],
      apps: [odd],
      secrets: [],
      state: { pendingAccessAppId: odd.id },
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(w.ops).toEqual([]);
  });

  it("clears leftover notes when a step ends in action_required or error", async () => {
    let seen: Ctx | undefined;
    const noisy = (
      end: () => Promise<
        undefined | { status: "action_required"; message: string }
      >,
    ): Step => ({
      name: "noisy",
      check: async (_s, ctx) => {
        seen = ctx;
        ctx.notes.push("stale");
        return "todo";
      },
      apply: end,
    });
    for (const end of [
      async () => ({ status: "action_required" as const, message: "x" }),
      async () => {
        throw new Error("boom");
      },
    ]) {
      const w = world();
      await run(HOSTS, w.deps, ROOT, [noisy(end)]);
      expect(seen?.notes).toEqual([]);
    }
  });
});

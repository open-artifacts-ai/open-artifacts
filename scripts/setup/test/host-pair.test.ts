import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { app, HOSTS, onboarded, POLICY, world } from "./world.ts";

// The server answers APP_HOST and CONTENT_HOST only (P1 Task 6b), so setup
// and the upgrade --check preflight refuse a pair it could not serve: an
// empty host, an unrendered {{placeholder}}, or one host for both after the
// server's normalization.
type W = ReturnType<typeof world>;
const args = (w: W) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === "args");
const withHosts = (appHost: string, contentHost: string) =>
  HOSTS.map((a, i) =>
    HOSTS[i - 1] === "--app-host"
      ? appHost
      : HOSTS[i - 1] === "--content-host"
        ? contentHost
        : a,
  );

const VARS = {
  ENVIRONMENT: "production",
  APP_HOST: "app.example.com",
  CONTENT_HOST: "a.b.usercontent.example.com",
  OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_CLIENT_ID: "cid-open-artifacts",
};
const cloud = (worker: Record<string, string>) => {
  const w = world({
    d1: [{ uuid: "d1-live", name: "open-artifacts" }],
    r2: [{ name: "open-artifacts" }],
    kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
    policies: [POLICY],
    apps: [app("open-artifacts")],
    secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CONTENT_SIGNING_KEY"],
    worker,
    seed: {
      users: [{ id: "u-owner", email: "owner@example.com", role: "owner" }],
    },
  });
  w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
  return w;
};
const UPGRADE_CHECK = [
  ...["--name", "open-artifacts", "--yes", "--json", "--upgrade", "--check"],
];

describe("setup refuses a host pair the server can't serve", () => {
  it("one host for both, after normalization, fails at args (setup and --check)", async () => {
    for (const extra of [[], ["--check"]])
      for (const content of ["app.example.com", "APP.example.com"]) {
        const w = world({ dns: onboarded("example.com") });
        expect(
          await run(
            [...withHosts("app.example.com", content), ...extra],
            w.deps,
            ROOT,
          ),
        ).toBe(1);
        expect(args(w)).toMatchObject({
          status: "error",
          message: expect.stringMatching(/APP_HOST and CONTENT_HOST/),
        });
        expect(w.creates).toEqual([]);
      }
  });

  it("an unrendered placeholder is refused", async () => {
    const w = world({ dns: onboarded("example.com") });
    expect(
      await run(
        [...withHosts("{{APP_HOST}}", "c.example.com"), "--check"],
        w.deps,
        ROOT,
      ),
    ).toBe(1);
    expect(args(w).status).toBe("error");
  });

  it("--upgrade --check flags a deployed pair that is equal, empty or a placeholder", async () => {
    // Each case names the guard that fired: the new pair check for an equal
    // pair, the existing host validation for a placeholder or an empty value.
    for (const [worker, message] of [
      [
        { ...VARS, CONTENT_HOST: "App.Example.com" },
        /^APP_HOST and CONTENT_HOST must differ/,
      ],
      [
        { ...VARS, CONTENT_HOST: "{{CONTENT_HOST}}" },
        /^invalid --content-host: "\{\{CONTENT_HOST\}\}"/,
      ],
      [
        { ...VARS, APP_HOST: "{{APP_HOST}}" },
        /^invalid --app-host: "\{\{APP_HOST\}\}"/,
      ],
      [
        { ...VARS, APP_HOST: "" },
        /^pass --app-host \(the deployed Worker has no APP_HOST\)/,
      ],
    ] as const) {
      const w = cloud(worker);
      expect(await run(UPGRADE_CHECK, w.deps, ROOT)).not.toBe(0);
      expect(args(w)?.status).toMatch(/^(error|action_required)$/);
      expect(args(w)?.message).toMatch(message);
      expect(w.ops).toEqual([]);
    }
  });

  it("--upgrade --check passes the deployed pair when it is sound", async () => {
    const w = cloud(VARS);
    expect(await run(UPGRADE_CHECK, w.deps, ROOT)).toBe(0);
    expect(args(w)).toBeUndefined();
  });
});

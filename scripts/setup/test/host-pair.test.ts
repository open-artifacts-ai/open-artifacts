import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { envelope, ROOT, STATE } from "./fakes.ts";
import { app, HOSTS, onboarded, POLICY, world } from "./world.ts";

// The server answers APP_HOST and CONTENT_HOST only (P1 Task 6b), so setup
// and the upgrade --check preflight refuse a pair it could not serve: an
// empty host, an unrendered {{placeholder}}, or one host for both after the
// server's normalization.
type W = ReturnType<typeof world>;
const args = (w: W) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === "args");
const failure = (w: W) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.status === "error");
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

describe("explicit single-host setup", () => {
  it("accepts a single hostname only when explicitly requested", async () => {
    const w = world({ dns: onboarded("example.com") });
    await run(
      [
        ...withHosts("app.example.com", "app.example.com"),
        "--single-host",
        "--check",
      ],
      w.deps,
      ROOT,
    );
    expect(args(w)).toBeUndefined();
    expect(w.creates).toEqual([]);
  });
});

it("keeps the single-host mode on state-less upgrade checks", async () => {
  const worker = {
    ...VARS,
    CONTENT_HOST: VARS.APP_HOST,
    CONTENT_ROUTING: "path",
  };
  const w = cloud(worker);
  expect(await run(UPGRADE_CHECK, w.deps, ROOT)).toBe(0);
  expect(args(w)).toBeUndefined();
  expect(w.ops).toEqual([]);
});
it("allows --single-host without requiring a second hostname argument", async () => {
  const w = world({ dns: onboarded("example.com") });
  const flags = HOSTS.filter(
    (a, i) => a !== "--content-host" && HOSTS[i - 1] !== "--content-host",
  );
  await run([...flags, "--single-host", "--check"], w.deps, ROOT);
  expect(args(w)).toBeUndefined();
});

it("requires an explicit mode flag when a state-less upgrade supplies all identity flags", async () => {
  const w = cloud({
    ...VARS,
    CONTENT_HOST: VARS.APP_HOST,
    CONTENT_ROUTING: "path",
  });
  const flags = [
    ...withHosts(VARS.APP_HOST, VARS.APP_HOST),
    "--upgrade",
    "--check",
  ];
  expect(await run(flags, w.deps, ROOT)).toBe(1);
  expect(args(w).message).toContain("--single-host");
  expect(w.ops).toEqual([]);
});

it("persists explicit single-host mode and keeps it on saved-state upgrade", async () => {
  const w = world({ appHost: VARS.APP_HOST, contentHost: VARS.APP_HOST });
  expect(
    await run(
      [...withHosts(VARS.APP_HOST, VARS.APP_HOST), "--single-host"],
      w.deps,
      ROOT,
    ),
    w.lines.join("\n"),
  ).toBe(0);
  expect(JSON.parse(w.files.get(STATE) ?? "{}")).toMatchObject({
    singleHost: true,
    appHost: VARS.APP_HOST,
    contentHost: VARS.APP_HOST,
  });
  w.lines.length = 0;
  expect(await run(UPGRADE_CHECK, w.deps, ROOT)).toBe(0);
  expect(args(w)).toBeUndefined();
});

it("refuses changing a saved two-host install to single-host before any writes", async () => {
  const w = world();
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  const saved = w.files.get(STATE);
  w.ops.length = 0;
  w.lines.length = 0;
  const flags = HOSTS.filter(
    (a, i) => a !== "--content-host" && HOSTS[i - 1] !== "--content-host",
  );
  expect(
    await run([...flags, "--single-host", "--upgrade"], w.deps, ROOT),
  ).toBe(1);
  expect(failure(w).message).toMatch(/changing.*routing mode.*not supported/i);
  expect(w.ops).toEqual([]);
  expect(w.files.get(STATE)).toBe(saved);
});

it("refuses changing a live two-host install even with all identity flags and no state", async () => {
  for (const extra of [[], ["--upgrade"]]) {
    const w = cloud(VARS);
    expect(
      await run(
        [...withHosts(VARS.APP_HOST, VARS.APP_HOST), "--single-host", ...extra],
        w.deps,
        ROOT,
      ),
    ).toBe(1);
    expect(failure(w).message).toMatch(
      /changing.*routing mode.*not supported/i,
    );
    expect(w.ops).toEqual([]);
    expect(w.files.has(STATE)).toBe(false);
  }
});

it("does not poison saved state after refusing a state-less mode switch", async () => {
  const w = world();
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  w.files.delete(STATE);
  w.ops.length = 0;
  w.lines.length = 0;
  expect(
    await run(
      [
        "--upgrade",
        "--name",
        "open-artifacts",
        "--single-host",
        "--yes",
        "--json",
      ],
      w.deps,
      ROOT,
    ),
  ).toBe(1);
  expect(failure(w).message).toMatch(/changing.*routing mode.*not supported/i);
  expect(w.files.has(STATE)).toBe(false);
  expect(w.ops).toEqual([]);
  expect(await run(UPGRADE_CHECK, w.deps, ROOT)).toBe(0);
  expect(w.ops).toEqual([]);
});

it("refuses a state-less single-host to two-host switch without poisoning state", async () => {
  for (const extra of [[], ["--upgrade"]]) {
    const w = world({ appHost: VARS.APP_HOST, contentHost: VARS.APP_HOST });
    expect(
      await run(
        [...withHosts(VARS.APP_HOST, VARS.APP_HOST), "--single-host"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    w.files.delete(STATE);
    w.ops.length = 0;
    w.lines.length = 0;
    expect(await run([...HOSTS, ...extra], w.deps, ROOT)).toBe(1);
    expect(failure(w).message).toMatch(
      /changing.*routing mode.*not supported/i,
    );
    expect(w.files.has(STATE)).toBe(false);
    expect(w.ops).toEqual([]);
    expect(await run(UPGRADE_CHECK, w.deps, ROOT)).toBe(0);
    expect(w.ops).toEqual([]);
  }
});

it("leaves state and config untouched when the live routing mode cannot be verified", async () => {
  for (const check of [[], ["--check"]]) {
    const opts: NonNullable<Parameters<typeof world>[0]> = {};
    const w = world(opts);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const before = new Map(w.files);
    Object.assign(opts, { settingsFail: true });
    w.ops.length = 0;
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade", ...check], w.deps, ROOT)).not.toBe(
      0,
    );
    expect(w.files).toEqual(before);
    expect(w.ops).toEqual([]);
  }
});

it("refuses an unknown deployed routing mode without writing state", async () => {
  const w = cloud({ ...VARS, CONTENT_ROUTING: "unknown" });
  expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(1);
  expect(failure(w).message).toContain("unknown deployed CONTENT_ROUTING");
  expect(w.files.has(STATE)).toBe(false);
  expect(w.ops).toEqual([]);
});

for (const [name, response] of [
  ["empty", {}],
  [
    "only app host",
    {
      bindings: [{ type: "plain_text", name: "APP_HOST", text: VARS.APP_HOST }],
    },
  ],
  [
    "only secrets",
    { bindings: [{ type: "secret_text", name: "SESSION_SECRET" }] },
  ],
] as const)
  it(`does not treat partial 200 settings (${name}) as an absent Worker`, async () => {
    const w = world({ appHost: VARS.APP_HOST, contentHost: VARS.APP_HOST });
    expect(
      await run(
        [...withHosts(VARS.APP_HOST, VARS.APP_HOST), "--single-host"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    w.files.delete(STATE);
    const before = new Map(w.files);
    const fetch = w.deps.fetch;
    let partial = true;
    w.deps.fetch = async (input, init) => {
      if (partial && String(input).endsWith("/settings")) {
        partial = false;
        return envelope(response);
      }
      return fetch(input, init);
    };
    w.ops.length = 0;
    w.lines.length = 0;
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(1);
    expect(failure(w).message).toContain("incomplete Worker settings");
    expect(w.files).toEqual(before);
    expect(w.ops).toEqual([]);
  });

it("resumes single-host setup after secrets created a draft but deployment failed", async () => {
  const opts: NonNullable<Parameters<typeof world>[0]> = {
    appHost: VARS.APP_HOST,
    contentHost: VARS.APP_HOST,
    deployFails: "temporary failure",
  };
  const w = world(opts);
  const flags = [...withHosts(VARS.APP_HOST, VARS.APP_HOST), "--single-host"];
  expect(await run(flags, w.deps, ROOT)).toBe(1);
  expect(w.deployed()).toBeUndefined();
  delete opts.deployFails;
  expect(await run(flags, w.deps, ROOT)).toBe(0);
});

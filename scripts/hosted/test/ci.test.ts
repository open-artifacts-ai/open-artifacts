// OPS-B: the oa:hosted CLI in CI. Prod in CI only from the hosted-ops
// workflow's gated job, credentials from 0600 files for prod too, the
// ephemeral --ci-owner-token and ci-token-sweep.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cfClient } from "@oa/provision";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { PUB, SECURITY, signed, world } from "./world.ts";

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
}));
vi.mock("../../../packages/provision/src/internal/gates.ts", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    PROD_UNLOCKED: true,
    FLOOR_MIN_SEQ: { staging: 1, prod: 1 },
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
  };
});
G.RELEASE_PUBKEY = { staging: PUB, prod: PUB };

type W = ReturnType<typeof world>;
const enc = (s: string) => new TextEncoder().encode(s);
const lastLine = (w: W) => w.parsed().at(-1);
const CREATE = (env = "staging") => [
  "create",
  "--env",
  env,
  "--slug",
  "finqore",
  "--owner",
  "owner@finqore.test",
  "--to",
  "0.23.0",
];
const PAT = /oa_pat_[1-9A-HJ-NP-Za-km-z]+/;

/** The hosted-ops job's environment: GitHub Actions, main, the prod Environment. */
const GATED = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  OA_HOSTED_ENVIRONMENT: "hosted-prod-deploy",
};

/** A CI world: the token (and R2) as 0600 files, no keychain. */
function ciWorld(env: "staging" | "prod", extra: Record<string, string> = {}) {
  const w = world({ env, ci: true });
  const r2 = w.keychain.get(`oa-hosted-${env}-r2`) as string;
  w.keychain.clear();
  w.files.set("/ci/token", {
    bytes: enc(`${w.fake.token}\n`),
    info: { mode: 0o100600, uid: 501, isFile: true },
  });
  w.files.set("/ci/r2", {
    bytes: enc(`${r2}\n`),
    info: { mode: 0o100600, uid: 501, isFile: true },
  });
  Object.assign(w.deps.env, {
    OA_HOSTED_TOKEN_FILE: "/ci/token",
    OA_HOSTED_R2_FILE: "/ci/r2",
    ...extra,
  });
  return w;
}

const tokensOf = (w: W, id: string) => {
  const row = w
    .db()
    .prepare("SELECT d1_id FROM installs WHERE id = ?")
    .get(id) as { d1_id: string };
  const db = (w.fake.d1.get(row.d1_id) as { db: DatabaseSync }).db;
  return {
    db,
    all: () =>
      db.prepare("SELECT label, revoked_at FROM tokens").all() as {
        label: string;
        revoked_at: number | null;
      }[],
  };
};

async function createdIn(w: W, extra: string[] = []): Promise<string> {
  expect(await main([...CREATE(w.env), ...extra], w.deps)).toBe(0);
  const id = w.parsed().find((l) => l.step === "create")?.data?.id as string;
  expect(id).toMatch(/^i[a-z0-9]{11}$/);
  w.lines.length = 0;
  return id;
}

describe("the prod-in-CI guard", () => {
  const REFS = [
    "refs/heads/main",
    "refs/heads/feature",
    "refs/heads/main-x",
    "refs/tags/v0.74.1",
    "refs/pull/1/merge",
    undefined,
  ];
  const ENVS = [
    "hosted-prod-deploy",
    "hosted-staging-deploy",
    "hosted-prod-deploy ",
    "Hosted-Prod-Deploy",
    "",
    undefined,
  ];
  const ACTIONS = ["true", "TRUE", "1", undefined];

  it("prod in CI runs only with GITHUB_ACTIONS=true, GITHUB_REF=refs/heads/main and OA_HOSTED_ENVIRONMENT=hosted-prod-deploy", async () => {
    let allowed = 0;
    for (const a of ACTIONS)
      for (const ref of REFS)
        for (const e of ENVS) {
          const w = ciWorld("prod");
          const set = (k: string, v: string | undefined) => {
            if (v === undefined) delete w.deps.env[k];
            else w.deps.env[k] = v;
          };
          set("GITHUB_ACTIONS", a);
          set("GITHUB_REF", ref);
          set("OA_HOSTED_ENVIRONMENT", e);
          const ok =
            a === "true" &&
            ref === "refs/heads/main" &&
            e === "hosted-prod-deploy";
          const code = await main(
            ["status", "--env", "prod", "--install", "iaaaaaaaaaaa"],
            w.deps,
          );
          const why = `${a} ${ref} ${JSON.stringify(e)}`;
          if (ok) {
            allowed++;
            // Past the guard: the token verified, then the install is unknown.
            expect(w.parsed()[0], why).toMatchObject({
              step: "token",
              status: "ok",
            });
          } else {
            expect(code, why).toBe(1);
            expect(lastLine(w), why).toMatchObject({
              step: "token",
              status: "error",
              message: "CI is staging only; prod refused",
            });
            // Refused before any call and before any secret is read.
            expect(w.cfCalls, why).toEqual([]);
            expect(w.fake.log, why).toEqual([]);
          }
        }
    expect(allowed).toBe(1);
  });

  it("CI=true without GITHUB_ACTIONS is CI, and refused for prod even with the right ref and Environment", async () => {
    const w = ciWorld("prod", {
      GITHUB_REF: "refs/heads/main",
      OA_HOSTED_ENVIRONMENT: "hosted-prod-deploy",
    });
    expect(w.deps.env.GITHUB_ACTIONS).toBeUndefined();
    expect(await main(CREATE("prod"), w.deps)).toBe(1);
    expect(lastLine(w).message).toBe("CI is staging only; prod refused");
    expect(w.fake.log).toEqual([]);
  });

  it("a laptop is unchanged: prod reads only the keychain, and a token file is refused even with the CI variables but no CI", async () => {
    const w = world({ env: "prod" });
    Object.assign(w.deps.env, {
      GITHUB_REF: "refs/heads/main",
      OA_HOSTED_ENVIRONMENT: "hosted-prod-deploy",
    });
    expect(await main(CREATE("prod"), w.deps)).toBe(0);
    expect(
      w.execs.some(
        (x) => x.file === SECURITY && x.args.includes("oa-hosted-prod"),
      ),
    ).toBe(true);
    const f = world({ env: "prod" });
    f.files.set("/ci/token", {
      bytes: enc(f.fake.token),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    f.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    expect(await main(CREATE("prod"), f.deps)).toBe(1);
    expect(lastLine(f).message).toMatch(/only from the keychain/);
    expect(f.fake.log).toEqual([]);
  });

  it("staging in CI needs none of the prod guard's variables", async () => {
    const w = ciWorld("staging");
    expect(await main(CREATE(), w.deps)).toBe(0);
  });
});

describe("prod in CI: credentials from the 0600 files, with the same checks", () => {
  it("reads the token from OA_HOSTED_TOKEN_FILE, never the keychain, and refuses a file that is not 0600, not this user's, or a symlink", async () => {
    const w = ciWorld("prod", GATED);
    for (const [f, re] of [
      [{ info: { mode: 0o100644, uid: 501, isFile: true } }, /0600/],
      [{ info: { mode: 0o100600, uid: 0, isFile: true } }, /owned/],
      [
        { info: { mode: 0o100600, uid: 501, isFile: true }, symlink: true },
        /symlink/,
      ],
      [{ info: { mode: 0o040700, uid: 501, isFile: false } }, /regular file/],
    ] as const) {
      w.files.set("/ci/token", { bytes: enc(w.fake.token), ...f });
      expect(await main(CREATE("prod"), w.deps)).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
      expect(lastLine(w).message).toMatch(re);
      expect(lastLine(w).message).toMatch(/OA_HOSTED_TOKEN_FILE/);
    }
    expect(w.fake.log).toEqual([]);
    delete w.deps.env.OA_HOSTED_TOKEN_FILE;
    expect(await main(CREATE("prod"), w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(
      /CI has no keychain; set OA_HOSTED_TOKEN_FILE/,
    );
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    w.files.set("/ci/token", {
      bytes: enc(`${w.fake.token}\n`),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    expect(await main(CREATE("prod"), w.deps)).toBe(0);
    expect(w.execs.filter((e) => e.file === SECURITY)).toEqual([]);
    expect(w.audit()[0]?.actor).toBe(
      "https://github.com/open-artifacts-ai/open-artifacts/actions/runs/42",
    );
    const out = w.lines.join("\n");
    expect(out).not.toContain(w.fake.token);
  });

  it("reads R2 from OA_HOSTED_R2_FILE for prod publish, with the same file checks, and prints neither half", async () => {
    const w = ciWorld("prod", GATED);
    w.files.set("/f/floor.sig.json", {
      bytes: enc(
        JSON.stringify(
          signed("oa-release-floor-v1", "prod", {
            env: "prod",
            seq: 2,
            minVersion: "0.20.0",
            revoked: [],
          }),
        ),
      ),
      info: { mode: 0o100644, uid: 501, isFile: true },
    });
    const PUBLISH = [
      "publish-floor",
      "--env",
      "prod",
      "--floor",
      "/f/floor.sig.json",
    ];
    const good = w.files.get("/ci/r2");
    w.files.set("/ci/r2", {
      ...(good as NonNullable<typeof good>),
      info: { mode: 0o100640, uid: 501, isFile: true },
    });
    expect(await main(PUBLISH, w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(/OA_HOSTED_R2_FILE must be mode 0600/);
    expect(w.fake.r2Log).toEqual([]);
    w.files.set("/ci/r2", good as NonNullable<typeof good>);
    expect(await main(PUBLISH, w.deps)).toBe(0);
    expect(w.execs.filter((e) => e.file === SECURITY)).toEqual([]);
    const out = w.lines.join("\n");
    expect(out).not.toContain(w.r2Creds.accessKeyId);
    expect(out).not.toContain(w.r2Creds.secretAccessKey);
  });
});

describe("--ci-owner-token", () => {
  it("is refused outside CI, on any other command, and without a numeric GITHUB_RUN_ID, before any call", async () => {
    const laptop = world();
    expect(await main([...CREATE(), "--ci-owner-token"], laptop.deps)).toBe(1);
    expect(lastLine(laptop)).toMatchObject({ step: "args", status: "error" });
    expect(lastLine(laptop).message).toMatch(/CI only/);
    expect(laptop.fake.log).toEqual([]);
    expect(laptop.execs).toEqual([]);
    for (const argv of [
      ["status", "--env", "staging", "--install", "iaaaaaaaaaaa"],
      [
        "delete",
        "--env",
        "staging",
        "--install",
        "iaaaaaaaaaaa",
        "--confirm",
        "iaaaaaaaaaaa",
      ],
      ["publish-release", "--env", "staging", "--tag", "v0.23.0"],
    ]) {
      const w = ciWorld("staging");
      expect(await main([...argv, "--ci-owner-token"], w.deps)).toBe(1);
      expect(lastLine(w).message).toMatch(/--ci-owner-token is for create/);
      expect(w.fake.log).toEqual([]);
    }
    for (const run of [undefined, "", "0", "42x", "1 2", "-1"]) {
      const w = ciWorld("staging");
      if (run === undefined) delete w.deps.env.GITHUB_RUN_ID;
      else w.deps.env.GITHUB_RUN_ID = run;
      expect(await main([...CREATE(), "--ci-owner-token"], w.deps), run).toBe(
        1,
      );
      expect(lastLine(w).message).toMatch(/CI only/);
      expect(w.fake.log).toEqual([]);
    }
  });

  it("create in CI: the selftest runs on ci-<GITHUB_RUN_ID>, revoked before the run ends; no PAT file, no PAT in any output; the install id is printed for the sweep", async () => {
    const w = ciWorld("staging");
    expect(await main([...CREATE(), "--ci-owner-token"], w.deps)).toBe(0);
    const lines = w.parsed();
    const id = lines.find((l) => l.step === "create")?.data?.id as string;
    expect(lines.find((l) => l.step === "ci-owner-token")).toEqual({
      step: "ci-owner-token",
      status: "ok",
      install: id,
    });
    expect(lines.find((l) => l.step === "create")?.data?.patFile).toBe(
      undefined,
    );
    const dir = join(w.home, ".open-artifacts", "hosted-staging");
    expect(
      existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith("-pat-token"))
        : [],
    ).toEqual([]);
    const t = tokensOf(w, id).all();
    expect(t.map((x) => x.label)).toEqual(["ci-42"]);
    expect(t[0]?.revoked_at).not.toBeNull();
    const all = [...w.lines, ...w.errLines].join("\n");
    expect(all).not.toMatch(PAT);
    expect(JSON.stringify(w.execs)).not.toMatch(PAT);
    expect(JSON.stringify(w.audit())).not.toMatch(PAT);
  });

  it("upgrade and rollback in CI run with no PAT file, each on its own revoked ci token", async () => {
    const w = ciWorld("staging");
    const id = await createdIn(w, ["--ci-owner-token"]);
    expect(
      await main(
        [
          "upgrade",
          "--env",
          "staging",
          "--install",
          id,
          "--to",
          "0.24.0",
          "--ci-owner-token",
        ],
        w.deps,
      ),
    ).toBe(0);
    expect(
      await main(
        ["rollback", "--env", "staging", "--install", id, "--ci-owner-token"],
        w.deps,
      ),
    ).toBe(0);
    const t = tokensOf(w, id).all();
    expect(t).toHaveLength(3);
    expect(t.every((x) => x.label === "ci-42" && x.revoked_at !== null)).toBe(
      true,
    );
    // Without the flag CI has no PAT file to selftest with.
    expect(
      await main(
        ["upgrade", "--env", "staging", "--install", id, "--to", "0.25.0"],
        w.deps,
      ),
    ).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "upgrade" && l.status === "error")
        ?.message,
    ).toMatch(/owner token file/);
  });
});

describe("ci-token-sweep", () => {
  const SWEEP = (id: string, run = "42") => [
    "ci-token-sweep",
    "--env",
    "staging",
    "--install",
    id,
    "--run",
    run,
  ];

  it("needs --install and a numeric --run; --run is for the sweep only", async () => {
    for (const argv of [
      ["ci-token-sweep", "--env", "staging", "--run", "42"],
      ["ci-token-sweep", "--env", "staging", "--install", "iaaaaaaaaaaa"],
      SWEEP("iaaaaaaaaaaa", "abc"),
      SWEEP("iaaaaaaaaaaa", "0"),
      SWEEP("iaaaaaaaaaaa", "42;rm"),
      SWEEP("not-an-id"),
      ["status", "--env", "staging", "--install", "iaaaaaaaaaaa", "--run", "1"],
    ]) {
      const w = world();
      expect(await main(argv, w.deps), argv.join(" ")).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
      expect(w.fake.log).toEqual([]);
    }
  });

  it("revokes a crashed run's ci-<run> token, verifies none remains, and exits 0; another run's token stays", async () => {
    const w = ciWorld("staging");
    const id = await createdIn(w, ["--ci-owner-token"]);
    const { db, all } = tokensOf(w, id);
    db.prepare(
      "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tcrash', id, 'ci-42', 'h', 1 FROM users WHERE role = 'owner'",
    ).run();
    db.prepare(
      "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tother', id, 'ci-43', 'h2', 1 FROM users WHERE role = 'owner'",
    ).run();
    expect(await main(SWEEP(id), w.deps)).toBe(0);
    expect(w.parsed().find((l) => l.step === "ci-token-sweep")?.data).toEqual({
      id,
      label: "ci-42",
      revoked: 1,
      active: 0,
    });
    const t = all();
    expect(t.filter((x) => x.label === "ci-42" && !x.revoked_at)).toEqual([]);
    expect(t.find((x) => x.label === "ci-43")?.revoked_at).toBeNull();
    expect(w.audit().map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "cli.ci-token-sweep.start",
        "cli.ci-token-sweep.done",
      ]),
    );
  });

  it("exits 1 when the verifying read still finds an active token", async () => {
    const w = ciWorld("staging");
    const id = await createdIn(w, ["--ci-owner-token"]);
    tokensOf(w, id)
      .db.prepare(
        "INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT 'tcrash', id, 'ci-42', 'h', 1 FROM users WHERE role = 'owner'",
      )
      .run();
    const lossy: typeof fetch = async (u, init) => {
      const body = String(init?.body ?? "");
      if (/UPDATE tokens SET revoked_at = \?1 WHERE label = \?2/.test(body))
        return w.fake.fetch(u, {
          ...init,
          body: JSON.stringify({ sql: "SELECT 1", params: [] }),
        });
      return w.fake.fetch(u, init);
    };
    w.deps.cf = (c) => cfClient({ ...c, fetch: lossy, sleep: async () => {} });
    expect(await main(SWEEP(id), w.deps)).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "ci-token-sweep" && l.status === "error")
        ?.message,
    ).toMatch(/still active after the sweep/);
  });
});

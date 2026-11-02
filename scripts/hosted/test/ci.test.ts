// OPS-B: the oa:hosted CLI in CI. Prod in CI only from the hosted-publish
// workflow's gated job, credentials from 0600 files for prod too.
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
const STATUS = (id: string, env = "staging") => [
  "status",
  "--env",
  env,
  "--install",
  id,
];

/** The hosted-publish job's environment: GitHub Actions, main, the prod Environment. */
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
    expect(await main(STATUS("iaaaaaaaaaaa", "prod"), w.deps)).toBe(1);
    expect(lastLine(w).message).toBe("CI is staging only; prod refused");
    expect(w.fake.log).toEqual([]);
  });

  it("a laptop is unchanged: prod reads only the keychain, and a token file is refused even with the CI variables but no CI", async () => {
    const w = world({ env: "prod" });
    Object.assign(w.deps.env, {
      GITHUB_REF: "refs/heads/main",
      OA_HOSTED_ENVIRONMENT: "hosted-prod-deploy",
    });
    expect(await main(STATUS(await w.seed(), "prod"), w.deps)).toBe(0);
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
    expect(await main(STATUS("iaaaaaaaaaaa", "prod"), f.deps)).toBe(1);
    expect(lastLine(f).message).toMatch(/only from the keychain/);
    expect(f.fake.log).toEqual([]);
  });

  it("staging in CI needs none of the prod guard's variables", async () => {
    const w = ciWorld("staging");
    expect(await main(STATUS(await w.seed()), w.deps)).toBe(0);
  });
});

describe("prod in CI: credentials from the 0600 files, with the same checks", () => {
  it("reads the token from OA_HOSTED_TOKEN_FILE, never the keychain, and refuses a file that is not 0600, not this user's, or a symlink", async () => {
    const w = ciWorld("prod", GATED);
    const id = await w.seed();
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
      expect(await main(STATUS(id, "prod"), w.deps)).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
      expect(lastLine(w).message).toMatch(re);
      expect(lastLine(w).message).toMatch(/OA_HOSTED_TOKEN_FILE/);
    }
    expect(w.fake.log).toEqual([]);
    delete w.deps.env.OA_HOSTED_TOKEN_FILE;
    expect(await main(STATUS(id, "prod"), w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(
      /CI has no keychain; set OA_HOSTED_TOKEN_FILE/,
    );
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    w.files.set("/ci/token", {
      bytes: enc(`${w.fake.token}\n`),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    expect(await main(STATUS(id, "prod"), w.deps)).toBe(0);
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

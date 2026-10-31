// P1 Task 8: the oa:hosted CLI against provision's in-memory Cloudflare.
// No live call: the keychain, git and gh are stubs (world.ts). Since W9b the
// CLI is status plus the two publishes; installs are seeded by world.seed.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cfClient } from "@oa/provision";
import { describe, expect, it, vi } from "vitest";
import {
  COMMANDS,
  DOMAINS,
  HELP,
  main,
  openNoFollow,
  RETIRED_COMMANDS,
} from "../src/cli.ts";
import { ACTOR, PUB, SECURITY, signed, world } from "./world.ts";

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
const STATUS = (id: string, env = "staging") => [
  "status",
  "--env",
  env,
  "--install",
  id,
];
/** A command that refuses a near-expiry token (status only warns). */
const FLOOR_CMD = (env = "staging") => [
  "publish-floor",
  "--env",
  env,
  "--floor",
  "/f/none.sig.json",
];

const noCalls = (w: W) => {
  expect(w.cfCalls).toEqual([]);
  expect(w.execs).toEqual([]);
  expect(w.fake.log).toEqual([]);
};
const lastLine = (w: W) => w.parsed().at(-1);

async function created(w: W) {
  const id = await w.seed();
  expect(id).toMatch(/^i[a-z0-9]{11}$/);
  return id;
}

describe("domains", () => {
  it("DOMAINS[env] equals the decided suffixes", () => {
    expect(DOMAINS).toEqual({
      staging: {
        app: "open-artifacts-staging.app",
        content: "open-artifacts-staging.page",
      },
      prod: { app: "open-artifacts.app", content: "open-artifacts.page" },
    });
  });
});

describe("refusals before any call", () => {
  it("every retired write command is refused before any call (design 10.1)", async () => {
    for (const cmd of RETIRED_COMMANDS) {
      const w = world();
      expect(
        await main([cmd, "--env", "staging", "--install", "iaaaaaaaaaaa"], w.deps),
        cmd,
      ).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
      expect(lastLine(w).message).toBe(
        `${cmd} is retired: use the Provisioning API`,
      );
      noCalls(w);
    }
  });

  it.each([
    [["status"]],
    [["status", "--env", "dev", "--install", "iaaaaaaaaaaa"]],
    [["nope", "--env", "staging"]],
    [[...STATUS("iaaaaaaaaaaa"), "--tag", "v1.0.0"]],
    [[...STATUS("iaaaaaaaaaaa"), "--force"]],
    [[...STATUS("iaaaaaaaaaaa"), "--ci-owner-token"]],
    [[...STATUS("iaaaaaaaaaaa"), "--skip-directory-revoke", "x"]],
    [["publish-floor", "--env", "staging"]],
    [["publish-release", "--env", "staging", "--tag", "main"]],
    [["status", "--env", "staging", "--install", "../etc"]],
  ])("bad flags exit 1 before any call: %j", async (argv) => {
    const w = world();
    expect(await main(argv, w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
    noCalls(w);
  });

  it("every documented command is accepted", () => {
    expect(COMMANDS).toEqual(["status", "publish-release", "publish-floor"]);
  });
});

describe("token source", () => {
  it("the CLI refuses prod with the staging token file", async () => {
    const w = world({ env: "prod" });
    w.files.set("/ci/token", {
      bytes: new TextEncoder().encode(w.fake.token),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    expect(
      await main(
        ["status", "--env", "prod", "--install", "iaaaaaaaaaaa"],
        w.deps,
      ),
    ).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
    expect(lastLine(w).message).toMatch(/only from the keychain/);
    expect(w.cfCalls).toEqual([]);
    expect(w.fake.log).toEqual([]);
  });

  it("prod reads only from the keychain, never a file", async () => {
    const w = world({ env: "prod" });
    const id = await created(w);
    expect(await main(STATUS(id, "prod"), w.deps)).toBe(0);
    const sec = w.execs.filter((e) => e.file === SECURITY);
    expect(sec.length).toBeGreaterThan(0);
    expect(sec[0]?.args).toEqual([
      "find-generic-password",
      "-a",
      "open-artifacts",
      "-s",
      "oa-hosted-prod",
      "-w",
    ]);
    // CI is staging only: prod in CI is refused even with a keychain.
    const c = world({ env: "prod", ci: true });
    expect(
      await main(["status", "--env", "prod", "--install", id], c.deps),
    ).toBe(1);
    expect(lastLine(c).message).toMatch(/staging only/);
    expect(c.fake.log).toEqual([]);
  });

  it("staging in CI reads a 0600 file it owns, and refuses any other", async () => {
    const w = world({ ci: true });
    const id = await created(w);
    w.keychain.clear();
    const set = (mode: number, uid = 501, isFile = true) =>
      w.files.set("/ci/token", {
        bytes: new TextEncoder().encode(`${w.fake.token}\n`),
        info: { mode, uid, isFile },
      });
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    for (const [mode, uid, isFile] of [
      [0o100644, 501, true],
      [0o100600, 0, true],
      [0o120600, 501, false],
    ] as const) {
      set(mode, uid, isFile);
      expect(await main(STATUS(id), w.deps)).toBe(1);
      expect(lastLine(w).step).toBe("token");
    }
    expect(w.fake.log).toEqual([]);
    set(0o100600);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(w.execs.filter((e) => /security/.test(e.file))).toEqual([]);
    expect(w.audit()[0]?.actor).toBe(
      "https://github.com/open-artifacts-ai/open-artifacts/actions/runs/42",
    );
  });

  it("an inactive or long-lived token is refused by the provisioner's checks before any write", async () => {
    for (const bad of [
      { status: "disabled" },
      {
        expires_on: new Date(Date.parse("2026-12-30T00:00:00Z")).toISOString(),
      },
    ]) {
      const w = world();
      Object.assign(w.fake.tokenInfo, bad);
      expect(await main(FLOOR_CMD(), w.deps)).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
      expect(w.fake.writes()).toEqual([]);
      expect(w.audit()).toEqual([]);
    }
  });
});

describe("audit", () => {
  it("every command writes a before and after hosted_audit row, and the table refuses UPDATE and DELETE", async () => {
    const w = world();
    const id = await created(w);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(await main(FLOOR_CMD(), w.deps)).toBe(1);
    expect(w.audit()).toEqual([
      { actor: ACTOR, install_id: id, action: "cli.status.start" },
      { actor: ACTOR, install_id: id, action: "cli.status.done" },
      { actor: ACTOR, install_id: "-", action: "cli.publish-floor.start" },
      { actor: ACTOR, install_id: "-", action: "cli.publish-floor.failed" },
    ]);
    expect(() =>
      w.db().prepare("UPDATE hosted_audit SET actor = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() => w.db().prepare("DELETE FROM hosted_audit").run()).toThrow(
      /append-only/,
    );
  });

  it("no git email: refused before any Cloudflare call", async () => {
    const w = world();
    const exec = w.deps.execFile;
    w.deps.execFile = async (f, a) => (f === "git" ? "" : exec(f, a));
    expect(await main(STATUS("iaaaaaaaaaaa"), w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(/user\.email/);
    expect(w.fake.log).toEqual([]);
  });
});

describe("output", () => {
  it("no secret or PAT value appears in stdout", async () => {
    const w = world();
    const id = await created(w);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    const out = w.lines.join("\n");
    for (const l of w.lines) expect(() => JSON.parse(l)).not.toThrow();
    const generated = new Set<string>([w.fake.token]);
    for (const sc of w.fake.scripts.values())
      for (const v of sc.secrets.values()) generated.add(v);
    const patDir = join(w.home, ".open-artifacts", "hosted-staging");
    for (const f of readdirSync(patDir))
      generated.add(readFileSync(join(patDir, f), "utf8").trim());
    expect(generated.size).toBeGreaterThan(3);
    for (const v of generated) {
      expect(v.length).toBeGreaterThan(8);
      expect(out).not.toContain(v);
    }
    expect(out).not.toMatch(/oa_pat_[1-9A-HJ-NP-Za-km-z]{8}/);
    expect(w.parsed().find((l) => l.step === "status")?.data).toMatchObject({
      id,
      state: "active",
      version: "0.23.0",
    });
  });

  it("a token Cloudflare echoes in an error is redacted", async () => {
    const w = world();
    w.fake.inject((_m, p) => p === "/user/tokens/verify", {
      status: 400,
      message: `bad token ${w.fake.token}`,
      times: 1,
    });
    expect(await main(STATUS("iaaaaaaaaaaa"), w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
    expect(lastLine(w).message).toContain("bad token [redacted]");
    expect(w.lines.join("\n")).not.toContain(w.fake.token);
  });
});

describe("commands", () => {
  it("status reports sessionCut.armed as well as pending", async () => {
    const w = world();
    const id = await created(w);
    w.db()
      .prepare(
        "UPDATE installs SET session_cut = ?, session_cut_base = '{}', session_cut_armed = 1 WHERE id = ?",
      )
      .run("ab".repeat(16), id);
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.sessionCut,
    ).toEqual({
      pending: true,
      armed: true,
      owedRelativeToRecordedVars: false,
    });
  });

  it("publish-release downloads the env's tar and .sig.json with gh, then hands them to publishRelease", async () => {
    const w = world();
    const exec = w.deps.execFile;
    let dir = "";
    w.deps.execFile = async (f, a) => {
      if (f !== "gh") return exec(f, a);
      w.execs.push({ file: f, args: a });
      dir = a[a.indexOf("--dir") + 1] as string;
      writeFileSync(
        join(dir, "oa-release-staging-release-0.30.0.tar"),
        "not a tar",
      );
      writeFileSync(
        join(dir, "oa-release-staging-release-0.30.0.sig.json"),
        "{}",
      );
      return "";
    };
    w.deps.readFile = (p) => new Uint8Array(readFileSync(p));
    let removed = "";
    w.deps.removeTree = (d) => {
      removed = d;
    };
    expect(
      await main(
        ["publish-release", "--env", "staging", "--tag", "v0.30.0"],
        w.deps,
      ),
    ).toBe(1);
    const gh = w.execs.find((e) => e.file === "gh");
    expect(gh?.args).toEqual([
      "release",
      "download",
      "v0.30.0",
      "--repo",
      "open-artifacts-ai/open-artifacts",
      "--pattern",
      "oa-release-staging-*",
      "--dir",
      dir,
    ]);
    // The bytes are verified before any upload: a bad .sig.json is refused.
    const msg = w.parsed().find((l) => l.step === "publish-release")?.message;
    expect(msg).toMatch(/\.sig\.json/);
    expect(
      w.fake.r2Log.filter(
        (e) => e.method === "PUT" && !e.key.startsWith("probe/"),
      ),
    ).toEqual([]);
    expect(removed).toBe(dir);
  });

  it("publish-floor reads the floor file and hands it to publishFloor", async () => {
    const w = world();
    w.files.set("/f/floor.sig.json", {
      bytes: new TextEncoder().encode("{}"),
      info: { mode: 0o100644, uid: 501, isFile: true },
    });
    expect(
      await main(
        ["publish-floor", "--env", "staging", "--floor", "/f/floor.sig.json"],
        w.deps,
      ),
    ).toBe(1);
    expect(w.parsed().find((l) => l.step === "publish-floor")?.message).toMatch(
      /^the new staging floor: /,
    );
    expect(
      w.fake.r2Objects.get("oa-s-releases")?.has("releases/floor.json"),
    ).not.toBe(true);
  });

  it("publish-floor publishes a signed floor through publishFloor", async () => {
    const w = world();
    const floor = { env: "staging", seq: 2, minVersion: "0.20.0", revoked: [] };
    w.files.set("/f/floor.sig.json", {
      bytes: new TextEncoder().encode(
        JSON.stringify(signed("oa-release-floor-v1", "staging", floor)),
      ),
      info: { mode: 0o100644, uid: 501, isFile: true },
    });
    expect(
      await main(
        ["publish-floor", "--env", "staging", "--floor", "/f/floor.sig.json"],
        w.deps,
      ),
    ).toBe(0);
    expect(w.parsed().find((l) => l.step === "publish-floor")?.data).toEqual(
      floor,
    );
    expect(
      w.fake.r2Objects.get("oa-s-releases")?.has("releases/floor.json"),
    ).toBe(true);
  });

  it("keychain calls use /usr/bin/security, never a PATH lookup", async () => {
    const w = world();
    const id = await created(w);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(await main(FLOOR_CMD(), w.deps)).toBe(1);
    const sec = w.execs.filter((e) => /security/.test(e.file));
    expect(sec.length).toBeGreaterThan(2);
    for (const e of sec) expect(e.file).toBe("/usr/bin/security");
  });

  it.each([
    [
      [
        "publish-release",
        "--env",
        "staging",
        "--tag",
        "v1.0.0",
        "--install",
        "iaaaaaaaaaaa",
      ],
    ],
    [
      [
        "publish-floor",
        "--env",
        "staging",
        "--floor",
        "/f",
        "--install",
        "iaaaaaaaaaaa",
      ],
    ],
    [
      [
        "publish-floor",
        "--env",
        "staging",
        "--floor",
        "/f",
        "--tag",
        "v1.0.0",
      ],
    ],
  ])("refused at parse, before any call: %j", async (argv) => {
    const w = world();
    expect(await main(argv, w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
    noCalls(w);
  });
});

describe("broker: status checks the registry when the vars turn google on", () => {
  it("status of a google install reads with the broker on: a missing entry is drift", async () => {
    const w = world();
    const id = await w.seed({
      AUTH_PROVIDERS: "google",
      AUTH_DOMAINS: "finqore.test",
    });
    w.fake.kvValues(w.dirId).delete(`install:${id}`);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.registryDrift,
    ).toEqual({
      id,
      kind: "missing_directory",
    });
  });

  it("status of a non-google install: no registry, no drift", async () => {
    const w = world();
    const id = await w.seed({ FEATURES: "spaces" });
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.registryDrift,
    ).toBeNull();
  });
});

describe("--help", () => {
  it("prints the usage, every command and the extra flags, and makes no call", async () => {
    const w = world();
    expect(await main(["--help"], w.deps)).toBe(0);
    const out = w.lines.join("\n");
    expect(out).toBe(HELP);
    for (const c of COMMANDS) expect(out).toContain(c);
    for (const f of ["--tag", "--floor", "--install"]) expect(out).toContain(f);
    expect(out).toContain("Provisioning API");
    expect(out).toContain("CLOUDFLARE_ACCOUNT_ID");
    noCalls(w);
  });
});

describe("final round: token file, audit gap, keychain account", () => {
  it("openNoFollow refuses a symlink and reads the opened file even after a swap", () => {
    const d = mkdtempSync(join(tmpdir(), "oa-nofollow-"));
    const real = join(d, "token");
    writeFileSync(real, "first-token\n", { mode: 0o600 });
    const link = join(d, "link");
    symlinkSync(real, link);
    expect(() => openNoFollow(link)).toThrow(/ELOOP|symbolic link/i);
    const o = openNoFollow(real);
    expect(o.info.isFile).toBe(true);
    expect(o.info.mode & 0o777).toBe(0o600);
    // Swapped after the open: the fd still reads the file that was opened.
    writeFileSync(join(d, "other"), "swapped-in\n", { mode: 0o600 });
    renameSync(join(d, "other"), real);
    expect(new TextDecoder().decode(o.read())).toBe("first-token\n");
    o.close();
  });

  it("a symlinked or 0644 token file is refused before any call", async () => {
    for (const f of [
      { symlink: true, info: { mode: 0o100600, uid: 501, isFile: true } },
      { info: { mode: 0o100644, uid: 501, isFile: true } },
    ]) {
      const w = world({ ci: true });
      w.files.set("/ci/token", {
        bytes: new TextEncoder().encode(w.fake.token),
        ...f,
      });
      w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
      expect(await main(STATUS("iaaaaaaaaaaa"), w.deps)).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
      expect(w.fake.log).toEqual([]);
    }
  });

  /** Fails the next `n` D1 writes whose body holds `marker`. */
  const failAudit = (w: W, marker: string, n: number) => {
    let left = n;
    w.deps.cf = (c) =>
      cfClient({
        ...c,
        sleep: async () => {},
        fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
          const body = typeof init?.body === "string" ? init.body : "";
          if (left > 0 && body.includes(marker)) {
            left--;
            return Response.json(
              { success: false, errors: [{ code: 7500, message: "d1 down" }] },
              { status: 400 },
            );
          }
          return w.fake.fetch(u, init);
        }) as typeof fetch,
      });
  };
  const pendingDir = (w: W) =>
    join(w.home, ".config", "oa-hosted", "pending-audit");

  it("a failed after-row is retried once", async () => {
    const w = world();
    const id = await created(w);
    failAudit(w, "cli.status.done", 1);
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      w.audit().filter((r) => r.action === "cli.status.done"),
    ).toHaveLength(1);
    expect(w.errLines).toEqual([]);
  });

  it("an after-row that fails twice is an AUDIT GAP on stderr, recorded locally, and the next command for that install writes it first", async () => {
    const w = world();
    const id = await created(w);
    failAudit(w, "cli.status.done", 2);
    const code = await main(
      ["status", "--env", "staging", "--install", id],
      w.deps,
    );
    expect(code).not.toBe(0);
    expect(w.errLines).toEqual([
      `AUDIT GAP: status ${id} took effect, after-row not written`,
    ]);
    const files = readdirSync(pendingDir(w));
    expect(files).toHaveLength(1);
    const f = join(pendingDir(w), files[0] as string);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(pendingDir(w)).mode & 0o777).toBe(0o700);
    const text = readFileSync(f, "utf8");
    expect(text).not.toContain(w.fake.token);
    expect(JSON.parse(text)).toMatchObject({
      env: "staging",
      install: id,
      action: "cli.status.done",
      exit: 0,
    });
    // The next command for that install writes the recovery row first.
    w.deps.cf = (c) =>
      cfClient({ ...c, fetch: w.fake.fetch, sleep: async () => {} });
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    // The gap run's start, its recovered after-row, then this run's pair.
    expect(
      w
        .audit()
        .slice(-4)
        .map((r) => r.action),
    ).toEqual([
      "cli.status.start",
      "cli.status.done",
      "cli.status.start",
      "cli.status.done",
    ]);
    const rec = w
      .db()
      .prepare(
        "SELECT detail FROM hosted_audit WHERE install_id = ? AND action = 'cli.status.done' ORDER BY id",
      )
      .all(id) as { detail: string }[];
    expect(JSON.parse(rec[0]?.detail as string)).toMatchObject({
      recovered: 1,
    });
    expect(readdirSync(pendingDir(w))).toEqual([]);
  });

  it("another install's gap is left for that install", async () => {
    const w = world();
    const id = await created(w);
    failAudit(w, "cli.status.done", 2);
    await main(["status", "--env", "staging", "--install", id], w.deps);
    w.deps.cf = (c) =>
      cfClient({ ...c, fetch: w.fake.fetch, sleep: async () => {} });
    const other = await w.seed({}, "acme");
    expect(await main(STATUS(other), w.deps)).toBe(0);
    expect(readdirSync(pendingDir(w))).toHaveLength(1);
  });

  it("every keychain read uses the account open-artifacts", async () => {
    const w = world();
    const id = await created(w);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(await main(FLOOR_CMD(), w.deps)).toBe(1);
    const sec = w.execs.filter((e) => e.file === SECURITY);
    expect(sec.length).toBeGreaterThan(1);
    for (const e of sec) {
      expect(e.args[0]).toBe("find-generic-password");
      expect(e.args.slice(1, 3)).toEqual(["-a", "open-artifacts"]);
    }
  });
});

describe("H-DV: status shows the directory revoke", () => {
  it("status shows directory_revoke", async () => {
    const w = world();
    const id = await created(w);
    w.db()
      .prepare(
        "UPDATE installs SET state = 'deleting', directory_revoke = 'pending', directory_revoke_attempts = 2 WHERE id = ?",
      )
      .run(id);
    expect(await main(STATUS(id), w.deps)).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.directoryRevoke,
    ).toEqual({
      state: "pending",
      attempts: 2,
      revokedAt: null,
    });
  });
});

describe("H-DV: a purged owner email", () => {
  it("status prints owner (purged), never an address", async () => {
    const w = world();
    const id = await created(w);
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(w.parsed().find((l) => l.step === "status")?.data.owner).toBe(
      "(set)",
    );
    expect(w.lines.join("\n")).not.toContain("owner@finqore.test");
    w.db().prepare("UPDATE installs SET owner_email = '' WHERE id = ?").run(id);
    w.lines.length = 0;
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(w.parsed().find((l) => l.step === "status")?.data.owner).toBe(
      "(purged)",
    );
  });
});

describe("H-S3: R2 credentials for publish", () => {
  const FLOOR = { env: "staging", seq: 2, minVersion: "0.20.0", revoked: [] };
  const floorFile = (w: W, env = "staging") =>
    w.files.set("/f/floor.sig.json", {
      bytes: new TextEncoder().encode(
        JSON.stringify(signed("oa-release-floor-v1", env, { ...FLOOR, env })),
      ),
      info: { mode: 0o100644, uid: 501, isFile: true },
    });
  const PUBLISH = (env = "staging") => [
    "publish-floor",
    "--env",
    env,
    "--floor",
    "/f/floor.sig.json",
  ];
  const halves = (w: W) => [w.r2Creds.accessKeyId, w.r2Creds.secretAccessKey];
  const r2Reads = (w: W) =>
    w.execs.filter(
      (e) =>
        e.file === SECURITY &&
        e.args[0] === "find-generic-password" &&
        /-r2$/.test(e.args[e.args.indexOf("-s") + 1] as string),
    );

  it("publish reads oa-hosted-<env>-r2 from the keychain and writes through S3 only", async () => {
    for (const env of ["staging", "prod"] as const) {
      const w = world({ env });
      floorFile(w, env);
      expect(await main(PUBLISH(env), w.deps), env).toBe(0);
      expect(r2Reads(w).map((e) => e.args)).toEqual([
        [
          "find-generic-password",
          "-a",
          "open-artifacts",
          "-s",
          `oa-hosted-${env}-r2`,
          "-w",
        ],
      ]);
      const puts = w.fake.r2Log.filter((e) => e.method === "PUT");
      expect(puts.length).toBeGreaterThan(0);
      expect(puts.every((e) => e.api === "s3")).toBe(true);
      expect(
        w.fake.log.filter(
          (e) => e.method === "PUT" && e.path.includes("/r2/buckets/"),
        ),
      ).toEqual([]);
      expect(w.fake.s3SignatureChecks).toBeGreaterThan(0);
    }
  });

  it("only publish commands read the R2 item", async () => {
    const w = world();
    expect(await main(STATUS(await created(w)), w.deps)).toBe(0);
    expect(r2Reads(w)).toEqual([]);
  });

  it("refuses the other env's R2 item: the service name is env-specific", async () => {
    for (const [env, other] of [
      ["staging", "prod"],
      ["prod", "staging"],
    ] as const) {
      const w = world({ env });
      floorFile(w, env);
      const v = w.keychain.get(`oa-hosted-${env}-r2`) as string;
      w.keychain.delete(`oa-hosted-${env}-r2`);
      w.keychain.set(`oa-hosted-${other}-r2`, v);
      expect(await main(PUBLISH(env), w.deps)).toBe(1);
      expect(lastLine(w)).toMatchObject({ step: "token", status: "error" });
      expect(lastLine(w).message).toBe(
        `keychain item oa-hosted-${env}-r2 not found`,
      );
      expect(r2Reads(w).map((e) => e.args[e.args.indexOf("-s") + 1])).toEqual([
        `oa-hosted-${env}-r2`,
      ]);
      expect(w.fake.r2Log).toEqual([]);
      expect(w.fake.writes()).toEqual([]);
    }
  });

  it("a staging client holding the prod R2 token is denied by R2's bucket scope", async () => {
    const w = world();
    floorFile(w);
    const prod = w.fake.r2Token("oa-p-releases");
    w.keychain.set(
      "oa-hosted-staging-r2",
      `${prod.accessKeyId}:${prod.secretAccessKey}`,
    );
    expect(await main(PUBLISH(), w.deps)).toBe(1);
    expect(lastLine(w).step).toBe("audit");
    const line = w.parsed().find((l) => l.step === "publish-floor");
    expect(line?.message).toMatch(/AccessDenied/);
    expect(w.fake.r2Objects.get("oa-s-releases")?.size ?? 0).toBe(0);
    expect(w.lines.join("\n")).not.toContain(prod.secretAccessKey);
    expect(w.lines.join("\n")).not.toContain(prod.accessKeyId);
  });

  it("a malformed R2 item is refused before any call", async () => {
    for (const bad of ["nocolon", ":secret", "key:", "a b:c", "k:s"]) {
      const w = world();
      floorFile(w);
      w.keychain.set("oa-hosted-staging-r2", bad);
      expect(await main(PUBLISH(), w.deps), bad).toBe(1);
      expect(lastLine(w).message).toMatch(
        /oa-hosted-staging-r2\) are not <accessKeyId>:<secretAccessKey>/,
      );
      expect(w.fake.r2Log).toEqual([]);
    }
  });

  it("prod reads R2 only from the keychain; staging CI reads a 0600 file it owns via OA_HOSTED_R2_FILE", async () => {
    const p = world({ env: "prod" });
    floorFile(p, "prod");
    p.files.set("/ci/r2", {
      bytes: new TextEncoder().encode(
        p.keychain.get("oa-hosted-prod-r2") as string,
      ),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    p.deps.env.OA_HOSTED_R2_FILE = "/ci/r2";
    expect(await main(PUBLISH("prod"), p.deps)).toBe(1);
    expect(lastLine(p).message).toMatch(
      /prod reads its R2 credentials only from the keychain; unset OA_HOSTED_R2_FILE/,
    );
    expect(p.fake.r2Log).toEqual([]);

    const w = world({ ci: true });
    floorFile(w);
    const r2 = w.keychain.get("oa-hosted-staging-r2") as string;
    w.keychain.clear();
    w.files.set("/ci/token", {
      bytes: new TextEncoder().encode(w.fake.token),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    w.deps.env.OA_HOSTED_TOKEN_FILE = "/ci/token";
    // CI without the R2 file: no keychain to fall back to.
    expect(await main(PUBLISH(), w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(/set OA_HOSTED_R2_FILE/);
    w.deps.env.OA_HOSTED_R2_FILE = "/ci/r2";
    for (const f of [
      { info: { mode: 0o100644, uid: 501, isFile: true }, re: /0600/ },
      { info: { mode: 0o100600, uid: 0, isFile: true }, re: /owned/ },
      {
        info: { mode: 0o100600, uid: 501, isFile: true },
        symlink: true,
        re: /symlink/,
      },
    ]) {
      w.files.set("/ci/r2", {
        bytes: new TextEncoder().encode(r2),
        info: f.info,
        ...(f.symlink ? { symlink: true } : {}),
      });
      expect(await main(PUBLISH(), w.deps)).toBe(1);
      expect(lastLine(w).message).toMatch(f.re);
      expect(lastLine(w).message).toMatch(/OA_HOSTED_R2_FILE/);
    }
    expect(w.fake.r2Log).toEqual([]);
    w.files.set("/ci/r2", {
      bytes: new TextEncoder().encode(`${r2}\n`),
      info: { mode: 0o100600, uid: 501, isFile: true },
    });
    expect(await main(PUBLISH(), w.deps)).toBe(0);
    expect(w.execs.filter((e) => e.file === SECURITY)).toEqual([]);
  });

  it("neither half appears in stdout, stderr, argv, stdin or the audit, even when an error echoes them", async () => {
    const w = world();
    floorFile(w);
    expect(await main(PUBLISH(), w.deps)).toBe(0);
    const first = [...w.lines];
    w.lines.length = 0;
    // An R2 error that echoes both halves is redacted.
    const real = w.deps.r2;
    w.deps.r2 = (o) => {
      const c = real(o);
      return {
        ...c,
        put: async () => {
          throw new Error(
            `denied for ${o.credentials.accessKeyId} / ${o.credentials.secretAccessKey}`,
          );
        },
      };
    };
    expect(await main(PUBLISH(), w.deps)).toBe(1);
    const msg = w.parsed().find((l) => l.step === "publish-floor")?.message;
    expect(msg).toBe("denied for [redacted] / [redacted]");
    const seen = [
      ...first,
      ...w.lines,
      ...w.errLines,
      ...w.execs.flatMap((e) => e.args),
      JSON.stringify(w.db().prepare("SELECT * FROM hosted_audit").all()),
    ].join("\n");
    for (const v of halves(w)) {
      expect(v.length).toBeGreaterThan(8);
      expect(seen).not.toContain(v);
    }
  });
});

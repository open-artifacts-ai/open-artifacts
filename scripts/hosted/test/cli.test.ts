// P1 Task 8: the oa:hosted CLI against provision's in-memory Cloudflare.
// No live call: the keychain, git and gh are stubs (world.ts).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, DOMAINS, HELP, main } from "../src/cli.ts";
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

const noCalls = (w: W) => {
  expect(w.cfCalls).toEqual([]);
  expect(w.execs).toEqual([]);
  expect(w.fake.log).toEqual([]);
};
const lastLine = (w: W) => w.parsed().at(-1);

async function created(w: W) {
  expect(await main(CREATE(w.env), w.deps)).toBe(0);
  const id = w.parsed().find((l) => l.step === "create")?.data?.id as string;
  expect(id).toMatch(/^i[a-z0-9]{11}$/);
  w.lines.length = 0;
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
  it("--test-hooks with --env prod exits 1 before any call", async () => {
    const w = world({ env: "prod" });
    expect(await main([...CREATE("prod"), "--test-hooks"], w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
    expect(lastLine(w).message).toMatch(/--test-hooks/);
    noCalls(w);
  });

  it.each([
    ["delete", []],
    ["delete", ["--confirm", "iaaaaaaaaaab"]],
    ["release-lease", []],
    ["release-lease", ["--confirm", "iaaaaaaaaaab"]],
  ])(
    "%s without --confirm, or with a different id, exits 1 before any call",
    async (cmd, extra) => {
      const w = world();
      const argv = [
        cmd,
        "--env",
        "staging",
        "--install",
        "iaaaaaaaaaaa",
        ...extra,
      ];
      expect(await main(argv, w.deps)).toBe(1);
      expect(lastLine(w).message).toMatch(/--confirm/);
      noCalls(w);
    },
  );

  it.each([
    [["status"]],
    [["status", "--env", "dev", "--install", "iaaaaaaaaaaa"]],
    [["nope", "--env", "staging"]],
    [["upgrade", "--env", "staging", "--install", "iaaaaaaaaaaa"]],
    [
      [
        "create",
        "--env",
        "staging",
        "--slug",
        "x",
        "--owner",
        "a@b.co",
        "--to",
        "latest",
      ],
    ],
    [[...CREATE(), "--var", "AUTH_DOMAIN_JOIN=member"]],
    [[...CREATE(), "--var", "lower=x"]],
    [[...CREATE(), "--var", "FEATURES=spaces", "--var", "FEATURES=x"]],
    [["publish-release", "--env", "staging", "--tag", "main"]],
    [["status", "--env", "staging", "--install", "../etc"]],
  ])("bad flags exit 1 before any call: %j", async (argv) => {
    const w = world();
    expect(await main(argv, w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
    noCalls(w);
  });

  it("every documented command is accepted", () => {
    expect(COMMANDS).toEqual([
      "create",
      "upgrade",
      "rollback",
      "update-vars",
      "delete",
      "release-lease",
      "status",
      "publish-release",
      "publish-floor",
      "turnstile-init",
    ]);
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
    const sec = w.execs.filter((e) => e.file === SECURITY);
    expect(sec.length).toBeGreaterThan(0);
    expect(sec[0]?.args).toEqual([
      "find-generic-password",
      "-w",
      "-s",
      "oa-hosted-prod",
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
      expect(await main(CREATE(), w.deps)).toBe(1);
      expect(lastLine(w).step).toBe("token");
    }
    expect(w.fake.log).toEqual([]);
    set(0o100600);
    expect(await main(CREATE(), w.deps)).toBe(0);
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
      expect(await main(CREATE(), w.deps)).toBe(1);
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
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      await main(
        ["upgrade", "--env", "staging", "--install", id, "--to", "0.22.0"],
        w.deps,
      ),
    ).toBe(1);
    expect(w.audit()).toEqual([
      { actor: ACTOR, install_id: "-", action: "cli.create.start" },
      { actor: ACTOR, install_id: id, action: "cli.create.done" },
      { actor: ACTOR, install_id: id, action: "cli.status.start" },
      { actor: ACTOR, install_id: id, action: "cli.status.done" },
      { actor: ACTOR, install_id: id, action: "cli.upgrade.start" },
      { actor: ACTOR, install_id: id, action: "cli.upgrade.failed" },
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
    w.deps.execFile = async (f, a, o) => (f === "git" ? "" : exec(f, a, o));
    expect(await main(CREATE(), w.deps)).toBe(1);
    expect(lastLine(w).message).toMatch(/user\.email/);
    expect(w.fake.log).toEqual([]);
  });
});

describe("output", () => {
  it("no secret or PAT value appears in stdout", async () => {
    const w = world();
    await created(w);
    const id = await (async () => {
      // A second create, with the full output kept this time.
      expect(
        await main(
          [
            "create",
            "--env",
            "staging",
            "--slug",
            "acme",
            "--owner",
            "owner@acme.test",
            "--to",
            "0.23.0",
            "--var",
            "FEATURES=spaces",
          ],
          w.deps,
        ),
      ).toBe(0);
      return w.parsed().find((l) => l.step === "create")?.data?.id as string;
    })();
    const out = w.lines.join("\n");
    for (const l of w.lines) expect(() => JSON.parse(l)).not.toThrow();
    const generated = new Set<string>([w.fake.token]);
    for (const s of w.fake.scripts.values())
      for (const v of s.secrets.values()) generated.add(v);
    const patDir = join(w.home, ".open-artifacts", "hosted-staging");
    for (const f of readdirSync(patDir))
      generated.add(readFileSync(join(patDir, f), "utf8").trim());
    expect(generated.size).toBeGreaterThan(3);
    for (const v of generated) {
      expect(v.length).toBeGreaterThan(8);
      expect(out).not.toContain(v);
    }
    expect(out).not.toMatch(/oa_pat_[1-9A-HJ-NP-Za-km-z]{8}/);
    expect(w.parsed().find((l) => l.step === "create")?.data).toMatchObject({
      id,
      slug: "acme",
      appHost: "acme.open-artifacts-staging.app",
    });
  });

  it("a token Cloudflare echoes in an error is redacted", async () => {
    const w = world();
    w.fake.inject((_m, p) => p === "/user/tokens/verify", {
      status: 400,
      message: `bad token ${w.fake.token}`,
      times: 1,
    });
    expect(await main(CREATE(), w.deps)).toBe(1);
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

  it("upgrade, rollback, update-vars and release-lease go through the provisioner", async () => {
    const w = world();
    const id = await created(w);
    expect(
      await main(
        ["upgrade", "--env", "staging", "--install", id, "--to", "0.24.0"],
        w.deps,
      ),
    ).toBe(0);
    expect(w.parsed().find((l) => l.step === "upgrade")?.data).toMatchObject({
      from: "0.23.0",
      to: "0.24.0",
      ok: true,
    });
    expect(
      await main(["rollback", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      await main(
        [
          "update-vars",
          "--env",
          "staging",
          "--install",
          id,
          "--var",
          "FEATURES=spaces",
        ],
        w.deps,
      ),
    ).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "update-vars")?.data,
    ).toMatchObject({
      ok: true,
    });
    // No lease is held: release-lease is the provisioner's refusal.
    expect(
      await main(
        ["release-lease", "--env", "staging", "--install", id, "--confirm", id],
        w.deps,
      ),
    ).toBe(1);
    expect(lastLine(w).message).toMatch(/after row/);
    expect(w.parsed().find((l) => l.step === "release-lease")?.message).toMatch(
      /holds no lease/,
    );
  });

  it("delete with the matching --confirm deletes the install", async () => {
    const w = world();
    const id = await created(w);
    expect(
      await main(
        ["delete", "--env", "staging", "--install", id, "--confirm", id],
        w.deps,
      ),
    ).toBe(0);
    expect(w.parsed().find((l) => l.step === "delete")?.data).toEqual({
      id,
      ok: true,
      state: "deleted",
    });
  });

  it("create with --test-hooks on staging uses the redline bundle", async () => {
    const w = world();
    expect(
      await main(
        [...CREATE(), "--test-hooks", "--var", "TEST_DOMAIN=redline.test"],
        w.deps,
      ),
    ).toBe(0);
    const sc = [...w.fake.scripts.values()][0];
    expect(
      new TextDecoder().decode(sc?.modules.get("index.js")?.bytes),
    ).toContain("hooksAllowed = true");
    expect(sc?.secrets.has("TEST_HOOK_KEY")).toBe(true);
  });

  it("turnstile-init creates the env's widget once and stores it in the keychain over stdin", async () => {
    const w = world();
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(0);
    const [wd] = [...w.fake.turnstile.values()];
    expect(w.keychain.get("oa-hosted-staging-turnstile")).toBe(
      `${wd?.sitekey}:${wd?.secret}`,
    );
    for (const e of w.execs)
      expect(e.args.join(" ")).not.toContain(String(wd?.secret));
    expect(w.lines.join("\n")).not.toContain(String(wd?.secret));
    expect(w.parsed().find((l) => l.step === "turnstile-init")?.data).toEqual({
      created: true,
      stored: true,
    });
    w.lines.length = 0;
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(0);
    expect(w.parsed().find((l) => l.step === "turnstile-init")?.data).toEqual({
      created: false,
      stored: false,
    });
    expect(lastLine(w)).toMatchObject({ step: "audit" });
    expect(w.fake.turnstile.size).toBe(1);
  });

  it("turnstile-init refuses a same-named widget that differs", async () => {
    const w = world();
    w.fake.turnstile.set("0xEXISTING", {
      sitekey: "0xEXISTING",
      name: "oa-s-turnstile",
      domains: ["example.com"],
      mode: "managed",
      secret: "0xexisting-secret",
    });
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "turnstile-init")?.message,
    ).toMatch(/differs/);
    expect(w.fake.turnstile.size).toBe(1);
  });

  it("create with codes on reads the env's Turnstile keys from the keychain", async () => {
    const w = world();
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(0);
    expect(
      await main([...CREATE(), "--var", "AUTH_PROVIDERS=email"], w.deps),
    ).toBe(0);
    const [wd] = [...w.fake.turnstile.values()];
    const s = [...w.fake.scripts.values()][0];
    expect(s?.secrets.get("TURNSTILE_SECRET")).toBe(wd?.secret);
    expect(w.lines.join("\n")).not.toContain(String(wd?.secret));
  });

  it("publish-release downloads the env's tar and .sig.json with gh, then hands them to publishRelease", async () => {
    const w = world();
    const exec = w.deps.execFile;
    let dir = "";
    w.deps.execFile = async (f, a, o) => {
      if (f !== "gh") return exec(f, a, o);
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

  it("release-lease --force releases a live lease; --force elsewhere is refused before any call", async () => {
    const w = world();
    const id = await created(w);
    w.db()
      .prepare("UPDATE installs SET lease = 'x', lease_until = ? WHERE id = ?")
      .run(Date.parse("2026-10-27T00:00:00Z"), id);
    const rl = [
      "release-lease",
      "--env",
      "staging",
      "--install",
      id,
      "--confirm",
      id,
    ];
    expect(await main(rl, w.deps)).toBe(1);
    expect(w.parsed().find((l) => l.step === "release-lease")?.message).toMatch(
      /has not expired/,
    );
    w.lines.length = 0;
    expect(await main([...rl, "--force"], w.deps)).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "release-lease")?.data,
    ).toMatchObject({
      released: true,
      forced: true,
    });
    const v = world();
    expect(
      await main(
        ["status", "--env", "staging", "--install", id, "--force"],
        v.deps,
      ),
    ).toBe(1);
    expect(lastLine(v).message).toMatch(/--force is for release-lease only/);
    noCalls(v);
  });

  it("keychain calls use /usr/bin/security, never a PATH lookup", async () => {
    const w = world();
    await created(w);
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(0);
    const sec = w.execs.filter((e) => /security/.test(e.file));
    expect(sec.length).toBeGreaterThan(2);
    for (const e of sec) expect(e.file).toBe("/usr/bin/security");
  });

  it("turnstile-init reads the keychain item back: a write that did not land is an error", async () => {
    const w = world({ keychainWriteNoop: true });
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "turnstile-init")?.message,
    ).toMatch(/keychain item oa-hosted-staging-turnstile did not store/);
  });

  it("a create that fails after its id is minted writes the failed row under that id", async () => {
    const w = world();
    w.fake.inject((m, p) => m === "PUT" && /\/scripts\/oa-s-[^/]+$/.test(p), {
      status: 400,
      times: 5,
    });
    expect(await main(CREATE(), w.deps)).toBe(1);
    const id = (
      w
        .db()
        .prepare("SELECT id FROM installs WHERE slug = 'finqore'")
        .get() as {
        id: string;
      }
    ).id;
    expect(w.audit().map((r) => [r.install_id, r.action])).toEqual([
      ["-", "cli.create.start"],
      [id, "cli.create.failed"],
    ]);
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
    [["turnstile-init", "--env", "staging", "--install", "iaaaaaaaaaaa"]],
    [[...CREATE(), "--var", "NOT_A_VAR=1"]],
  ])("refused at parse, before any call: %j", async (argv) => {
    const w = world();
    expect(await main(argv, w.deps)).toBe(1);
    expect(lastLine(w)).toMatchObject({ step: "args", status: "error" });
    noCalls(w);
  });
});

describe("broker: on exactly when the vars turn google on", () => {
  const GOOGLE = [
    "--var",
    "AUTH_PROVIDERS=google",
    "--var",
    "AUTH_DOMAINS=finqore.test",
  ];
  const entry = (w: W, kv: string, id: string) =>
    w.fake.kvValues(kv).get(`install:${id}`);
  const idOf = (w: W, step: string) =>
    w.parsed().find((l) => l.step === step)?.data?.id as string;

  it("create with google registers the install with the broker (both registry copies, the signing key)", async () => {
    const w = world();
    expect(await main([...CREATE(), ...GOOGLE], w.deps)).toBe(0);
    const id = idOf(w, "create");
    const reg = entry(w, w.regId, id);
    expect(reg).toBeDefined();
    expect(entry(w, w.dirId, id)).toBe(reg);
    expect(JSON.parse(String(reg))).toMatchObject({
      installId: id,
      origin: "https://finqore.open-artifacts-staging.app",
      domains: ["finqore.test"],
    });
    const script = [...w.fake.scripts.values()][0];
    expect(script?.secrets.has("BROKER_SIGNING_KEY")).toBe(true);
    // provision derives the env's broker URL; the operator never types it.
    expect(
      (
        (script?.metadata.bindings ?? []) as { name: string; text?: string }[]
      ).find((b) => b.name === "AUTH_BROKER_URL")?.text,
    ).toBe("https://auth.open-artifacts-staging.app");
    expect(
      (
        (script?.metadata.bindings ?? []) as { name: string; text?: string }[]
      ).find((b) => b.name === "GOOGLE_CLIENT_ID")?.text,
    ).toBe(
      "1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com",
    );

    // update-vars keeps the registry in step (the broker stays on).
    w.lines.length = 0;
    const next = GOOGLE.map((v) =>
      v === "AUTH_DOMAINS=finqore.test"
        ? "AUTH_DOMAINS=finqore.test,fq.test"
        : v,
    );
    expect(
      await main(
        ["update-vars", "--env", "staging", "--install", id, ...next],
        w.deps,
      ),
    ).toBe(0);
    expect(JSON.parse(String(entry(w, w.regId, id))).domains).toEqual([
      "finqore.test",
      "fq.test",
    ]);
    expect(entry(w, w.dirId, id)).toBe(entry(w, w.regId, id));
  });

  it("status of a google install reads with the broker on: a missing entry is drift", async () => {
    const w = world();
    expect(await main([...CREATE(), ...GOOGLE], w.deps)).toBe(0);
    const id = idOf(w, "create");
    w.fake.kvValues(w.dirId).delete(`install:${id}`);
    w.lines.length = 0;
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.registryDrift,
    ).toEqual({
      id,
      kind: "missing_directory",
    });
  });

  it("create without google leaves the broker off: no registry entry, no signing key", async () => {
    const w = world();
    expect(await main([...CREATE(), "--var", "FEATURES=spaces"], w.deps)).toBe(
      0,
    );
    const id = idOf(w, "create");
    expect(entry(w, w.regId, id)).toBeUndefined();
    expect(entry(w, w.dirId, id)).toBeUndefined();
    expect(
      [...w.fake.scripts.values()][0]?.secrets.has("BROKER_SIGNING_KEY"),
    ).toBe(false);
    w.lines.length = 0;
    expect(
      await main(["status", "--env", "staging", "--install", id], w.deps),
    ).toBe(0);
    expect(
      w.parsed().find((l) => l.step === "status")?.data.registryDrift,
    ).toBeNull();
  });

  it("a google create needs both registry KVs, and refuses before any write without them", async () => {
    const w = world();
    w.fake.kv.delete(w.dirId);
    expect(await main([...CREATE(), ...GOOGLE], w.deps)).toBe(1);
    expect(w.parsed().find((l) => l.step === "create")?.message).toMatch(
      /directory registry KV/,
    );
    expect(w.fake.scripts.size).toBe(0);
  });
});

describe("--help", () => {
  it("prints the usage, every command and the extra flags, and makes no call", async () => {
    const w = world();
    expect(await main(["--help"], w.deps)).toBe(0);
    const out = w.lines.join("\n");
    expect(out).toBe(HELP);
    for (const c of COMMANDS) expect(out).toContain(c);
    for (const f of [
      "--tag",
      "--floor",
      "--force",
      "--confirm",
      "--test-hooks",
      "--var",
    ])
      expect(out).toContain(f);
    expect(out).toContain("CLOUDFLARE_ACCOUNT_ID");
    noCalls(w);
  });
});

describe("output, with every generated value in play", () => {
  it("no secret, PAT or broker key appears in stdout for a google + codes create", async () => {
    const w = world();
    expect(await main(["turnstile-init", "--env", "staging"], w.deps)).toBe(0);
    expect(
      await main(
        [
          ...CREATE(),
          "--var",
          "AUTH_PROVIDERS=email,google",
          "--var",
          "AUTH_DOMAINS=finqore.test",
        ],
        w.deps,
      ),
    ).toBe(0);
    const sc = [...w.fake.scripts.values()][0];
    for (const k of [
      "BROKER_SIGNING_KEY",
      "TURNSTILE_SECRET",
      "SESSION_SECRET",
    ])
      expect(sc?.secrets.has(k), k).toBe(true);
    const generated = new Set<string>([
      w.fake.token,
      ...(sc?.secrets.values() ?? []),
    ]);
    const patDir = join(w.home, ".open-artifacts", "hosted-staging");
    for (const f of readdirSync(patDir))
      generated.add(readFileSync(join(patDir, f), "utf8").trim());
    const out = w.lines.join("\n");
    for (const v of generated) {
      expect(v.length).toBeGreaterThan(8);
      expect(out).not.toContain(v);
    }
  });
});

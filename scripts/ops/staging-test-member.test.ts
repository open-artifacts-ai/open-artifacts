import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  ADMIN_EMAIL,
  APP_HOST,
  COOKIE,
  type Deps,
  EMAIL,
  HELP,
  MCP_BASE,
  MCP_URL,
  main,
  parseArgs,
  parseMintLog,
  parseRevokeLog,
  SEAL_INFO,
  SESSION_MAX_AGE_MS,
  storageState,
  WORKFLOW,
  writeMcpConfig,
} from "./staging-test-member.ts";

// The agent's side of the rl-agents member sign-in, and the workflow that
// takes its credentials. gh and fetch are mocked; nothing leaves the machine.

const root = join(import.meta.dirname, "../..");
const wfText = readFileSync(join(root, ".github/workflows", WORKFLOW), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
const w: any = parse(wfText);
const job = w.jobs.creds;
const step = job.steps[0];
const run = step.run as string;

describe("staging-test-member.yml", () => {
  it("is dispatch only, in the redline-staging Environment, with id-token on the job only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(w.on.workflow_dispatch.inputs)).toEqual([
      "recipient_key",
      "revoke",
    ]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("redline-staging");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.steps).toHaveLength(1);
  });

  it("reads no secret, checks out nothing, and takes inputs through env only", () => {
    expect(wfText).not.toMatch(/\$\{\{\s*secrets\./);
    expect(wfText).not.toContain("actions/checkout");
    expect(run).not.toContain("${{");
    expect(step.env.RECIPIENT_KEY).toBe("${{ inputs.recipient_key }}");
    expect(step.env.REVOKE).toBe("${{ inputs.revoke }}");
  });

  it("targets the staging API, rl-agents and its app host only", () => {
    expect(step.env.AUDIENCE).toBe("https://api.open-artifacts-staging.app");
    expect(step.env.SLUG).toBe("rl-agents");
    expect(step.env.APP_HOST).toBe(APP_HOST);
  });

  it("calls exactly R2, R26 and R15, the JWT on stdin", () => {
    const calls = [...run.matchAll(/\bapi (GET|POST) "([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(calls).toEqual([
      "GET /v1/installs?q=$SLUG",
      "POST /v1/installs/$id/redline-creds",
      "GET /v1/jobs/$job",
    ]);
    expect(run.match(/curl -fsS -K -/g)).toHaveLength(2);
    expect(run).not.toMatch(/Authorization: Bearer \$jwt/);
  });

  it("prints only the job id, the app host, the sealed value or the revoke line", () => {
    const echoes = run
      .split("\n")
      .filter((l) => /^\s*echo /.test(l) && !l.includes("exit 1"));
    expect(echoes.map((l) => l.trim())).toEqual([
      'echo "test-member-job: $job"',
      'echo "test-member-revoked: $SLUG"',
      'echo "test-member-app-host: $host"',
      'echo "test-member-sealed: $sealed"',
    ]);
  });

  describe("the guards run before any network call", () => {
    let bin: string;
    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), "oa-tm-wf-"));
      // A curl that records it was reached and fails.
      writeFileSync(
        join(bin, "curl"),
        `#!/bin/sh\ntouch "${bin}/reached"\nexit 99\n`,
      );
      chmodSync(join(bin, "curl"), 0o755);
    });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));
    const sh = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", run], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://fake.invalid/?x=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-request-token",
          ...step.env,
          RECIPIENT_KEY: `${"A".repeat(42)}A`,
          REVOKE: "false",
          RUN_ID: "1",
          RUN_ATTEMPT: "1",
          ...env,
        },
        encoding: "utf8",
      });

    it("any ref but main fails", () => {
      for (const ref of [
        "refs/heads/feature",
        "refs/heads/main2",
        "refs/tags/v1",
        "refs/pull/1/merge",
        "",
      ]) {
        const r = sh({ REF: ref });
        expect(r.status, ref).toBe(1);
        expect(r.stdout, ref).toContain("dispatch staging-test-member on main");
        expect(existsSync(join(bin, "reached")), ref).toBe(false);
      }
    });

    it("a bad key on a mint, or a revoke that is not a boolean, fails", () => {
      for (const k of ["", "short", `${"A".repeat(42)}B`, "x y"]) {
        const r = sh({ REF: "refs/heads/main", RECIPIENT_KEY: k });
        expect(r.status, k).toBe(1);
        expect(r.stdout).toContain("recipient_key is not");
      }
      const r = sh({ REF: "refs/heads/main", REVOKE: "yes" });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("revoke is true or false");
      expect(existsSync(join(bin, "reached"))).toBe(false);
    });

    it("on main with a good key it goes on to the network (the guard is not always failing)", () => {
      const r = sh({ REF: "refs/heads/main" });
      expect(r.status).not.toBe(0);
      expect(existsSync(join(bin, "reached"))).toBe(true);
    });
  });
});

describe("parseArgs", () => {
  it("member by default; --role member|admin, --mcp, --revoke and --help, nothing else", () => {
    expect(parseArgs([])).toEqual({
      revoke: false,
      help: false,
      role: "member",
      mcp: false,
    });
    expect(parseArgs(["--revoke"])).toMatchObject({ revoke: true });
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
    expect(parseArgs(["--role", "admin"])).toMatchObject({ role: "admin" });
    expect(parseArgs(["--role=admin"])).toMatchObject({ role: "admin" });
    expect(parseArgs(["--role", "member"])).toMatchObject({ role: "member" });
    expect(parseArgs(["--mcp", "--role", "admin"])).toMatchObject({
      role: "admin",
      mcp: true,
    });
    for (const a of [
      ["--role", "owner"],
      ["--role=owner"],
      ["--role", "Owner"],
      ["--role", "ADMIN"],
      ["--role", "viewer"],
      ["--role", ""],
      ["--role=", "admin"],
      ["--role"],
      ["--role", "admin", "--role", "member"],
      ["--revoke", "--mcp"],
      ["--revoke", "--role", "member"],
      ["--slug", "rl-a"],
      ["extra"],
    ])
      expect(parseArgs(a), a.join(" ")).toBeInstanceOf(Error);
  });

  it("the help says a mint cuts off earlier credentials and MCP agents, how to revoke, and to delete the files", () => {
    expect(HELP).toContain("cuts off");
    expect(HELP).toContain("--revoke");
    expect(HELP).toContain("--role member|admin");
    expect(HELP).toContain("--mcp");
    expect(HELP).toContain("disconnects an MCP agent");
    expect(HELP).toContain("is not cut off");
    expect(HELP).toContain("Delete the storage-state files and\nMCP configs");
    expect(HELP).not.toContain("—");
  });
});

describe("writeMcpConfig", () => {
  const repoTmp = () => mkdtempSync(join(root, "scripts/ops/.oa-tm-mcp-"));
  it("refuses a base inside this repo, writing nothing", () => {
    const inRepo = repoTmp();
    try {
      for (const base of [inRepo, join(inRepo, "a/b")]) {
        expect(() => writeMcpConfig({ x: 1 }, base, "m.json")).toThrow(
          /inside the git work tree/,
        );
      }
      expect(readdirSync(inRepo)).toEqual([]);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  it("refuses a symlink outside that points into the repo", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-tm-link-"));
    const inRepo = repoTmp();
    try {
      symlinkSync(inRepo, join(out, "link"));
      expect(() =>
        writeMcpConfig({ x: 1 }, join(out, "link", "rl"), "m.json"),
      ).toThrow(/inside the git work tree/);
      expect(readdirSync(inRepo)).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  it("refuses inside any work tree, a worktree's .git file included", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-tm-wt-"));
    try {
      writeFileSync(join(out, ".git"), "gitdir: /elsewhere\n");
      expect(() =>
        writeMcpConfig({ x: 1 }, join(out, "deep"), "m.json"),
      ).toThrow(/inside the git work tree/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("never overwrites", () => {
    const out = mkdtempSync(join(tmpdir(), "oa-tm-ow-"));
    try {
      writeMcpConfig({ x: 1 }, join(out, "rl"), "m.json");
      expect(() => writeMcpConfig({ x: 2 }, join(out, "rl"), "m.json")).toThrow(
        /EEXIST/,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("the default base is under the home directory, outside this repo", () => {
    expect(MCP_BASE).toBe(join(homedir(), ".oa-redline", "rl-agents"));
    expect(MCP_BASE.startsWith(root)).toBe(false);
  });
});

describe("logs", () => {
  const line = (s: string) => `creds\tTake\t2026-11-03T06:00:00Z ${s}\n`;
  it("a mint log needs the sealed value, the job and rl-agents' host", () => {
    const ok =
      line("test-member-job: 01JOB") +
      line(`test-member-app-host: ${APP_HOST}`) +
      line("test-member-sealed: oa-seal-v1.a.b.c");
    expect(parseMintLog(ok)).toEqual({
      sealed: "oa-seal-v1.a.b.c",
      job: "01JOB",
    });
    expect(parseMintLog(ok.replace(APP_HOST, "evil.example"))).toBeNull();
    expect(
      parseMintLog(ok.replace(APP_HOST, `${APP_HOST}.evil.example`)),
    ).toBeNull();
    expect(parseMintLog("nothing here")).toBeNull();
  });
  // gh run view --log prints the step's script (in ANSI color) before its
  // output, so every marker first appears with a shell variable after it.
  const script = (s: string) => line(`\x1b[36;1m${s}\x1b[0m`);
  const echoed =
    script('echo "test-member-job: $job"') +
    script('if [ "$REVOKE" = "true" ]; then') +
    script('  echo "test-member-revoked: $SLUG"') +
    script("fi") +
    script('echo "test-member-app-host: $host"') +
    script('echo "test-member-sealed: $sealed"');
  it("a real mint log: the echoed script comes first, the output wins", () => {
    const log =
      echoed +
      line("test-member-job: 01M6KQ1W6RZNKFJT1JTJFB9RWK") +
      line(`test-member-app-host: ${APP_HOST}`) +
      line("test-member-sealed: oa-seal-v1.aGVsbG8.d29ybGQ.c2VhbGVk");
    expect(parseMintLog(log)).toEqual({
      sealed: "oa-seal-v1.aGVsbG8.d29ybGQ.c2VhbGVk",
      job: "01M6KQ1W6RZNKFJT1JTJFB9RWK",
    });
    expect(parseMintLog(echoed)).toBeNull();
    // Two different real values for one marker: trust neither.
    expect(
      parseMintLog(log + line("test-member-app-host: evil.example")),
    ).toBeNull();
    expect(parseMintLog(log + line("test-member-job: 01OTHER"))).toBeNull();
  });
  it("a real revoke log: the echoed script comes first, the output wins", () => {
    const log =
      echoed +
      line("test-member-job: 01M6KQ1W6RZNKFJT1JTJFB9RWK") +
      line("test-member-revoked: rl-agents");
    expect(parseRevokeLog(log)).toBe(true);
    expect(parseRevokeLog(echoed)).toBe(false);
    expect(
      parseRevokeLog(echoed + line("test-member-revoked: rl-agents")),
    ).toBe(false);
  });
  it("a marker must start a word and its value must end at whitespace", () => {
    const jobAndHost =
      line("test-member-job: 01JOB") +
      line(`test-member-app-host: ${APP_HOST}`);
    expect(
      parseMintLog(jobAndHost + line("xtest-member-sealed: oa-seal-v1.EVIL")),
    ).toBeNull();
    expect(
      parseRevokeLog(
        line("test-member-job: 01J") + line('test-member-revoked: rl-agents"'),
      ),
    ).toBe(false);
  });
  it("a CRLF log parses", () => {
    const crlf = (s: string) => line(s).replace("\n", "\r\n");
    expect(
      parseMintLog(
        crlf("test-member-job: 01JOB") +
          crlf(`test-member-app-host: ${APP_HOST}`) +
          crlf("test-member-sealed: oa-seal-v1.a.b.c"),
      ),
    ).toEqual({ sealed: "oa-seal-v1.a.b.c", job: "01JOB" });
    expect(
      parseRevokeLog(
        crlf("test-member-job: 01JOB") + crlf("test-member-revoked: rl-agents"),
      ),
    ).toBe(true);
  });
  it("a revoke log names rl-agents and a job", () => {
    expect(
      parseRevokeLog(
        line("test-member-job: 01JOB") + line("test-member-revoked: rl-agents"),
      ),
    ).toBe(true);
    expect(parseRevokeLog(line("test-member-revoked: rl-agents"))).toBe(false);
    expect(
      parseRevokeLog(
        line("test-member-job: 01JOB") + line("test-member-revoked: rl-a"),
      ),
    ).toBe(false);
  });
});

it("the storage state holds one Secure, HttpOnly, Lax session cookie for rl-agents", () => {
  expect(storageState("fake-cookie", 1793600000000)).toEqual({
    cookies: [
      {
        name: COOKIE,
        value: "fake-cookie",
        domain: APP_HOST,
        path: "/",
        expires: 1793600000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  });
});

/** R26's sealer, re-done with node:crypto for the test (see seal.ts). */
function sealTo(recipientX: string, plain: string): string {
  const eph = generateKeyPairSync("x25519");
  const epk = Buffer.from(
    eph.publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  );
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: recipientX },
      format: "jwk",
    }),
  });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([epk, Buffer.from(recipientX, "base64url")]),
      SEAL_INFO,
      32,
    ),
  );
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    c.update(plain, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]);
  return ["oa-seal-v1", epk, iv, ct]
    .map((x) => (typeof x === "string" ? x : x.toString("base64url")))
    .join(".");
}

describe("main, with gh and fetch mocked", () => {
  const FAKE_PAT = "oa_pat_FAKE_NOT_A_REAL_TOKEN";
  const FAKE_HOOK = "fake-hook-key-not-real";
  const NOW = 1_793_600_000_000;
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "oa-tm-main-"));
    home = mkdtempSync(join(tmpdir(), "oa-tm-home-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function deps(o: { host?: string; revoke?: boolean; noPat?: boolean } = {}) {
    const lines: string[] = [];
    const ghCalls: string[][] = [];
    const fetchCalls: { url: string; init: RequestInit }[] = [];
    let key = "";
    const gh = vi.fn(async (...a: string[]) => {
      ghCalls.push(a);
      if (a[0] === "workflow") {
        const f = a.find((x) => x.startsWith("recipient_key="));
        key = f ? f.slice("recipient_key=".length) : "";
        return "";
      }
      if (a[0] === "run" && a[1] === "list") return "4242\n";
      if (a[0] === "run" && a[1] === "watch") return "";
      if (a[0] === "run" && a[1] === "view") {
        if (o.revoke)
          return "x test-member-job: 01JOB\nx test-member-revoked: rl-agents\n";
        const sealed = sealTo(
          key,
          JSON.stringify(
            o.noPat
              ? { hookKey: FAKE_HOOK }
              : { pat: FAKE_PAT, hookKey: FAKE_HOOK },
          ),
        );
        return `x test-member-job: 01JOB\nx test-member-app-host: ${o.host ?? APP_HOST}\nx test-member-sealed: ${sealed}\n`;
      }
      throw new Error(`unexpected gh ${a.join(" ")}`);
    });
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ cookie: "fake-session-cookie" }), {
          status: 200,
        });
      },
    ) as unknown as typeof fetch;
    const d: Deps = {
      gh,
      fetch: fetchMock,
      now: () => NOW,
      sleep: async () => {},
      tmp,
      mcpBase: join(home, ".oa-redline", "rl-agents"),
      log: (l) => lines.push(l),
    };
    return { d, lines, ghCalls, fetchCalls };
  }

  it("mints: dispatches on main with the public key, opens the seal, asks rl-agents for a member session, writes one 0600 file and prints only its path", async () => {
    const { d, lines, ghCalls, fetchCalls } = deps();
    expect(await main([], d)).toBe(0);
    const dispatch = ghCalls[0] as string[];
    expect(dispatch.slice(0, 7)).toEqual([
      "workflow",
      "run",
      WORKFLOW,
      "-R",
      "open-artifacts-ai/open-artifacts",
      "--ref",
      "main",
    ]);
    expect(dispatch).toContain("revoke=false");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`https://${APP_HOST}/__test/session`);
    expect(
      (fetchCalls[0]?.init.headers as Record<string, string> | undefined)
        ?.authorization,
    ).toBe(`Bearer ${FAKE_HOOK}`);
    expect(JSON.parse(String(fetchCalls[0]?.init.body))).toEqual({
      email: EMAIL,
      role: "member",
    });

    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] as string);
    expect(out).toEqual({
      storageState: expect.any(String),
      expiresAt: NOW + SESSION_MAX_AGE_MS,
      run: "4242",
    });
    expect(statSync(out.storageState).mode & 0o777).toBe(0o600);
    expect(statSync(join(out.storageState, "..")).mode & 0o777).toBe(0o700);
    const state = readFileSync(out.storageState, "utf8");
    expect(JSON.parse(state).cookies[0].value).toBe("fake-session-cookie");
    // Neither the PAT nor the hook key is printed or written anywhere.
    for (const secret of [FAKE_PAT, FAKE_HOOK]) {
      expect(lines.join("\n")).not.toContain(secret);
      expect(state).not.toContain(secret);
    }
    const written = readdirSync(tmp, { recursive: true }) as string[];
    expect(written.sort()).toEqual(
      [
        out.storageState.slice(tmp.length + 1).split("/")[0],
        out.storageState.slice(tmp.length + 1),
      ].sort(),
    );
  });

  it("a log naming another host: no fetch, no file", async () => {
    const { d, fetchCalls } = deps({ host: "evil.example" });
    await expect(main([], d)).rejects.toThrow(/no sealed credentials/);
    expect(fetchCalls).toHaveLength(0);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("a refused session hook: no file", async () => {
    const { d } = deps();
    d.fetch = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(main([], d)).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("--revoke dispatches revoke=true with no key, calls no install, writes nothing", async () => {
    const { d, lines, ghCalls, fetchCalls } = deps({ revoke: true });
    expect(await main(["--revoke"], d)).toBe(0);
    const dispatch = ghCalls[0] as string[];
    expect(dispatch).toContain("revoke=true");
    expect(dispatch.some((a) => a.startsWith("recipient_key="))).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(readdirSync(tmp)).toEqual([]);
    expect(JSON.parse(lines[0] as string)).toEqual({
      revoked: "rl-agents",
      run: "4242",
    });
  });

  it("bad arguments: exit 2, the help, no dispatch", async () => {
    for (const a of [["--role", "owner"], ["--role=superadmin"], ["--x"]]) {
      const { d, lines, ghCalls } = deps();
      expect(await main(a, d), a.join(" ")).toBe(2);
      expect(lines[0]).toContain("Usage:");
      expect(ghCalls).toHaveLength(0);
    }
  });

  it("--role admin asks rl-agents for an admin session as the admin address, not the member's", async () => {
    const { d, lines, fetchCalls } = deps();
    expect(await main(["--role", "admin"], d)).toBe(0);
    expect(JSON.parse(String(fetchCalls[0]?.init.body))).toEqual({
      email: ADMIN_EMAIL,
      role: "admin",
    });
    expect(ADMIN_EMAIL).not.toBe(EMAIL);
    const out = JSON.parse(lines[0] as string);
    expect(statSync(out.storageState).mode & 0o777).toBe(0o600);
    expect(out.mcpConfig).toBeUndefined();
    expect(existsSync(join(home, ".oa-redline"))).toBe(false);
  });

  it("--mcp writes the PAT to a 0600 config in a 0700 directory outside the repo; stdout and stderr never hold it", async () => {
    const { d, lines } = deps();
    const out$ = vi.spyOn(process.stdout, "write");
    const err$ = vi.spyOn(process.stderr, "write");
    const con = (["log", "error", "warn", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m),
    );
    try {
      expect(await main(["--mcp", "--role", "admin"], d)).toBe(0);
      const printed = [
        ...lines,
        ...out$.mock.calls.map((c) => String(c[0])),
        ...err$.mock.calls.map((c) => String(c[0])),
        ...con.flatMap((s) => s.mock.calls.map((c) => c.join(" "))),
      ].join("\n");
      expect(printed).not.toContain(FAKE_PAT);
      expect(printed).not.toContain(FAKE_HOOK);
    } finally {
      for (const s of [out$, err$, ...con]) s.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0] as string);
    expect(Object.keys(out).sort()).toEqual(
      ["expiresAt", "mcpConfig", "run", "storageState"].sort(),
    );
    const base = realpathSync(join(home, ".oa-redline", "rl-agents"));
    expect(dirname(out.mcpConfig)).toBe(base);
    expect(out.mcpConfig.startsWith(realpathSync(root))).toBe(false);
    expect(statSync(out.mcpConfig).mode & 0o777).toBe(0o600);
    expect(statSync(base).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(base)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(out.mcpConfig, "utf8"))).toEqual({
      mcpServers: {
        "oa-rl-agents": {
          type: "http",
          url: MCP_URL,
          headers: { Authorization: `Bearer ${FAKE_PAT}` },
        },
      },
    });
    expect(MCP_URL).toBe("https://rl-agents.open-artifacts-staging.app/mcp");
    // The storage state still holds neither secret.
    const state = readFileSync(out.storageState, "utf8");
    expect(state).not.toContain(FAKE_PAT);
    expect(state).not.toContain(FAKE_HOOK);
  });

  it("--mcp with a base inside the repo: refused before any dispatch, nothing written", async () => {
    const { d, ghCalls, fetchCalls } = deps();
    const inRepo = mkdtempSync(join(root, "scripts/ops/.oa-tm-mcp-"));
    try {
      d.mcpBase = join(inRepo, "rl-agents");
      await expect(main(["--mcp"], d)).rejects.toThrow(
        /inside the git work tree/,
      );
      expect(ghCalls).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
      expect(readdirSync(inRepo)).toEqual([]);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  it("--mcp with no PAT in the seal: an error naming no secret, no file", async () => {
    const { d, fetchCalls } = deps({ noPat: true });
    await expect(main(["--mcp"], d)).rejects.toThrow(
      /^the sealed credentials have no PAT$/,
    );
    expect(fetchCalls).toHaveLength(0);
    expect(readdirSync(tmp)).toEqual([]);
    expect(existsSync(join(home, ".oa-redline"))).toBe(false);
  });
});

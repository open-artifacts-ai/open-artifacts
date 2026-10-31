import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIENCES,
  jwtClaims,
  jwtSource,
  MINTED_FILE,
  mintJwt,
  REFRESH_MARGIN_S,
} from "../src/oidc.ts";
import {
  bringUpgrade,
  mintCreds,
  type Outcome,
  PROBES,
  ProbeFail,
  type ProbeId,
  provConfig,
  Run,
  revokeCreds,
} from "../src/provisioning.ts";
import { rawTargets } from "../src/provisioning-live.ts";
import { newRecipient, openSealed, parseCreds } from "../src/seal.ts";
import { parseProd, prodInventoryBearer } from "../src/targets.ts";
import { sealTo } from "./provisioner-seal.ts";
import {
  API_JWT,
  CONFIG,
  type FakeApi,
  type Fault,
  fakeApi,
  jwt,
} from "./provisioning-fake.ts";

// The probes, bring-up and revoke on the in-memory staging fake (no network,
// pinned clock). A conforming fake passes every probe; each fault below makes
// one probe fail. Only the probes listed in the fault cases are shown to
// judge what they claim; the rest are exercised on the happy path only.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-w12-"));
  dirs.push(d);
  return d;
};

/** The workflow's bring-up on the fake: rl-a and rl-b at the release, rl-a's PAT. */
async function bringUp(f: FakeApi): Promise<string> {
  const run = new Run(CONFIG, f.io);
  const r = await newRecipient();
  const open = async (s: string) => parseCreds(await openSealed(r, s));
  let pat = "";
  for (const [id, slug] of [
    [CONFIG.rlA.id, "rl-a"],
    [CONFIG.rlB.id, "rl-b"],
  ] as const) {
    await bringUpgrade(run, id, slug);
    const c = await mintCreds(run, id, slug, { publicKey: r.publicKey, open });
    if (slug === "rl-a") pat = c.pat;
  }
  return pat;
}

/** Every probe in order; the outcome or the failure message per id. */
async function runAll(f: FakeApi): Promise<Map<ProbeId, Outcome | string>> {
  const pat = await bringUp(f);
  const run = new Run(CONFIG, { ...f.io, rlAPat: () => pat });
  const out = new Map<ProbeId, Outcome | string>();
  for (const p of PROBES) {
    try {
      out.set(p.id, await p.run(run));
    } catch (e) {
      if (!(e instanceof ProbeFail)) throw e;
      out.set(p.id, e.message);
    }
  }
  return out;
}

const level = (o: Outcome | string | undefined) =>
  typeof o === "string" ? `fail: ${o}` : o?.level;

describe("the probes on a conforming staging fake", () => {
  it("covers P1-P47 exactly once", () => {
    const ids = PROBES.map((p) => Number(p.id.slice(1))).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 47 }, (_, i) => i + 1));
  });

  it("every probe passes but the gated and unprovable ones", async () => {
    const out = await runAll(fakeApi());
    const levels = Object.fromEntries([...out].map(([k, v]) => [k, level(v)]));
    const expected = Object.fromEntries(PROBES.map((p) => [p.id, "pass"]));
    Object.assign(expected, {
      P7: "not-applicable",
      P46: "not-applicable",
      P29: "unproven-live",
      P30: "unproven-live",
      P35: "unproven-live",
    });
    expect(levels).toEqual(expected);
  });

  it("prod probes run once prod admin answers 401", async () => {
    const f = fakeApi();
    f.faults.add("prod_live");
    const out = await runAll(f);
    expect(level(out.get("P7"))).toBe("pass");
    expect(level(out.get("P46"))).toBe("pass");
    expect(level(out.get("P26"))).toBe("pass");
  });

  it("P30 is not-applicable outside a dispatch run", async () => {
    const f = fakeApi();
    const run = new Run({ ...CONFIG, dispatch: false }, f.io);
    const p30 = PROBES.find((p) => p.id === "P30");
    expect((await p30?.run(run))?.level).toBe("not-applicable");
  });

  it("asks P15 before route at least once and keeps the P33 job list to OIDC jobs", async () => {
    const f = fakeApi();
    await bringUp(f);
    const run = new Run(CONFIG, f.io);
    for (const p of PROBES) {
      if (p.id === "P34") break;
      await p.run(run).catch(() => undefined);
    }
    expect(run.s.p15?.checked).toBeGreaterThan(0);
    const oidcJobs = [...f.jobs.values()]
      .filter((j) => j.owner === "oidc")
      .map((j) => j.id);
    expect(run.s.jobIds.every((id) => oidcJobs.includes(id))).toBe(true);
  });
});

describe("each probe fails on the behaviour it guards", () => {
  const cases: [Fault, ProbeId, RegExp][] = [
    ["p1_200", "P1", /P1: want 401, got status 200/],
    ["p6_alg_none_ok", "P6", /P6 alg none: want 401/],
    ["p13_replay_new_job", "P13", /replay answered another job id/],
    ["p15_mode_early", "P15", /inventory mode serving before route/],
    ["p27_no_token_ok", "P27", /P27 no token: want 404/],
    ["p34_admin_429", "P34", /P34 \/auth\/start: status 429/],
    ["p37_no_header", "P37", /WWW-Authenticate lacks/],
    [
      "p38_prm_no_scopes",
      "P38",
      /protected resource scopes_supported is not exactly the five/,
    ],
    [
      "p44_no_limit",
      "P44",
      /P44 registration 11: want 429 rate_limited, got status 201/,
    ],
    [
      "p44_unlisted_redirect",
      "P44",
      /P44: registration 1 want 201 with a client_id, got status 400/,
    ],
    ["p22_closed_404", "P22", /P22 closed page/],
    ["p23_no_row", "P23", /P23: inventory has no row for it/],
    ["p45_extra_tool", "P45", /tools\/list names differ/],
    [
      "p47_wrong_code",
      "P47",
      /P47: want 401 unauthenticated, got status 401.*code internal/,
    ],
  ];
  for (const [fault, id, re] of cases)
    it(`${id} on ${fault}`, async () => {
      const f = fakeApi();
      f.faults.add(fault);
      const out = await runAll(f);
      expect(out.get(id)).toMatch(re);
    });

  it("P24 fails when an install is not on the release under test", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const p24 = PROBES.find((p) => p.id === "P24");
    await expect(p24?.run(run)).rejects.toThrow(
      /rl-a runs 0\.81\.0, want 0\.82\.0/,
    );
  });

  it("P29 fails while signups are closed (503): staging must run test-users", async () => {
    const f = fakeApi();
    f.faults.add("signups_closed");
    expect((await runAll(f)).get("P29")).toMatch(
      /P29: 503 signups_closed: staging's SIGNUPS_ENABLED must be test-users/,
    );
  });

  it("P16 late: the accepted upgrade runs to done, so P18, P45 and P31 test what they guard", async () => {
    const f = fakeApi();
    f.faults.add("p16_late");
    const out = await runAll(f);
    expect(level(out.get("P16"))).toBe("unproven-live");
    expect(level(out.get("P18"))).toBe("pass");
    expect(out.get("P45")).toMatchObject({
      level: "unproven-live",
      reason: expect.stringMatching(/P16's upgrade was accepted/),
    });
    expect(level(out.get("P31"))).toBe("pass");
  });

  it("the panel install for P10 and P45 is a live one, never a deleted row", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    await PROBES.find((p) => p.id === "P10")?.run(run);
    const acme = [...f.installs.values()].find((i) => i.slug === "acme");
    expect(run.s.panelInstall).toBe(acme?.id);
  });

  it("P29 deletes to deleting, U's purge is 403, and a later run's create meets signup_limit", async () => {
    const f = fakeApi();
    const p29 = PROBES.find((p) => p.id === "P29");
    const first = await p29?.run(new Run(CONFIG, f.io));
    expect(first).toMatchObject({
      level: "unproven-live",
      reason: expect.stringMatching(/^create job \S+ done and deleted/),
    });
    const mine = [...f.installs.values()].filter(
      (i) => i.owner === "user:rl-test-b",
    );
    expect(mine.map((i) => i.state)).toEqual(["deleting"]);
    const later = await p29?.run(new Run({ ...CONFIG, runId: "5678" }, f.io));
    expect(later).toMatchObject({
      level: "unproven-live",
      reason: expect.stringMatching(/signup_accounts from an earlier run/),
    });
  });

  it("P16 is unproven when the create already finished; P15 fails on a 200 /healthz", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    run.s.p16 = "late";
    const p16 = PROBES.find((p) => p.id === "P16");
    expect((await p16?.run(run))?.level).toBe("unproven-live");
    run.s.p15 = { checked: 0, violations: [] };
    const p15 = PROBES.find((p) => p.id === "P15");
    expect((await p15?.run(run))?.level).toBe("unproven-live");
  });

  it("a probe's failure text carries no body, only status, code and hash", async () => {
    const f = fakeApi();
    f.faults.add("p1_200");
    const out = await runAll(f);
    expect(out.get("P1")).toMatch(
      /^P1: want 401, got status 200, body sha256:[0-9a-f]{16} \(\d+ bytes\)$/,
    );
  });
});

describe("bring-up and revoke (R5, R26)", () => {
  it("upgrades an older install, leaves a current one, refuses a newer one", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    expect(await bringUpgrade(run, CONFIG.rlA.id, "rl-a")).toBe("upgraded");
    expect(await bringUpgrade(run, CONFIG.rlB.id, "rl-b")).toBe("current");
    const older = new Run({ ...CONFIG, version: "0.81.0" }, f.io);
    await expect(bringUpgrade(older, CONFIG.rlB.id, "rl-b")).rejects.toThrow(
      /newer than 0\.81\.0/,
    );
    await expect(bringUpgrade(run, CONFIG.rlA.id, "rl-b")).rejects.toThrow(
      /is rl-a, not rl-b/,
    );
  });

  it("R26 mint opens the sealed creds; revoke makes the PAT 401", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const r = await newRecipient();
    const c = await mintCreds(run, CONFIG.rlA.id, "rl-a", {
      publicKey: r.publicKey,
      open: async (s) => parseCreds(await openSealed(r, s)),
    });
    expect(c.pat).toMatch(/^oa_pat_/);
    expect(c.hookKey).toHaveLength(43);
    expect([...f.pats.keys()]).toEqual([c.pat]);
    await revokeCreds(run, CONFIG.rlA.id, "rl-a", CONFIG.rlA.app, c.pat);
    expect(f.pats.get(c.pat)?.revoked).toBe(true);
  });

  it("R26 mint keeps the sealed creds from a read while the job still runs", async () => {
    const f = fakeApi();
    const seen: { status: string; sealed: boolean }[] = [];
    const io = {
      ...f.io,
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const r = await f.io.fetch(u, init);
        if (String(u).includes("/v1/jobs/")) {
          const j = (await r.clone().json()) as {
            status: string;
            sealed: string | null;
          };
          seen.push({ status: j.status, sealed: j.sealed !== null });
        }
        return r;
      }) as typeof fetch,
    };
    const run = new Run(CONFIG, io);
    const r = await newRecipient();
    const c = await mintCreds(run, CONFIG.rlA.id, "rl-a", {
      publicKey: r.publicKey,
      open: async (s) => parseCreds(await openSealed(r, s)),
    });
    expect(c.pat).toMatch(/^oa_pat_/);
    expect(seen.filter((x) => x.sealed)).toEqual([
      { status: "running", sealed: true },
    ]);
    expect(seen.at(-1)).toEqual({ status: "done", sealed: false });
  });

  it("revoke fails when the PAT still works afterwards", async () => {
    const f = fakeApi();
    f.faults.add("revoke_noop");
    const run = new Run(CONFIG, f.io);
    const r = await newRecipient();
    const c = await mintCreds(run, CONFIG.rlA.id, "rl-a", {
      publicKey: r.publicKey,
      open: async (s) => parseCreds(await openSealed(r, s)),
    });
    await expect(
      revokeCreds(run, CONFIG.rlA.id, "rl-a", CONFIG.rlA.app, c.pat),
    ).rejects.toThrow(/want 401/);
  });

  it("a job that never finishes fails at its deadline on the pinned clock", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const t0 = f.clock.t;
    const a = run.accepted(
      await run.v1(`/installs/${CONFIG.rlA.id}/upgrade`, {
        body: { requestId: run.rid("stuck") },
      }),
      "x",
    );
    const j = f.jobs.get(a.job.id);
    if (j) j.steps = Array.from({ length: 10_000 }, (_, i) => `s${i}`);
    await expect(run.waitJob(a.job.id, { within: 30_000 })).rejects.toThrow(
      /still running .* after 30 s/,
    );
    expect(f.clock.t - t0).toBeGreaterThanOrEqual(30_000);
  });
});

describe("sealed delivery (oa-seal-v1)", () => {
  it("opens what apps/provisioner seals; another key cannot", async () => {
    const r = await newRecipient();
    const s = await sealTo(
      r.publicKey,
      '{"pat":"oa_pat_x","hookKey":"' + "k".repeat(43) + '"}',
    );
    expect(parseCreds(await openSealed(r, s)).pat).toBe("oa_pat_x");
    const other = await newRecipient();
    await expect(openSealed(other, s)).rejects.toThrow();
    await expect(openSealed(r, `x${s}`)).rejects.toThrow(/not an oa-seal-v1/);
  });

  it("parseCreds refuses a non-PAT or a short hook key", () => {
    expect(() =>
      parseCreds('{"pat":"x","hookKey":"' + "k".repeat(43) + '"}'),
    ).toThrow(/PAT/);
    expect(() => parseCreds('{"pat":"oa_pat_x","hookKey":"k"}')).toThrow(
      /hook key/,
    );
    expect(() => parseCreds("nope")).toThrow(/not JSON/);
  });
});

describe("OIDC JWT files", () => {
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://token.actions.example/x?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "REQ-TOKEN-never-printed",
  };
  const minter = (aud?: string, status = 200) => {
    const calls: URL[] = [];
    const f = (async (u: URL, init: RequestInit) => {
      calls.push(new URL(u));
      expect(new Headers(init.headers).get("authorization")).toBe(
        `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      );
      return Response.json(
        {
          value: jwt(
            aud ?? new URL(u).searchParams.get("audience") ?? "",
            1_800_000_600,
          ),
        },
        { status },
      );
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("mints for exactly the audience asked, else refuses; errors never carry the token", async () => {
    const m = minter();
    const v = await mintJwt(AUDIENCES.stagingInventory, env, m.f);
    expect(jwtClaims(v).aud).toBe("https://oa-s-inventory");
    expect(m.calls[0]?.searchParams.get("audience")).toBe(
      "https://oa-s-inventory",
    );
    expect(m.calls[0]?.searchParams.get("api-version")).toBe("2.0");
    await expect(
      mintJwt(AUDIENCES.provisioning, env, minter("https://other").f),
    ).rejects.toThrow(/another audience/);
    const e = await mintJwt(
      AUDIENCES.provisioning,
      env,
      minter(undefined, 500).f,
    ).catch((x: Error) => x.message);
    expect(e).toBe("OIDC: the token endpoint answered 500");
    await expect(mintJwt(AUDIENCES.provisioning, {}, m.f)).rejects.toThrow(
      /id-token: write/,
    );
  });

  it("reads the file while it is fresh; re-mints near expiry in the job, 0600; fails outside it", async () => {
    const d = tmp();
    const file = join(d, "REDLINE_STG_INVENTORY_OIDC");
    const t = { now: 1_800_000_000_000 };
    writeFileSync(
      file,
      jwt("https://oa-s-inventory", 1_800_000_000 + REFRESH_MARGIN_S + 10),
      { mode: 0o600 },
    );
    const m = minter();
    const masked: string[] = [];
    const src = jwtSource(file, AUDIENCES.stagingInventory, {
      env,
      fetch: m.f,
      now: () => t.now,
      onMint: (v) => masked.push(v),
    });
    const first = await src();
    expect(m.calls).toHaveLength(0);
    t.now += 20_000;
    const second = await src();
    expect(second).not.toBe(first);
    expect(m.calls).toHaveLength(1);
    expect(masked).toEqual([second]);
    expect(readFileSync(file, "utf8")).toBe(second);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Every mint is kept for the report scans, one per line, 0600.
    t.now += 600_000;
    const third = await src();
    const minted = join(d, MINTED_FILE);
    expect(readFileSync(minted, "utf8")).toBe(`${second}\n${third}\n`);
    expect(statSync(minted).mode & 0o777).toBe(0o600);
    const offline = jwtSource(file, AUDIENCES.stagingInventory, {
      env: {},
      now: () => 1_800_000_600_000,
    });
    await expect(offline()).rejects.toThrow(/has expired/);
    const missing = jwtSource(join(d, "none"), AUDIENCES.stagingInventory, {
      env: {},
    });
    await expect(missing()).rejects.toThrow(/file missing/);
  });

  it("the prod inventory bearer is re-read (and re-minted) on use in the job, not only at load", async () => {
    const d = tmp();
    for (const n of ["REDLINE_PROD_R2_TOKEN", "REDLINE_PROD_SCRIPTS_TOKEN"])
      writeFileSync(join(d, n), "t", { mode: 0o600 });
    const jwtFile = join(d, "REDLINE_PROD_INVENTORY_OIDC");
    const v1 = jwt("https://oa-p-inventory");
    writeFileSync(jwtFile, v1, { mode: 0o600 });
    const base = { REDLINE_PROD_ACCOUNT_ID: "a".repeat(32) };
    const job = parseProd(undefined, d, { ...base, ...env });
    const v2 = jwt("https://oa-p-inventory", 4_102_444_801);
    writeFileSync(jwtFile, v2, { mode: 0o600 });
    expect(await prodInventoryBearer(job as never)).toBe(v2);
    const local = parseProd(undefined, d, base);
    expect(await prodInventoryBearer(local as never)).toBeUndefined();
  });

  it("refuses a group-readable JWT file", async () => {
    const d = tmp();
    const file = join(d, "REDLINE_PROVISIONING_OIDC");
    writeFileSync(file, API_JWT, { mode: 0o644 });
    await expect(
      jwtSource(file, AUDIENCES.provisioning, { env: {} })(),
    ).rejects.toThrow(/0600/);
  });
});

describe("config", () => {
  const t = rawTargets(
    JSON.stringify({
      secretsDir: "/x",
      a: { installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
      b: { installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
    }),
  );
  it("takes the tag as the version and defaults the staging hosts", () => {
    const c = provConfig(
      {
        REDLINE_RELEASE: "v0.82.0",
        REDLINE_RUN_ID: "99-1",
        REDLINE_DISPATCH: "1",
      },
      t,
    );
    expect(c).toMatchObject({
      version: "0.82.0",
      runId: "99-1",
      dispatch: true,
      api: CONFIG.api,
      admin: CONFIG.admin,
      broker: CONFIG.broker,
    });
    expect(c.inventory).toBeUndefined();
  });
  it("refuses a bad tag, run id or origin", () => {
    expect(() =>
      provConfig({ REDLINE_RELEASE: "latest", REDLINE_RUN_ID: "1" }, t),
    ).toThrow(/not a version/);
    expect(() =>
      provConfig({ REDLINE_RELEASE: "0.1.0", REDLINE_RUN_ID: "a b" }, t),
    ).toThrow(/REDLINE_RUN_ID/);
    expect(() =>
      provConfig(
        {
          REDLINE_RELEASE: "0.1.0",
          REDLINE_RUN_ID: "1",
          REDLINE_PROV_API: "http://x",
        },
        t,
      ),
    ).toThrow(/bare https origin/);
    expect(() => rawTargets("{}")).toThrow(/secretsDir/);
  });
  it("slugs and request ids fit the API's rules", () => {
    const run = new Run({ ...CONFIG, runId: "123456789012-3" }, fakeApi().io);
    expect(run.slug("p")).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
    expect(run.rid("x")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

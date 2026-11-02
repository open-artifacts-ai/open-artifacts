import { webcrypto } from "node:crypto";
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
import { takeFileNotes } from "../src/notes.ts";
import {
  AUDIENCES,
  jwtClaims,
  jwtSource,
  MINTED_FILE,
  mintJwt,
  REFRESH_MARGIN_S,
} from "../src/oidc.ts";
import {
  ADMIN_FLOW_COOKIE,
  BROKER_IP_WAIT_MS,
  bringUpgrade,
  failText,
  mintCreds,
  type Outcome,
  P25_MAX_REQUESTS,
  P29_UNPROVEN,
  PROBES,
  ProbeFail,
  type ProbeId,
  prodLive,
  provConfig,
  Run,
  revokeCreds,
  stagedVersion,
  statusCounts,
} from "../src/provisioning.ts";
import { credFile, rawTargets } from "../src/provisioning-live.ts";
import {
  ACCEPTED_UNPROVEN,
  acceptedUnproven,
  caseKey,
  PRE_PROD_NA,
  PRE_PROD_REASON,
  parseManifest,
} from "../src/report.ts";
import { newRecipient, openSealed, parseCreds } from "../src/seal.ts";
import {
  parseProd,
  parseTargets,
  prodInventoryBearer,
} from "../src/targets.ts";
import { sealTo } from "./provisioner-seal.ts";
import {
  API_JWT,
  CLEAR_FLOW_COOKIE,
  CONFIG,
  type FakeApi,
  type Fault,
  fakeApi,
  jwt,
  setVersion,
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
  it("covers P1-P49 exactly once", () => {
    const ids = PROBES.map((p) => Number(p.id.slice(1))).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 49 }, (_, i) => i + 1));
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
    // #1012: the gate's frozen list is exactly the probes that give the
    // pre-prod reason.
    const preProd = [...out]
      .filter(
        ([, v]) =>
          typeof v === "object" &&
          "reason" in v &&
          v.reason === PRE_PROD_REASON,
      )
      .map(([k]) => k);
    expect(preProd.filter((k) => level(out.get(k)) !== "pass")).toEqual([
      ...PRE_PROD_NA,
    ]);
  });

  // A renamed probe title is a required case that did not run plus a case not
  // in the manifest (run 41322062244's P22): catch it before the live run.
  it("live/manifest.json lists every probe by the name the reporter gives it, and nothing else", () => {
    const file = "live/provisioning.test.ts";
    const m = parseManifest(
      readFileSync(
        join(import.meta.dirname, "..", "live", "manifest.json"),
        "utf8",
      ),
    );
    const listed = new Set(
      m.cases
        .filter((x) => x.file === file)
        .map((x) => caseKey(x.file, x.name)),
    );
    const named = new Set(
      PROBES.map((p) => caseKey(file, `provisioning > ${p.id}: ${p.title}`)),
    );
    const show = (k: string) => k.split("\u0000")[1];
    expect([...listed].filter((k) => !named.has(k)).map(show)).toEqual([]);
    expect([...named].filter((k) => !listed.has(k)).map(show)).toEqual([]);
    expect(listed.size).toBe(PROBES.length);
  });

  // The gate matches these by exact name and reason: no run-specific text.
  it("the unproven probes give the fixed reasons the gate's accepted list names", async () => {
    const out = await runAll(fakeApi());
    const name = (id: ProbeId) =>
      `provisioning > ${id}: ${PROBES.find((p) => p.id === id)?.title}`;
    for (const id of ["P29", "P30", "P35"] as const)
      expect(
        acceptedUnproven({
          name: name(id),
          file: "live/provisioning.test.ts",
          ...(out.get(id) as Outcome & { level: "unproven-live" }),
        }),
        id,
      ).toBeDefined();
    expect(out.get("P29")).toEqual({
      level: "unproven-live",
      reason: P29_UNPROVEN,
    });
    // P29 is on the list for M1 only (#1046 takes it off).
    expect(
      ACCEPTED_UNPROVEN.find((e) => e.name.startsWith("provisioning > P29: "))
        ?.evidence,
    ).toContain("#1046");
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
    [
      "p25_limited_cookie",
      "P25",
      /a limited \/auth\/start set the flow cookie/,
    ],
    ["p25_limited_google", "P25", /no 303 to \/sign-in\?error=rate_limited/],
    ["p43_redirect", "P43", /P43 b=1: status 302/],
    ["p43_refresh", "P43", /refreshes itself/],
    ["p43_script", "P43", /carries a script/],
    [
      "p43_foreign_return",
      "P43",
      /no button to \/auth\/start for this request/,
    ],
    ["prod_resolves_404", "P7", /resolves but is status 404/],
    ["p37_no_header", "P37", /WWW-Authenticate lacks/],
    [
      "p38_prm_no_scopes",
      "P38",
      /protected resource scopes_supported is not exactly the five/,
    ],
    [
      "p44_no_limit",
      "P44",
      /P44 registration 11: want 429 temporarily_unavailable, got 201/,
    ],
    [
      "p44_wrong_code",
      "P44",
      /P44 registration 11: want 429 temporarily_unavailable, got status 429.*code rate_limited/,
    ],
    [
      "p44_unlisted_redirect",
      "P44",
      /P44: registration 1 want 201 with a client_id or 429, got status 400/,
    ],
    ["p22_closed_404", "P22", /P22 closed page/],
    ["p23_no_row", "P23", /P23: inventory has no row for it/],
    ["p45_extra_tool", "P45", /tools\/list names differ/],
    [
      "p47_wrong_code",
      "P47",
      /P47: want 401 unauthenticated, got status 401.*code internal/,
    ],
    [
      "r2_q_owner_email",
      "P49",
      /P49 R2 q=owner email: 1 items match by owner email only, want 0/,
    ],
  ];
  for (const [fault, id, re] of cases)
    it(`${id} on ${fault}`, async () => {
      const f = fakeApi();
      f.faults.add(fault);
      const out = await runAll(f);
      expect(out.get(id)).toMatch(re);
    });

  it("P13 waits out the 60 s HOSTS cache for the redline /healthz", async () => {
    const f = fakeApi();
    f.faults.add("p13_hosts_cache");
    const out = await runAll(f);
    expect(level(out.get("P13"))).toBe("pass");
  });

  it("P13 fails after 120 s on a /healthz that never turns redline, naming the last answer", async () => {
    const f = fakeApi();
    f.faults.add("p13_healthz_404");
    const out = await runAll(f);
    expect(out.get("P13")).toMatch(
      /^P13: \/healthz is not the redline variant within 120 s \(status 404, body sha256:[0-9a-f]{16} \(2 bytes\)\)$/,
    );
  });

  describe("P25 sends /auth/start one at a time", () => {
    const p25 = async (
      limit: number,
      fault?: Fault,
      limitedCookie?: string,
    ) => {
      const f = fakeApi();
      f.signin.limit = limit;
      if (limitedCookie !== undefined) f.signin.limitedCookie = limitedCookie;
      if (fault) f.faults.add(fault);
      const out = await PROBES.find((p) => p.id === "P25")
        ?.run(new Run(CONFIG, f.io))
        .catch((e: unknown) => e);
      const starts = f.log.filter(
        (l) => l === `GET ${CONFIG.admin}/auth/start`,
      );
      return { out, starts: starts.length };
    };

    it("passes when the limit trips within 30 and stops sending", async () => {
      for (const limit of [0, 10, 29]) {
        const { out, starts } = await p25(limit);
        expect(out).toEqual({
          level: "pass",
          note: `limited on request ${limit + 1} of up to ${P25_MAX_REQUESTS}`,
        });
        // Stops at the tripping request: no follow-up (per-isolate counts).
        expect(starts).toBe(limit + 1);
      }
    });

    it("counts only a Set-Cookie that sets a live flow", async () => {
      const now = fakeApi().clock.t;
      const past = new Date(now - 1000).toUTCString();
      const future = new Date(now + 60_000).toUTCString();
      // The honest limited 303 sends clearFlowCookie(); it passes.
      expect((await p25(0)).out).toMatchObject({ level: "pass" });
      for (const c of [
        CLEAR_FLOW_COOKIE,
        `${ADMIN_FLOW_COOKIE}=f; Max-Age=0; Path=/; HttpOnly; Secure`,
        `${ADMIN_FLOW_COOKIE}=f; Max-Age=-1; Path=/`,
        `${ADMIN_FLOW_COOKIE}=f; Expires=${past}; Path=/`,
        "other=x; Path=/",
      ])
        expect((await p25(0, undefined, c)).out, c).toMatchObject({
          level: "pass",
        });
      for (const c of [
        `${ADMIN_FLOW_COOKIE}=f; Path=/; Secure; HttpOnly`,
        `${ADMIN_FLOW_COOKIE}=f; Max-Age=600; Path=/`,
        `${ADMIN_FLOW_COOKIE}=f; Expires=${future}`,
        // Max-Age wins over a past Expires (RFC 6265 5.3): still live.
        `${ADMIN_FLOW_COOKIE}=f; Max-Age=600; Expires=${past}`,
      ])
        expect(((await p25(0, undefined, c)).out as Error).message, c).toBe(
          "P25: a limited /auth/start set the flow cookie",
        );
      expect(((await p25(0, "p25_limited_cookie")).out as Error).message).toBe(
        "P25: a limited /auth/start set the flow cookie",
      );
    });

    it("fails naming the counts when the limit never trips", async () => {
      const { out, starts } = await p25(P25_MAX_REQUESTS);
      expect(out).toBeInstanceOf(ProbeFail);
      expect((out as Error).message).toBe(
        "P25: no 303 to /sign-in?error=rate_limited in 30 sequential requests (302 x30)",
      );
      expect(starts).toBe(P25_MAX_REQUESTS);
    });
  });

  describe("P34 allows the broker's per-IP 429 and waits out its window", () => {
    const p34 = async (ipLimit: number, fault?: Fault) => {
      const f = fakeApi();
      f.broker.ipLimit = ipLimit;
      if (fault) f.faults.add(fault);
      const t0 = f.clock.t;
      const out = await PROBES.find((p) => p.id === "P34")
        ?.run(new Run(CONFIG, f.io))
        .catch((e: unknown) => e);
      return { out, waited: f.clock.t - t0, f };
    };
    const msg = (o: unknown) => (o as Error).message;

    it("passes on all 404s without waiting", async () => {
      const { out, waited } = await p34(Number.POSITIVE_INFINITY);
      expect(out).toEqual({ level: "pass" });
      expect(waited).toBe(0);
    });

    it("passes on 404s then 429s; the /auth/start hop works after the window", async () => {
      const { out, waited, f } = await p34(60);
      expect(out).toEqual({ level: "pass" });
      expect(waited).toBeGreaterThan(0);
      expect(waited).toBeLessThanOrEqual(BROKER_IP_WAIT_MS);
      // The last broker request is the hop, after the wait.
      const hops = f.log.filter((l) => l.startsWith(`GET ${CONFIG.broker}`));
      expect(hops).toHaveLength(400 + 1 + 1 + waited / 3000);
    });

    it("fails on any redirect", async () => {
      const { out } = await p34(Number.POSITIVE_INFINITY, "p34_authorize_302");
      expect(msg(out)).toBe(
        "P34: 400 of 400 unsigned authorize requests were not 404 or 429 without a cookie (302 x400)",
      );
    });

    it("fails when no answer is 404", async () => {
      const { out } = await p34(0);
      expect(msg(out)).toBe(
        "P34: none of 400 unsigned authorize requests was 404 (429 rate_limited x400)",
      );
    });

    it("fails when the window never reopens by the deadline", async () => {
      const f = fakeApi();
      f.broker.ipLimit = 60;
      let t = f.clock.t;
      // The bucket stays spent: the fake's window never moves, time does.
      const run = new Run(CONFIG, {
        ...f.io,
        now: () => t,
        wait: async (ms) => {
          t += ms;
        },
      });
      const out = await PROBES.find((p) => p.id === "P34")
        ?.run(run)
        .catch((e: unknown) => e);
      expect(msg(out)).toBe(
        `P34: unsigned authorize still 429 after ${BROKER_IP_WAIT_MS / 1000} s; the broker IP window (RL_BROKER_IP, 60 s) did not reopen`,
      );
    });
  });

  it("P32 reads the discarded install on R3 as deleted", async () => {
    const f = fakeApi();
    const out = await runAll(f);
    expect(level(out.get("P32"))).toBe("pass");
    const q = [...f.installs.values()].find((i) => i.slug.startsWith("rl-q-"));
    expect(q?.state).toBe("deleted");
    expect(q?.deletedAt).not.toBeNull();
  });

  it("P44 is unproven when this IP's daily DCR cap was partly spent earlier", async () => {
    const f = fakeApi();
    f.faults.add("p44_cap_spent");
    expect((await runAll(f)).get("P44")).toEqual({
      level: "unproven-live",
      reason: expect.stringMatching(/429 came after 6 registration/),
    });
  });

  it("P15 fails without a staging inventory, whatever /healthz said", async () => {
    const f = fakeApi();
    const { inventory: _, ...noInv } = CONFIG;
    const run = new Run(noInv, f.io);
    run.s.p15 = { checked: 3, violations: [] };
    const p15 = PROBES.find((p) => p.id === "P15");
    await expect(p15?.run(run)).rejects.toThrow(
      /P15: no staging inventory configured/,
    );
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
    takeFileNotes();
    const first = await p29?.run(new Run(CONFIG, f.io));
    expect(first).toEqual({ level: "unproven-live", reason: P29_UNPROVEN });
    // The job id is a note, outside the reason the gate would match.
    expect(takeFileNotes()).toEqual([
      expect.stringMatching(/^P29: create job \S+ done and deleted$/),
    ]);
    const mine = [...f.installs.values()].filter(
      (i) => i.owner === "user:rl-test-b",
    );
    expect(mine.map((i) => i.state)).toEqual(["deleting"]);
    const later = await p29?.run(new Run({ ...CONFIG, runId: "5678" }, f.io));
    // Both paths give the one fixed reason the gate's accepted list names.
    expect(later).toEqual({ level: "unproven-live", reason: P29_UNPROVEN });
    expect(takeFileNotes()).toEqual([
      expect.stringMatching(/signup_accounts from an earlier run/),
    ]);
    const name = `provisioning > P29: ${p29?.title}`;
    for (const o of [first, later])
      expect(
        acceptedUnproven({
          name,
          file: "live/provisioning.test.ts",
          ...(o as Outcome & { level: "unproven-live" }),
        }),
      ).toBeDefined();
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

  it("the staged version is written only once rl-a and rl-b both report the release", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    await expect(stagedVersion(run)).rejects.toThrow(
      /rl-a \/healthz: want 200 version 0\.82\.0, got version 0\.81\.0/,
    );
    await bringUpgrade(run, CONFIG.rlA.id, "rl-a");
    expect(await stagedVersion(run)).toBe("0.82.0");
    // rl-b is checked too: rl-a alone reporting the tag is not enough.
    setVersion(f, CONFIG.rlB.id, "0.81.0");
    await expect(stagedVersion(run)).rejects.toThrow(
      /rl-b \/healthz: want 200 version 0\.82\.0, got version 0\.81\.0/,
    );
  });

  /** The fake's io with one JSON response rewritten (R3 or /healthz). */
  const rewrite = (
    f: FakeApi,
    match: (u: URL) => boolean,
    edit: (b: Record<string, unknown>) => void,
  ) => ({
    ...f.io,
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      const r = await f.io.fetch(u, init);
      const url = new URL(u instanceof Request ? u.url : String(u));
      if (!match(url) || r.status !== 200) return r;
      const b = (await r.json()) as Record<string, unknown>;
      edit(b);
      return Response.json(b, { status: 200 });
    }) as typeof fetch,
  });

  it("the staged version reads /healthz on R3's appHost and refuses a mismatched variable host", async () => {
    const f = fakeApi();
    await bringUpgrade(new Run(CONFIG, f.io), CONFIG.rlA.id, "rl-a");
    // Happy path: both hosts match R3 and name their install ids.
    expect(await stagedVersion(new Run(CONFIG, f.io))).toBe("0.82.0");
    // rl-b's variable pointing at rl-a's host is refused before any /healthz.
    const swapped = new Run(
      { ...CONFIG, rlB: { ...CONFIG.rlB, app: CONFIG.rlA.app } },
      f.io,
    );
    const before = f.log.length;
    await expect(stagedVersion(swapped)).rejects.toThrow(
      /rl-b: REDLINE_TARGETS host rl-a\.open-artifacts-staging\.app is not R3's appHost rl-b\.open-artifacts-staging\.app for irlbbbbbbbbb/,
    );
    expect(
      f.log
        .slice(before)
        .filter((l) => l.includes("rl-b.") && l.endsWith("/healthz")),
    ).toEqual([]);
  });

  it("the staged version refuses a /healthz from another installId", async () => {
    const f = fakeApi();
    await bringUpgrade(new Run(CONFIG, f.io), CONFIG.rlA.id, "rl-a");
    const io = rewrite(
      f,
      (u) =>
        u.hostname === "rl-b.open-artifacts-staging.app" &&
        u.pathname === "/healthz",
      (b) => {
        b.installId = CONFIG.rlA.id;
      },
    );
    await expect(stagedVersion(new Run(CONFIG, io))).rejects.toThrow(
      /rl-b \/healthz: want installId irlbbbbbbbbb, got irlaaaaaaaaa/,
    );
  });

  it("the staged version refuses an install R3 gives no appHost", async () => {
    const f = fakeApi();
    await bringUpgrade(new Run(CONFIG, f.io), CONFIG.rlA.id, "rl-a");
    const io = rewrite(
      f,
      (u) => u.pathname.endsWith(`/v1/installs/${CONFIG.rlA.id}`),
      (b) => {
        delete b.appHost;
      },
    );
    await expect(stagedVersion(new Run(CONFIG, io))).rejects.toThrow(
      /R3 rl-a: no appHost for irlaaaaaaaaa/,
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

  it("R26 prints the job's fail point (#995): fixed values only", async () => {
    const f = fakeApi();
    const io = {
      ...f.io,
      fetch: (async (u: string | URL | Request, init?: RequestInit) => {
        const r = await f.io.fetch(u, init);
        if (!String(u).includes("/v1/jobs/")) return r;
        const j = (await r.json()) as Record<string, unknown>;
        return Response.json({
          ...j,
          status: "failed",
          lastErrorCode: "internal",
          failure: { at: "test_session", status: 404, reason: "user_refused" },
        });
      }) as typeof fetch,
    };
    const run = new Run(CONFIG, io);
    const r = await newRecipient();
    await expect(
      mintCreds(run, CONFIG.rlA.id, "rl-a", {
        publicKey: r.publicKey,
        open: async (s) => parseCreds(await openSealed(r, s)),
      }),
    ).rejects.toThrow(
      "R26 rl-a: job failed (internal) at test_session (HTTP 404, user_refused)",
    );
  });

  it("failText: point, then status and reason when present; nothing without a point", () => {
    expect(failText({ failure: null })).toBe("");
    expect(failText({})).toBe("");
    expect(
      failText({ failure: { at: "seal", status: null, reason: null } }),
    ).toBe(" at seal");
    expect(
      failText({ failure: { at: "mint_token", status: 503, reason: null } }),
    ).toBe(" at mint_token (HTTP 503)");
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

  it("the recipient's private key cannot be exported; seal/unseal still round-trips", async () => {
    const r = await newRecipient();
    expect(r.pair.privateKey.extractable).toBe(false);
    await expect(
      webcrypto.subtle.exportKey("pkcs8", r.pair.privateKey),
    ).rejects.toThrow();
    await expect(
      webcrypto.subtle.exportKey("jwk", r.pair.privateKey),
    ).rejects.toThrow();
    const s = await sealTo(
      r.publicKey,
      '{"pat":"oa_pat_y","hookKey":"' + "k".repeat(43) + '"}',
    );
    expect(parseCreds(await openSealed(r, s)).pat).toBe("oa_pat_y");
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
      a: { name: "rl-a", installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
      b: { name: "rl-b", installId: CONFIG.rlB.id, app: CONFIG.rlB.app },
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
  // #1012: bring-up wrote REDLINE_A_*; the suite reads REDLINE_RL_A_*.
  it("R26 creds go exactly where the suite reads them", () => {
    const side = (n: string, id: string, app: string) => ({
      name: n,
      installId: id,
      app,
      content: app.replace(".app", ".page"),
      testDomain: `guests.${n}.fyi`,
    });
    const dir = mkdtempSync(join(tmpdir(), "oa-rl-creds-"));
    const json = JSON.stringify({
      secretsDir: dir,
      a: side("rl-a", CONFIG.rlA.id, CONFIG.rlA.app),
      b: side("rl-b", CONFIG.rlB.id, CONFIG.rlB.app),
    });
    const raw = rawTargets(json);
    // Written where bring-up writes them, then read by the suite's loader.
    for (const k of ["a", "b"] as const)
      for (const kind of ["PAT", "HOOK_KEY"] as const)
        writeFileSync(
          credFile(raw, k, kind),
          `v-${k}-${kind}-`.padEnd(40, "x"),
          {
            mode: 0o600,
          },
        );
    const suite = parseTargets({ REDLINE_TARGETS: json });
    for (const k of ["a", "b"] as const) {
      expect(credFile(raw, k, "HOOK_KEY")).toBe(suite[k].hookKeyFile);
      expect(credFile(raw, k, "PAT")).toBe(suite[k].patFile);
    }
    expect(credFile(raw, "a", "HOOK_KEY")).toBe(
      join(dir, "REDLINE_RL_A_HOOK_KEY"),
    );
    expect(() =>
      rawTargets(
        JSON.stringify({
          secretsDir: "/x",
          a: { installId: CONFIG.rlA.id, app: CONFIG.rlA.app },
          b: side("rl-b", CONFIG.rlB.id, CONFIG.rlB.app),
        }),
      ),
    ).toThrow(/a\.name/);
  });
  // #1012: before the prod platform deploy its admin host has no DNS record.
  it("prodLive: only an unresolved prod host is not live; a 401 is live; anything else fails", async () => {
    const thrown = (code: string) => async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
    };
    const io = fakeApi().io;
    const at = (fetch: typeof io.fetch) => new Run(CONFIG, { ...io, fetch });
    expect(await prodLive(at(thrown("ENOTFOUND") as typeof io.fetch))).toBe(
      false,
    );
    await expect(
      prodLive(at(thrown("ECONNRESET") as typeof io.fetch)),
    ).rejects.toThrow("fetch failed");
    expect(
      await prodLive(
        at(
          (async () => new Response("{}", { status: 401 })) as typeof io.fetch,
        ),
      ),
    ).toBe(true);
    for (const status of [404, 500, 503])
      await expect(
        prodLive(
          at((async () => new Response("{}", { status })) as typeof io.fetch),
        ),
      ).rejects.toThrow(`resolves but is status ${status}`);
  });
  it("statusCounts: statuses and fixed codes only, most first", () => {
    const r = (status: number, json?: unknown) => ({ status, json });
    expect(
      statusCounts([
        r(429, { error: { code: "rate_limited" } }),
        r(404),
        r(429, { error: { code: "rate_limited" } }),
        r(500, { error: { code: "Has Spaces <b>" } }),
      ]),
    ).toBe("429 rate_limited x2, 404 x1, 500 x1");
  });
  it("the flow cookie name is the app's own", () => {
    const flow = readFileSync(
      join(import.meta.dirname, "../../../apps/provisioning/src/auth/flow.ts"),
      "utf8",
    );
    expect(flow).toContain(
      `export const FLOW_COOKIE = "${ADMIN_FLOW_COOKIE}";`,
    );
  });
  it("slugs and request ids fit the API's rules", () => {
    const run = new Run({ ...CONFIG, runId: "123456789012-3" }, fakeApi().io);
    expect(run.slug("p")).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
    expect(run.rid("x")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});

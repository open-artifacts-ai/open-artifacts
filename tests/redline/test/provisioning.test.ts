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
import { InfraError } from "../src/fetch-timeout.ts";
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
  AFTER_CHAINS,
  BROKER_IP_PERIOD_MS,
  BROKER_IP_WAIT_MS,
  bringUpgrade,
  CHAINS,
  cleanupInstalls,
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
  REMOVED_PROBES,
  Run,
  revokeCreds,
  runProbe,
  stagedVersion,
  startChains,
  statusCounts,
} from "../src/provisioning.ts";
import { credFile, rawTargets } from "../src/provisioning-live.ts";
import {
  ACCEPTED_UNPROVEN,
  acceptedUnproven,
  caseKey,
  gatePasses,
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

/**
 * Every probe as the live suite runs them (startChains: the chains at once,
 * then P33), then the run's cleanup; the outcome or the failure message per
 * id (an infra message keeps its "infra: " prefix).
 */
async function runChains(
  f: FakeApi,
  o: Parameters<typeof startChains>[1] = {},
): Promise<{
  out: Map<ProbeId, Outcome | string>;
  run: Run;
  /** The run's installs still live once the chains settled, before cleanup. */
  liveAtSettle: string[];
}> {
  const pat = await bringUp(f);
  const run = new Run(CONFIG, { ...f.io, rlAPat: () => pat });
  const plan = startChains(run, o);
  const out = new Map<ProbeId, Outcome | string>();
  for (const [id, r] of plan.outcomes) {
    try {
      out.set(id, await r);
    } catch (e) {
      if (!(e instanceof ProbeFail) && !(e instanceof InfraError)) throw e;
      out.set(id, e.message);
    }
  }
  await plan.settled;
  const liveAtSettle = [...f.installs.values()]
    .filter((i) => /^rl-(p|l|q)-/.test(i.slug) && i.state !== "deleted")
    .map((i) => i.slug);
  await cleanupInstalls(run);
  return { out, run, liveAtSettle };
}

async function runAll(f: FakeApi): Promise<Map<ProbeId, Outcome | string>> {
  return (await runChains(f)).out;
}

const level = (o: Outcome | string | undefined) =>
  typeof o === "string"
    ? o.startsWith("infra: ")
      ? "infra"
      : `fail: ${o}`
    : o?.level;

describe("the probes on a conforming staging fake", () => {
  it("covers P1-P50 exactly once: a probe, or removed with the issue that says why", () => {
    const removed = Object.keys(REMOVED_PROBES);
    const ids = [...PROBES.map((p) => p.id), ...removed]
      .map((id) => Number(id.slice(1)))
      .sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(removed.sort()).toEqual(["P35", "P50"]);
    expect(REMOVED_PROBES.P35).toMatch(/^#1260: /);
    expect(REMOVED_PROBES.P50).toMatch(/^#1078: /);
    expect(Object.isFrozen(REMOVED_PROBES)).toBe(true);
  });

  it("a removed probe is cited in the manifest's notes with its issue, and is no accepted unproven case", () => {
    const m = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "live", "manifest.json"),
        "utf8",
      ),
    ) as { notes: string[] };
    for (const [id, why] of Object.entries(REMOVED_PROBES)) {
      const issue = why?.match(/^#\d+/)?.[0] as string;
      expect(
        m.notes.some(
          (n) =>
            n.startsWith("live/provisioning.test.ts no longer runs ") &&
            n.includes(`${id} `) &&
            n.includes(issue),
        ),
        id,
      ).toBe(true);
      expect(
        ACCEPTED_UNPROVEN.some((e) =>
          e.name.startsWith(`provisioning > ${id}:`),
        ),
        id,
      ).toBe(false);
    }
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
    for (const id of ["P29", "P30"] as const)
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
    ["p20_content_serving", "P20", /P20 paused page: not within 120 s/],
    ["p21_stays_paused", "P21", /P21 \/healthz 200: not within 120 s/],
    ["p22_closed_404", "P22", /P22 closed page/],
    ["p23_no_row", "P23", /P23: inventory has no row for it/],
    ["p23_slug_freed", "P23", /P23: R18 after purge: .*, want taken/],
    ["p45_extra_tool", "P45", /tools\/list names differ/],
    [
      "p47_wrong_code",
      "P47",
      /P47: want 401 unauthenticated, got status 401.*code internal/,
    ],
    [
      "r2_q_owner_email",
      "P49",
      // rl-p, and rl-l when its chain has it live.
      /P49 R2 q=owner email: [1-2] items match by owner email only, want 0/,
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

  describe("P34 allows the broker's per-IP 429 and waits on the hop itself", () => {
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
      // The 400, then the hop every POLL_MS until it reaches Google.
      const hops = f.log.filter((l) => l.startsWith(`GET ${CONFIG.broker}`));
      expect(hops).toHaveLength(400 + 1 + waited / 3000);
    });

    // Run 41444760207: the unsigned 404 passed, then the hop was 429.
    const withHop = async (o: {
      limited?: number;
      status?: number;
      location?: string;
    }) => {
      const f = fakeApi();
      f.broker.hopLimited = o.limited ?? 0;
      f.broker.hopStatus = o.status ?? 302;
      f.broker.hopLocation = o.location;
      const t0 = f.clock.t;
      const out = await PROBES.find((p) => p.id === "P34")
        ?.run(new Run(CONFIG, f.io))
        .catch((e: unknown) => e);
      return { out, waited: f.clock.t - t0, f };
    };

    it("a 429 on the hop waits, though unsigned requests answer 404", async () => {
      const { out, waited } = await withHop({ limited: 3 });
      expect(out).toEqual({ level: "pass" });
      expect(waited).toBe(3 * 3000);
    });

    it("one /auth/start: more would spend RL_PV_SIGNIN_IP", async () => {
      const { f } = await withHop({ limited: 3 });
      expect(
        f.log.filter((l) => l === `GET ${CONFIG.admin}/auth/start`),
      ).toHaveLength(1);
    });

    it("a hop still 429 at the deadline fails: a limiter that doesn't reopen is a real bug", async () => {
      const { out, waited } = await withHop({
        limited: Number.POSITIVE_INFINITY,
      });
      expect(msg(out)).toContain(
        `P34: the broker hop was still 429 after ${BROKER_IP_WAIT_MS / 1000} s; RL_BROKER_IP's window is ${BROKER_IP_PERIOD_MS / 1000} s, so a limiter did not reopen (status 429,`,
      );
      expect(waited).toBeLessThanOrEqual(BROKER_IP_WAIT_MS);
    });

    it("a redirect anywhere but Google fails at once", async () => {
      const { out, waited } = await withHop({
        location: "https://evil.test/auth",
      });
      expect(msg(out)).toContain(
        "P34: the broker did not send /auth/start on to Google",
      );
      expect(waited).toBe(0);
    });

    it("any other hop answer fails at once", async () => {
      const { out, waited } = await withHop({ status: 404 });
      expect(msg(out)).toContain(
        "P34: the broker did not send /auth/start on to Google (status 404",
      );
      expect(waited).toBe(0);
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
      expect(msg(out)).toContain(
        `P34: the broker hop was still 429 after ${BROKER_IP_WAIT_MS / 1000} s;`,
      );
    });
  });

  describe("the inventory's mode settles: HOSTS is eventually consistent", () => {
    /** The inventory answers `stale` for reads of a mode, `times` times. */
    const staleFor = (
      f: ReturnType<typeof fakeApi>,
      fresh: string | null,
      stale: string,
      times: number,
    ) => {
      const real = f.io.fetch;
      let left = times;
      f.io.fetch = (async (u: string, i?: RequestInit) => {
        const r = await real(u, i);
        if (!String(u).includes("/hosts?host=")) return r;
        const j = (await r.clone().json()) as { mode?: string | null };
        if ((j.mode ?? null) !== fresh || left <= 0) return r;
        left--;
        return Response.json({ ...j, mode: stale });
      }) as typeof fetch;
    };

    for (const [id, fresh, stale] of [
      ["P20", "paused", "serving"],
      ["P22", "closed", "serving"],
      ["P22", "serving", "closed"],
    ] as const)
      it(`${id}: a stale ${stale} read that clears to ${fresh} passes`, async () => {
        const f = fakeApi();
        staleFor(f, fresh, stale, 2);
        expect(level((await runAll(f)).get(id))).toBe("pass");
      });

    it("P23: a host still mapped for a moment passes", async () => {
      const f = fakeApi();
      staleFor(f, null, "closed", 2);
      expect(level((await runAll(f)).get("P23"))).toBe("pass");
    });

    for (const [id, fresh, stale, msg] of [
      ["P20", "paused", "serving", "serving, want paused"],
      ["P22", "closed", "serving", "serving, want closed"],
      ["P22", "serving", "closed", "closed, want serving"],
      ["P23", null, "closed", "closed, want null"],
    ] as const)
      it(`${id}: a mode that never reaches ${fresh} fails, naming the last one`, async () => {
        const f = fakeApi();
        staleFor(f, fresh, stale, Number.POSITIVE_INFINITY);
        expect(level((await runAll(f)).get(id))).toBe(
          `fail: ${id}: inventory mode is ${msg}, after 120 s`,
        );
      });
  });

  describe("bring-up survives a dropped connection and a busy install", () => {
    const POLL = 3_000;
    /** A Run whose fetch `answer` handles first; undefined falls through. */
    const runWith = (
      answer: (url: string) => Response | undefined,
      f = fakeApi(),
    ) => {
      const seen: string[] = [];
      const run = new Run(CONFIG, {
        ...f.io,
        fetch: (async (u: string, i?: RequestInit) => {
          seen.push(`${i?.method ?? "GET"} ${u}`);
          return answer(String(u)) ?? f.io.fetch(u, i);
        }) as typeof fetch,
      });
      return { run, f, seen };
    };
    const job = (status: string) =>
      Response.json({ id: "j1", status, step: "x" });
    const dropped = () => {
      throw new TypeError("fetch failed");
    };

    it("waitJob retries a dropped connection, then carries on", async () => {
      let n = 0;
      const { run, f } = runWith((u) =>
        u.includes("/jobs/j1")
          ? ++n <= 2
            ? dropped()
            : job("done")
          : undefined,
      );
      const t0 = f.clock.t;
      expect((await run.waitJob("j1")).status).toBe("done");
      expect(f.clock.t - t0).toBe(2 * POLL);
    });

    it("waitJob gives up at its bound, naming the job and no detail", async () => {
      const { run, f } = runWith((u) =>
        u.includes("/jobs/j1") ? dropped() : undefined,
      );
      const t0 = f.clock.t;
      await expect(run.waitJob("j1", { within: 30_000 })).rejects.toThrow(
        "R15 j1: no answer for 30 s",
      );
      expect(f.clock.t - t0).toBeLessThanOrEqual(30_000);
    });

    it("waitJob still fails at once on a real API error", async () => {
      const { run, f } = runWith((u) =>
        u.includes("/jobs/j1")
          ? Response.json({ error: { code: "x" } }, { status: 500 })
          : undefined,
      );
      const t0 = f.clock.t;
      await expect(run.waitJob("j1")).rejects.toThrow("R15 j1: status 500");
      expect(f.clock.t - t0).toBe(0);
    });

    const busy = () =>
      Response.json(
        { error: { code: "job_in_progress", message: "x" } },
        { status: 409 },
      );
    const revoke = (run: Run) =>
      revokeCreds(run, CONFIG.rlA.id, "rl-a", CONFIG.rlA.app);

    it("revoke waits out a job already running on the install", async () => {
      let n = 0;
      const { run, f, seen } = runWith((u) =>
        u.includes("/redline-creds") && ++n <= 2 ? busy() : undefined,
      );
      const t0 = f.clock.t;
      await revoke(run);
      expect(f.clock.t - t0).toBeGreaterThanOrEqual(2 * POLL);
      expect(seen.filter((l) => l.includes("/redline-creds"))).toHaveLength(3);
    });

    it("revoke gives up at the job bound", async () => {
      const { run } = runWith((u) =>
        u.includes("/redline-creds") ? busy() : undefined,
      );
      await expect(revoke(run)).rejects.toThrow(
        /R26 revoke rl-a: .*job_in_progress/,
      );
    });

    it("revoke fails at once on any other refusal", async () => {
      const { run, f } = runWith((u) =>
        u.includes("/redline-creds")
          ? Response.json({ error: { code: "forbidden" } }, { status: 403 })
          : undefined,
      );
      const t0 = f.clock.t;
      await expect(revoke(run)).rejects.toThrow(/forbidden/);
      expect(f.clock.t - t0).toBe(0);
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
    const down = minter(undefined, 500);
    const e = await mintJwt(
      AUDIENCES.provisioning,
      env,
      down.f,
      async () => {},
    ).catch((x: Error) => x.message);
    expect(e).toBe("OIDC: the token endpoint answered 500");
    expect(down.calls).toHaveLength(3);
    const refused = minter(undefined, 403);
    await expect(
      mintJwt(AUDIENCES.provisioning, env, refused.f, async () => {}),
    ).rejects.toThrow("answered 403");
    expect(refused.calls).toHaveLength(1);
    const ok = minter(AUDIENCES.provisioning);
    let first = true;
    const waits: number[] = [];
    const flaky = (async (...a: Parameters<typeof fetch>) => {
      if (first) {
        first = false;
        return new Response("", { status: 503 });
      }
      return ok.f(...a);
    }) as typeof fetch;
    await expect(
      mintJwt(AUDIENCES.provisioning, env, flaky, async (ms) => {
        waits.push(ms);
      }),
    ).resolves.toMatch(/\./);
    expect(waits).toEqual([1_000]);
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

describe("Run.raw: an allow-side GET survives a dropped connection", () => {
  const reset = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), {
        code: "ECONNRESET",
      }),
    });
  const flaky = (fails: number, status = 200) => {
    const calls: string[] = [];
    const waits: number[] = [];
    const run = new Run(CONFIG, {
      ...fakeApi().io,
      wait: async (ms: number) => {
        waits.push(ms);
      },
      fetch: (async (_u: string, init: RequestInit) => {
        calls.push(init.method ?? "GET");
        if (calls.length <= fails) throw reset();
        return new Response("{}", { status });
      }) as unknown as typeof fetch,
    });
    return { run, calls, waits };
  };

  it("read: a reset is tried again, with the backoff", async () => {
    const { run, calls, waits } = flaky(2);
    expect((await run.v1("/world", { read: true })).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([250, 1000]);
  });

  it("read: a third reset still throws", async () => {
    const { run, calls } = flaky(3);
    await expect(run.v1("/world", { read: true })).rejects.toThrow(
      "fetch failed",
    );
    expect(calls).toHaveLength(3);
  });

  it("an answer is never retried, a refusal or a 500", async () => {
    for (const status of [401, 500]) {
      const { run, calls } = flaky(0, status);
      expect((await run.v1("/world", { read: true })).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it("a deny check has one try: no `read`, as P1 to P3 and P6", async () => {
    const { run, calls } = flaky(1);
    await expect(
      run.v1("/me", { host: "admin", auth: "none" }),
    ).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(1);
  });

  it("P10's refusal has one try: a reset on its GET fails the case", async () => {
    const f = fakeApi();
    let gets = 0;
    const io = {
      ...f.io,
      wait: async () => {},
      fetch: (async (u: string, init: RequestInit) => {
        if (/\/v1\/installs\/[^/?]+$/.test(new URL(u).pathname)) {
          gets++;
          throw reset();
        }
        return f.io.fetch(u, init);
      }) as unknown as typeof fetch,
    };
    const p10 = PROBES.find((p) => p.id === "P10");
    const out = await p10?.run(new Run(CONFIG, io)).catch((e: Error) => e);
    if ((out as { level?: string }).level === "not-applicable")
      throw new Error("the fake must hold a panel-made install for P10");
    expect((out as Error).message).toBe("fetch failed");
    expect(gets).toBe(1);
  });

  it("a write has one try, even with `read`", async () => {
    const { run, calls } = flaky(1);
    await expect(run.v1("/installs", { body: {}, read: true })).rejects.toThrow(
      "fetch failed",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("a failed step doesn't cascade", () => {
  const probe = (id: `P${number}`, needs?: `P${number}`[]) => {
    const calls = { n: 0 };
    return {
      calls,
      p: {
        id,
        title: id,
        ...(needs ? { needs } : {}),
        run: async () => {
          calls.n++;
          return { level: "pass" as const };
        },
      },
    };
  };
  const run = {} as Run;

  it("a dependant doesn't run, and names the root through a chain", async () => {
    const failed = new Set<string>(["P13"]);
    const b = probe("P20", ["P13"]);
    const c = probe("P21", ["P13", "P20"]);
    expect(await runProbe(b.p, run, failed)).toEqual({
      level: "blocked",
      reason: "blocked by P13",
    });
    expect(await runProbe(c.p, run, failed)).toEqual({
      level: "blocked",
      reason: "blocked by P13",
    });
    expect(b.calls.n + c.calls.n).toBe(0);
  });

  it("a thrown failure marks the case; a later dependant is blocked", async () => {
    const failed = new Set<string>();
    const boom = {
      id: "P20" as const,
      title: "x",
      run: async () => {
        throw new ProbeFail("boom");
      },
    };
    await expect(runProbe(boom, run, failed)).rejects.toThrow("boom");
    expect(failed.has("P20")).toBe(true);
    const c = probe("P21", ["P20"]);
    expect((await runProbe(c.p, run, failed)).level).toBe("blocked");
  });

  it("a pass or an unproven case doesn't block its dependants", async () => {
    const failed = new Set<string>();
    const unproven = {
      id: "P13" as const,
      title: "x",
      run: async () => ({ level: "unproven-live" as const, reason: "why" }),
    };
    await runProbe(unproven, run, failed);
    expect(failed.size).toBe(0);
    const d = probe("P14", ["P13"]);
    expect((await runProbe(d.p, run, failed)).level).toBe("pass");
    expect(d.calls.n).toBe(1);
  });

  it("every needs names an earlier probe, or it could never block", () => {
    const seen = new Set<string>();
    for (const p of PROBES) {
      for (const n of p.needs ?? [])
        expect(seen.has(n), `${p.id} ${n}`).toBe(true);
      seen.add(p.id);
    }
    // P20 and P22 need nothing now: they run on rl-l, not P13's rl-p.
    expect(PROBES.filter((p) => p.needs).length).toBe(11);
  });

  it("every needs is earlier in the probe's own chain, so a failure blocks only its own chain", () => {
    for (const c of [...CHAINS, { name: "after", probes: AFTER_CHAINS }]) {
      const seen = new Set<string>();
      for (const id of c.probes) {
        const p = PROBES.find((x) => x.id === id);
        for (const n of p?.needs ?? [])
          expect(seen.has(n), `${c.name}: ${id} needs ${n}`).toBe(true);
        seen.add(id);
      }
    }
  });

  it("the gate never takes a blocked case", () => {
    expect(
      gatePasses([
        { name: "a", level: "pass" },
        { name: "b", level: "blocked", reason: "blocked by P13" },
      ]),
    ).toBe(false);
  });
});

describe("the run's cleanup", () => {
  const made = async (f: FakeApi, run: Run, slug: string) =>
    run.accepted(
      await run.v1("/installs", {
        body: {
          requestId: run.rid(slug),
          slug,
          tier: "team",
          testHooks: true,
        },
      }),
      "create",
    );

  it("removes an install left on the list, and a second pass is a no-op", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const slug = run.slug("p");
    run.s.cleanup.push({ slug });
    const a = await made(f, run, slug);
    await cleanupInstalls(run);
    expect(f.installs.get(a.install.id)?.state).toBe("deleted");
    expect(run.s.cleanup).toEqual([]);
    await cleanupInstalls(run);
  });

  it("an install stuck in `deleting` goes straight to purge", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const slug = run.slug("p");
    run.s.cleanup.push({ slug });
    const a = await made(f, run, slug);
    await run.done(a.job.id, "create");
    const d = run.accepted(
      await run.v1(`/installs/${a.install.id}/delete`, {
        body: { requestId: run.rid("d"), confirmSlug: slug },
      }),
      "delete",
    );
    await run.done(d.job.id, "delete");
    expect(f.installs.get(a.install.id)?.state).toBe("deleting");
    const n = f.log.filter((u) => u.endsWith("/delete")).length;
    await cleanupInstalls(run);
    expect(f.installs.get(a.install.id)?.state).toBe("deleted");
    expect(f.log.filter((u) => u.endsWith("/delete")).length).toBe(n);
  });

  it("touches only what this run listed: q is a search, so a longer slug can match", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, f.io);
    const slug = run.slug("p");
    const other = await made(f, run, `${slug}0`);
    await run.done(other.job.id, "create");
    const hits = await run.v1(`/installs?q=${slug}`, { read: true });
    expect(
      (hits.json as { items: { slug: string }[] }).items.map((i) => i.slug),
    ).toContain(`${slug}0`);
    run.s.cleanup.push({ slug });
    await cleanupInstalls(run);
    expect(f.installs.get(other.install.id)?.state).toBe("active");
  });

  it("a removal that fails stays on the list and fails the run, after trying the rest", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, {
      ...f.io,
      fetch: (async (u: string, init: RequestInit) =>
        new URL(u).searchParams.get("q") === "rl-p-broken"
          ? new Response("{}", { status: 500 })
          : f.io.fetch(u, init)) as unknown as typeof fetch,
    });
    const slug = run.slug("p");
    const a = await made(f, run, slug);
    run.s.cleanup.push({ slug: "rl-p-broken" }, { slug });
    await expect(cleanupInstalls(run)).rejects.toThrow(/cleanup rl-p-broken/);
    expect(run.s.cleanup).toEqual([{ slug: "rl-p-broken" }]);
    expect(f.installs.get(a.install.id)?.state).toBe("deleted");
  });

  it("P13 lists rl-p before its create, so a create that dies is still swept", async () => {
    const f = fakeApi();
    const run = new Run(CONFIG, {
      ...f.io,
      fetch: (async (u: string, init: RequestInit) => {
        if (init.method === "POST" && new URL(u).pathname === "/v1/installs")
          throw new TypeError("fetch failed");
        return f.io.fetch(u, init);
      }) as unknown as typeof fetch,
    });
    await expect(PROBES.find((p) => p.id === "P13")?.run(run)).rejects.toThrow(
      "fetch failed",
    );
    expect(run.s.cleanup).toEqual([{ slug: run.slug("p") }]);
  });

  it("P32 lists rl-q before its create, so a create that dies is still swept", async () => {
    const f = fakeApi();
    const out = await runAll(f);
    expect(level(out.get("P32"))).toBe("pass");
    const q = [...f.installs.values()].find((i) => i.slug.startsWith("rl-q-"));
    expect(q).toBeDefined();
    const g = fakeApi();
    await bringUp(g);
    const run = new Run(CONFIG, {
      ...g.io,
      fetch: (async (u: string, init: RequestInit) => {
        if (init.method === "POST" && new URL(u).pathname === "/v1/installs")
          throw new TypeError("fetch failed");
        return g.io.fetch(u, init);
      }) as unknown as typeof fetch,
    });
    await expect(PROBES.find((p) => p.id === "P32")?.run(run)).rejects.toThrow(
      "fetch failed",
    );
    expect(run.s.cleanup).toEqual([{ slug: run.slug("q") }]);
  });

  it("a green run leaves rl-p purged", async () => {
    const f = fakeApi();
    const out = await runAll(f);
    expect(out.get("P23")).toEqual({ level: "pass" });
    const rlp = [...f.installs.values()].find((i) =>
      i.slug.startsWith("rl-p-"),
    );
    expect(rlp?.state).toBe("deleted");
  });
});

describe("the chains run at once (startChains)", () => {
  const HAPPY: Record<string, string> = {
    ...Object.fromEntries(PROBES.map((p) => [p.id, "pass"])),
    P7: "not-applicable",
    P46: "not-applicable",
    P29: "unproven-live",
    P30: "unproven-live",
  };
  const levels = (out: Map<ProbeId, Outcome | string>) =>
    Object.fromEntries([...out].map(([k, v]) => [k, level(v)]));
  const without = (m: Record<string, unknown>, ids: readonly string[]) =>
    Object.fromEntries(Object.entries(m).filter(([k]) => !ids.includes(k)));
  const RLP_AFTER_P13: ProbeId[] = [
    "P49",
    "P14",
    "P15",
    "P16",
    "P18",
    "P19",
    "P45",
    "P31",
    "P23",
  ];
  /** The run's own installs (rl-p, rl-l, rl-q) still live. */
  const live = (f: FakeApi) =>
    [...f.installs.values()]
      .filter((i) => /^rl-(p|l|q)-/.test(i.slug))
      .filter((i) => i.state !== "deleted")
      .map((i) => `${i.slug} ${i.state}`);
  const bySlug = (f: FakeApi, prefix: string) =>
    [...f.installs.values()].find((i) => i.slug.startsWith(prefix));

  it("every probe is in exactly one chain or after them all", () => {
    const ids = [...CHAINS.flatMap((c) => c.probes), ...AFTER_CHAINS];
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(PROBES.map((p) => p.id).sort());
  });

  it("a conforming fake: every level as before; the chains overlap; rl-l is made as rl-p but at the tag, and removed; nothing of the run's is left", async () => {
    const f = fakeApi();
    const { out, run, liveAtSettle } = await runChains(f);
    expect(levels(out)).toEqual(HAPPY);
    // Each chain removed its own install (rl-l by its tail): the run's
    // cleanup had nothing left to do.
    expect(liveAtSettle).toEqual([]);
    // Overlap: rl-l is suspended before rl-p's rollback (in PROBES order
    // P31 comes first, so a one-at-a-time run can't do this).
    const rll = bySlug(f, "rl-l-");
    const rlp = bySlug(f, "rl-p-");
    const at = (s: string) => f.log.findIndex((l) => l.endsWith(s));
    expect(at(`/installs/${rll?.id}/suspend`)).toBeGreaterThan(-1);
    expect(at(`/installs/${rll?.id}/suspend`)).toBeLessThan(
      at(`/installs/${rlp?.id}/rollback`),
    );
    // rl-l: rl-p's create body, but at the release under test (rl-p's is
    // the previous one, so P45 has an upgrade to make).
    const create = (slug?: string) => f.creates.find((b) => b.slug === slug);
    expect(create(rlp?.slug)?.version).toBe("0.81.0");
    expect(create(rll?.slug)).toEqual({
      ...create(rlp?.slug),
      slug: rll?.slug,
      requestId: run.rid("rll"),
      version: CONFIG.version,
    });
    expect(rll?.slug).toBe("rl-l-1234");
    // P20's suspend went to an install running the tag.
    expect(
      f.log.some((l) => l.endsWith(`/installs/${rll?.id}/suspend`)) &&
        rll?.version === CONFIG.version,
    ).toBe(true);
    expect(live(f)).toEqual([]);
    expect(run.s.cleanup).toEqual([]);
    // P33 ran last and checked every chain's jobs, rl-l's included.
    expect(out.get("P33")).toEqual({
      level: "pass",
      note: `${run.s.jobIds.length} job(s)`,
    });
    const rllJobs = [...f.jobs.values()].filter((j) => j.installId === rll?.id);
    expect(rllJobs.length).toBeGreaterThan(0);
    for (const j of rllJobs) expect(run.s.jobIds).toContain(j.id);
  });

  it("a failed P13 blocks only rl-p's chain, naming P13; the other chains pass and every install is removed", async () => {
    const f = fakeApi();
    f.faults.add("p13_replay_new_job");
    const { out } = await runChains(f);
    expect(out.get("P13")).toMatch(/replay answered another job id/);
    for (const id of RLP_AFTER_P13)
      expect(out.get(id), id).toEqual({
        level: "blocked",
        reason: "blocked by P13",
      });
    const rlpChain = ["P13", ...RLP_AFTER_P13];
    expect(without(levels(out), rlpChain)).toEqual(without(HAPPY, rlpChain));
    expect(live(f)).toEqual([]);
  });

  it("rl-l's create failing is infra on P20 and P22 (P21 blocked by P20), never a fail; rl-p's chain still passes; the failed rl-l is removed", async () => {
    const f = fakeApi();
    f.faults.add("rll_create_failed");
    const { out, run } = await runChains(f);
    const infra = out.get("P20") as string;
    expect(infra).toMatch(
      /^infra: rl-l setup: rl-l create: job failed \(cf_api_error\)/,
    );
    expect(out.get("P22")).toBe(infra);
    expect(out.get("P21")).toEqual({
      level: "blocked",
      reason: "blocked by P20",
    });
    // No install id or host in the reason (the run log is public).
    const rll = bySlug(f, "rl-l-");
    expect(infra).not.toContain(rll?.id);
    expect(infra).not.toContain("open-artifacts");
    const rllChain = ["P20", "P21", "P22"];
    expect(without(levels(out), rllChain)).toEqual(without(HAPPY, rllChain));
    expect(rll?.state).toBe("deleted");
    expect(live(f)).toEqual([]);
    expect(run.s.cleanup).toEqual([]);
  });

  it("rl-l not on the release under test when P20 starts fails P20 before any suspend (P21 blocked); rl-l is still removed", async () => {
    const f = fakeApi();
    f.faults.add("rll_old_version");
    const { out } = await runChains(f);
    expect(out.get("P20")).toBe(
      `P20: rl-l runs 0.81.0, want the release under test ${CONFIG.version}`,
    );
    expect(out.get("P21")).toEqual({
      level: "blocked",
      reason: "blocked by P20",
    });
    const rll = bySlug(f, "rl-l-");
    expect(f.log.some((l) => l.endsWith(`/installs/${rll?.id}/suspend`))).toBe(
      false,
    );
    expect(without(levels(out), ["P20", "P21"])).toEqual(
      without(HAPPY, ["P20", "P21"]),
    );
    expect(rll?.state).toBe("deleted");
    expect(live(f)).toEqual([]);
  });

  it("a failed P22 fails only P22: P20 and P21 pass, rl-p's chain passes, and the tail still removes rl-l", async () => {
    const f = fakeApi();
    f.faults.add("p22_closed_404");
    const { out } = await runChains(f);
    expect(out.get("P22")).toMatch(/P22 closed page/);
    expect(without(levels(out), ["P22"])).toEqual(without(HAPPY, ["P22"]));
    expect(bySlug(f, "rl-l-")?.state).toBe("deleted");
    expect(live(f)).toEqual([]);
  });

  it("a probe past its bound fails naming it and blocks its dependants; another chain and the after step still run", async () => {
    const run = new Run(CONFIG, fakeApi().io);
    let ranAfter = false;
    const ok = async (): Promise<Outcome> => ({ level: "pass" });
    const plan = startChains(run, {
      probes: [
        { id: "P901", title: "hangs", run: () => new Promise(() => {}) },
        { id: "P902", title: "needs it", needs: ["P901"], run: ok },
        { id: "P903", title: "other chain", run: ok },
        {
          id: "P904",
          title: "after",
          run: async () => {
            ranAfter = true;
            return ok();
          },
        },
      ],
      chains: [
        { name: "a", probes: ["P901", "P902"] },
        { name: "b", probes: ["P903"] },
      ],
      after: ["P904"],
      boundMs: () => 30,
    });
    await expect(plan.outcomes.get("P901")).rejects.toThrow(
      "P901: no result within 0 s",
    );
    await expect(plan.outcomes.get("P902")).resolves.toEqual({
      level: "blocked",
      reason: "blocked by P901",
    });
    await expect(plan.outcomes.get("P903")).resolves.toEqual({
      level: "pass",
    });
    await plan.settled;
    expect(ranAfter).toBe(true);
  });

  it("an rl-l removal that fails stays listed, so the run's cleanup removes it", async () => {
    const f = fakeApi();
    const pat = await bringUp(f);
    let refuse = true;
    const run = new Run(CONFIG, {
      ...f.io,
      rlAPat: () => pat,
      fetch: (async (u: string, init?: RequestInit) => {
        const rll = bySlug(f, "rl-l-");
        if (
          refuse &&
          rll &&
          String(u).endsWith(`/installs/${rll.id}/delete`) &&
          !String(init?.body).includes("p22-del")
        )
          return Response.json(
            { error: { code: "internal", message: "x" } },
            { status: 500 },
          );
        return f.io.fetch(u, init);
      }) as unknown as typeof fetch,
    });
    const plan = startChains(run);
    for (const r of plan.outcomes.values()) await r.catch(() => undefined);
    await plan.settled;
    // rl-p and rl-q stay listed too: their purges are probes (P23, P32), and
    // the cleanup's pass over them is a no-op.
    expect(run.s.cleanup).toContainEqual({ slug: "rl-l-1234" });
    expect(bySlug(f, "rl-l-")?.state).toBe("active");
    refuse = false;
    await cleanupInstalls(run);
    expect(run.s.cleanup).toEqual([]);
    expect(live(f)).toEqual([]);
  });

  it("rl-l's create that never finishes: P20 and P22 infra at one job wait; the tail doesn't wait on it again; the run's cleanup still removes rl-l, or fails naming it", async () => {
    const f = fakeApi();
    f.faults.add("rll_create_stuck");
    const pat = await bringUp(f);
    const run = new Run(CONFIG, { ...f.io, rlAPat: () => pat });
    const plan = startChains(run);
    const reason = async (id: ProbeId) =>
      (plan.outcomes.get(id) as Promise<Outcome>).then(
        (o) => o,
        (e: Error) => e.message,
      );
    const p20 = await reason("P20");
    expect(p20).toMatch(
      /^infra: rl-l setup: R15 \S+: still running at upload after 1200 s$/,
    );
    expect(await reason("P22")).toBe(p20);
    const rll = bySlug(f, "rl-l-");
    const create = [...f.jobs.values()].find(
      (j) => j.installId === rll?.id && j.kind === "create",
    );
    expect(create?.status).toBe("running");
    expect(run.s.rllCreateTimedOut).toBe(create?.id);
    const polls = () =>
      f.log.filter((u) => u.endsWith(`/jobs/${create?.id}`)).length;
    const once = polls();
    expect(once).toBeGreaterThan(1);
    for (const r of plan.outcomes.values()) await r.catch(() => undefined);
    await plan.settled;
    // No second wait: the tail made no R15 read of the create, and sent no
    // delete or purge for rl-l. rl-l stays listed for the run's cleanup.
    expect(polls()).toBe(once);
    expect(
      f.log.some(
        (u) =>
          u.endsWith(`/installs/${rll?.id}/delete`) ||
          u.endsWith(`/installs/${rll?.id}/purge`),
      ),
    ).toBe(false);
    expect(run.s.cleanup).toContainEqual({ slug: "rl-l-1234" });
    // Every other chain and P33 still pass.
    const out = new Map<ProbeId, Outcome | string>();
    for (const [id] of plan.outcomes) out.set(id, await reason(id));
    expect(without(levels(out), ["P20", "P21", "P22"])).toEqual(
      without(HAPPY, ["P20", "P21", "P22"]),
    );
    // Still running at the run's end: the cleanup fails naming rl-l and
    // leaves it listed (a leftover keeps the run red).
    await expect(cleanupInstalls(run)).rejects.toThrow(
      /cleanup rl-l-1234: R15 \S+: still running at upload after 1200 s/,
    );
    expect(run.s.cleanup).toContainEqual({ slug: "rl-l-1234" });
    expect(rll?.state).not.toBe("deleted");
    // Once it ends, the cleanup removes it.
    f.faults.delete("rll_create_stuck");
    await cleanupInstalls(run);
    expect(run.s.cleanup).toEqual([]);
    expect(live(f)).toEqual([]);
  });

  it("the after step starts once every chain's probes are done, without waiting for a tail; settled still waits for the tail", async () => {
    const run = new Run(CONFIG, fakeApi().io);
    const order: string[] = [];
    let endTail = () => {};
    const tailHeld = new Promise<void>((r) => {
      endTail = r;
    });
    let endSlow = () => {};
    const slowHeld = new Promise<void>((r) => {
      endSlow = r;
    });
    const step =
      (name: string, wait?: Promise<void>) => async (): Promise<Outcome> => {
        order.push(`${name} start`);
        if (wait) await wait;
        order.push(`${name} end`);
        return { level: "pass" };
      };
    const plan = startChains(run, {
      probes: [
        { id: "P901", title: "tailed chain", run: step("P901") },
        { id: "P903", title: "slow chain", run: step("P903", slowHeld) },
        { id: "P904", title: "after", run: step("P904") },
      ],
      chains: [
        {
          name: "a",
          probes: ["P901"],
          tail: async () => {
            order.push("tail start");
            await tailHeld;
            order.push("tail end");
          },
        },
        { name: "b", probes: ["P903"] },
      ],
      after: ["P904"],
    });
    let settled = false;
    void plan.settled.then(() => {
      settled = true;
    });
    await plan.outcomes.get("P901");
    await new Promise((r) => setTimeout(r, 0));
    // Not before every chain's probes are done.
    expect(order).not.toContain("P904 start");
    endSlow();
    await expect(plan.outcomes.get("P904")).resolves.toEqual({
      level: "pass",
    });
    // The tail is still running: the after step didn't wait for it.
    expect(order).toContain("tail start");
    expect(order).not.toContain("tail end");
    expect(settled).toBe(false);
    endTail();
    await plan.settled;
    expect(order.indexOf("P903 end")).toBeLessThan(order.indexOf("P904 start"));
    expect(order.indexOf("P904 end")).toBeLessThan(order.indexOf("tail end"));
  });

  it("P33 checks only the jobs accepted before it starts, so a tail's cleanup jobs can't race it", async () => {
    const f = fakeApi();
    const { out, run } = await runChains(f);
    expect(out.get("P33")).toEqual({
      level: "pass",
      note: `${run.s.jobIds.length} job(s)`,
    });
    const p33 = PROBES.find((p) => p.id === "P33") as (typeof PROBES)[number];
    // A job id added while P33 reads (no job.accepted row: not this run's)
    // is not judged by that P33.
    let added = false;
    const racing = new Run(CONFIG, {
      ...f.io,
      fetch: (async (u: string, init?: RequestInit) => {
        const r = await f.io.fetch(u, init);
        if (!added && String(u).includes("/audit?")) {
          added = true;
          racing.s.jobIds.push("01RACINGTAILJOB0000000000");
        }
        return r;
      }) as unknown as typeof fetch,
    });
    racing.s.actor = run.s.actor;
    racing.s.jobIds.push(...run.s.jobIds);
    await expect(p33.run(racing)).resolves.toEqual({
      level: "pass",
      note: `${run.s.jobIds.length} job(s)`,
    });
    expect(added).toBe(true);
  });
});

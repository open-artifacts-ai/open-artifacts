import { createHash, randomBytes } from "node:crypto";
import { STAGING_TEST_DOMAIN } from "@oa/provision/names";
import {
  ADMIN_TOOL_NAMES,
  type InstallDetail,
  type Job,
  type Release,
  TOKEN_SCOPES,
} from "@oa/shared/provisioning";

// The red-line provisioning probes (design v7 12.2, P1-P47) against the
// staging Provisioning API, as the GitHub OIDC principal "O" (4.4): `rl-`
// slugs and testHooks only, plus the `x-oa-test-user` self-serve test users
// (P8, P9, P11, P29). Every request goes through ProvIo, so test/
// provisioning.test.ts runs each probe on a fake API with a pinned clock.
// Failure text is a status, an error code and a body hash, never a body.

export type ProbeId = `P${number}`;

export interface ProvConfig {
  /** https://api.open-artifacts-staging.app (paths under /v1). */
  api: string;
  /** https://admin.open-artifacts-staging.app (paths under /api/v1). */
  admin: string;
  /** The staging auth broker, https://auth.open-artifacts-staging.app. */
  broker: string;
  prodApi: string;
  prodAdmin: string;
  /** This run's id (slugs rl-p-<run>, rl-q-<run>, request ids). */
  runId: string;
  /** The release under test (the workflow's tag input), x.y.z. */
  version: string;
  /** A workflow_dispatch run (P30 runs only then). */
  dispatch: boolean;
  rlA: { id: string; app: string };
  rlB: { id: string; app: string };
  /** The one MCP_REDIRECT_URIS entry the API accepts (P44's valid client). */
  mcpRedirectUri: string;
  /** The staging inventory origin (P15, P20-P23, P27). */
  inventory?: string;
  /** The prod inventory origin (P27's staging-token-on-prod leg). */
  prodInventory?: string;
}

export interface ProvIo {
  fetch: typeof fetch;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Waits `ms` between polls (tests advance a pinned clock). */
  wait: (ms: number) => Promise<void>;
  /** The provisioning-audience OIDC JWT. */
  jwt: () => Promise<string>;
  /** The staging inventory OIDC JWT (P6's wrong audience, P27). */
  stgInventoryJwt?: () => Promise<string>;
  /** The prod inventory OIDC JWT (unused by probes: never sent to staging). */
  prodInventoryJwt?: () => Promise<string>;
  /** The rl-a admin PAT R26 sealed for this run (P36). */
  rlAPat?: () => string;
}

export type Outcome =
  | { level: "pass"; note?: string }
  | { level: "not-applicable" | "unproven-live"; reason: string };

const pass = (note?: string): Outcome =>
  note ? { level: "pass", note } : { level: "pass" };
const na = (reason: string): Outcome => ({ level: "not-applicable", reason });
const unproven = (reason: string): Outcome => ({
  level: "unproven-live",
  reason,
});

/** A probe failure: the message is safe for a public report. */
export class ProbeFail extends Error {
  override name = "ProbeFail";
}

/** Poll cadence and bounds (12.2: paused and resumed pages within 120 s). */
export const POLL_MS = 3_000;
export const PAGE_WITHIN_MS = 120_000;
export const JOB_WITHIN_MS = 20 * 60_000;
/** A case's vitest timeout: its slowest wait plus margin. */
export const PROBE_TIMEOUT_MS = JOB_WITHIN_MS + 5 * 60_000;
export const P34_REQUESTS = 400;
export const P25_REQUESTS = 15;
export const P44_REGISTRATIONS = 11;
export const P42_BYTES = 40 * 1024;
export const DUMMY_TURNSTILE = "XXXX.DUMMY.TOKEN.XXXX";
export const EVIL = "https://evil.example";

// --- HTTP ----------------------------------------------------------------

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

type Auth = "oidc" | "none" | { bearer: string };
type Host = "api" | "admin" | "prodApi" | "prodAdmin";

export interface CallOpts {
  method?: string;
  host?: Host;
  body?: unknown;
  auth?: Auth;
  testUser?: "a" | "b" | "c";
  headers?: Record<string, string>;
}

export class Run {
  readonly c: ProvConfig;
  readonly io: ProvIo;
  /** Shared state between ordered probes. */
  readonly s: RunState = { jobIds: [] };
  constructor(c: ProvConfig, io: ProvIo) {
    this.c = c;
    this.io = io;
  }

  origin(h: Host): string {
    return {
      api: this.c.api,
      admin: this.c.admin,
      prodApi: this.c.prodApi,
      prodAdmin: this.c.prodAdmin,
    }[h];
  }

  /** `path` is under the route base: /v1 on api hosts, /api/v1 on admin hosts. */
  async v1(path: string, o: CallOpts = {}): Promise<Res> {
    const host = o.host ?? "api";
    const base = host === "api" || host === "prodApi" ? "/v1" : "/api/v1";
    return this.raw(`${this.origin(host)}${base}${path}`, o);
  }

  async raw(url: string, o: CallOpts = {}): Promise<Res> {
    const headers = new Headers(o.headers);
    const auth = o.auth ?? "oidc";
    if (auth === "oidc")
      headers.set("authorization", `Bearer ${await this.io.jwt()}`);
    else if (auth !== "none")
      headers.set("authorization", `Bearer ${auth.bearer}`);
    if (o.testUser) headers.set("x-oa-test-user", o.testUser);
    let body: string | undefined;
    if (o.body !== undefined) {
      body = typeof o.body === "string" ? o.body : JSON.stringify(o.body);
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
    }
    const res = await this.io.fetch(url, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      headers,
      body,
      redirect: "manual",
    });
    let text = "";
    try {
      text = await res.text();
    } catch {}
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  /** A request id unique to this run and purpose (idempotent on a rerun). */
  rid(tag: string): string {
    return `rl${this.c.runId}-${tag}`
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 64)
      .padEnd(16, "0");
  }

  slug(letter: string): string {
    return `rl-${letter}-${this.c.runId}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 32)
      .replace(/-+$/, "");
  }

  /** Polls R15 until the job is done or failed (or `until` holds). */
  async waitJob(
    jobId: string,
    o: {
      testUser?: "a" | "b" | "c";
      until?: (j: Job) => boolean;
      within?: number;
    } = {},
  ): Promise<Job> {
    const end = this.io.now() + (o.within ?? JOB_WITHIN_MS);
    for (;;) {
      const r = await this.v1(`/jobs/${jobId}`, { testUser: o.testUser });
      if (r.status !== 200) throw new ProbeFail(`R15 ${jobId}: ${desc(r)}`);
      const j = r.json as Job;
      if (o.until ? o.until(j) : j.status === "done" || j.status === "failed")
        return j;
      if (this.io.now() >= end)
        throw new ProbeFail(
          `R15 ${jobId}: still ${j.status} at ${j.step ?? "?"} after ${Math.round((o.within ?? JOB_WITHIN_MS) / 1000)} s`,
        );
      await this.io.wait(POLL_MS);
    }
  }

  /** Waits for a job and requires `done`. */
  async done(
    jobId: string,
    what: string,
    testUser?: "a" | "b" | "c",
  ): Promise<Job> {
    const j = await this.waitJob(jobId, { testUser });
    if (j.status !== "done")
      throw new ProbeFail(
        `${what}: job ${j.status} (${j.lastErrorCode ?? j.error?.code ?? "no code"})`,
      );
    return j;
  }

  /** Polls `check` until it returns true, within `ms`. */
  async within(
    ms: number,
    what: string,
    check: () => Promise<boolean>,
  ): Promise<void> {
    const end = this.io.now() + ms;
    for (;;) {
      if (await check()) return;
      if (this.io.now() >= end)
        throw new ProbeFail(`${what}: not within ${Math.round(ms / 1000)} s`);
      await this.io.wait(POLL_MS);
    }
  }

  /** A 202 Accepted's job; an OIDC caller's is recorded for P33. */
  accepted(
    r: Res,
    what: string,
    o: { asTestUser?: boolean } = {},
  ): {
    job: Job;
    install: { id: string; slug: string; appHost: string; contentHost: string };
  } {
    if (r.status !== 202) throw new ProbeFail(`${what}: ${desc(r)}`);
    const a = r.json as {
      job: Job;
      install: {
        id: string;
        slug: string;
        appHost: string;
        contentHost: string;
      };
    };
    if (!a?.job?.id) throw new ProbeFail(`${what}: no job in the answer`);
    if (o.asTestUser) return a;
    if (!this.s.jobIds.includes(a.job.id)) this.s.jobIds.push(a.job.id);
    if (!this.s.actor) this.s.actor = a.job.actor.label;
    return a;
  }

  /** GET <inventory><path> with the staging inventory JWT. */
  async inventory(path: string): Promise<unknown> {
    if (!this.c.inventory || !this.io.stgInventoryJwt)
      throw new ProbeFail("no staging inventory configured");
    const r = await this.raw(`${this.c.inventory}${path}`, {
      auth: { bearer: await this.io.stgInventoryJwt() },
    });
    if (r.status !== 200)
      throw new ProbeFail(`inventory ${path.split("?")[0]}: ${desc(r)}`);
    return r.json;
  }

  async hostMode(
    host: string,
  ): Promise<{ installId: string | null; mode: string | null }> {
    const v = (await this.inventory(
      `/hosts?host=${encodeURIComponent(host)}`,
    )) as { installId?: string | null; mode?: string | null };
    return { installId: v?.installId ?? null, mode: v?.mode ?? null };
  }

  /** A public GET on a tenant host (no credential). */
  async page(host: string, path = "/healthz"): Promise<Res> {
    return this.raw(`https://${bare(host)}${path}`, { auth: "none" });
  }
}

export interface RlP {
  id: string;
  slug: string;
  appHost: string;
  contentHost: string;
  /** The version it was created at. */
  createdAt: string;
  /** The version it runs now (P16's late upgrade, P45 move it). */
  version: string;
}

export interface RunState {
  jobIds: string[];
  /** The OIDC actor label (Job.actor.label). */
  actor?: string;
  rlp?: RlP;
  createJobId?: string;
  /** P15: what was seen before the route step ran. */
  p15?: { checked: number; violations: string[] };
  /** P16: the upgrade sent while the create ran ("late": it was accepted). */
  p16?: Res | "late";
  /** A non-rl install id from inventory (P10, P45). */
  panelInstall?: string | null;
  releases?: Release[];
  /** P44's first registered client, for P43. */
  clientId?: string;
}

const bare = (h: string) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** status, error code and body hash: what a failure may say. */
export function desc(r: Res): string {
  const code = errCode(r);
  const h = createHash("sha256").update(r.text).digest("hex").slice(0, 16);
  return `status ${r.status}, body sha256:${h} (${Buffer.byteLength(r.text)} bytes)${code ? `, code ${code}` : ""}`;
}

/** The API envelope's error.code, or an OAuth error string. */
export function errCode(r: Pick<Res, "json">): string | undefined {
  const j = r.json as { error?: unknown } | undefined;
  if (!j || typeof j !== "object") return undefined;
  if (typeof j.error === "string") return j.error;
  const c = (j.error as { code?: unknown } | undefined)?.code;
  return typeof c === "string" ? c : undefined;
}

function expect(r: Res, status: number, what: string, code?: string): void {
  if (r.status !== status || (code !== undefined && errCode(r) !== code))
    throw new ProbeFail(
      `${what}: want ${status}${code ? ` ${code}` : ""}, got ${desc(r)}`,
    );
}

const ulidish = () => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const b = randomBytes(25);
  return `0${[...b].map((x) => A[x % 32]).join("")}`;
};
const b64u = (s: string) => Buffer.from(s).toString("base64url");

// --- MCP -----------------------------------------------------------------

/** One JSON-RPC call on api /mcp; a JSON or SSE answer. */
export async function mcp(
  run: Run,
  method: string,
  params: unknown,
  o: {
    auth?: Auth;
    host?: Host;
    headers?: Record<string, string>;
    id?: number;
  } = {},
): Promise<
  Res & {
    rpc?: { result?: unknown; error?: { code: number; message: string } };
  }
> {
  const r = await run.raw(`${run.origin(o.host ?? "api")}/mcp`, {
    method: "POST",
    auth: o.auth ?? "oidc",
    body: { jsonrpc: "2.0", id: o.id ?? 1, method, params },
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...o.headers,
    },
  });
  let rpc: unknown = r.json;
  if (rpc === undefined && r.text.includes("data:")) {
    for (const line of r.text.split(/\r?\n/))
      if (line.startsWith("data:")) {
        try {
          rpc = JSON.parse(line.slice(5).trim());
        } catch {}
      }
  }
  return {
    ...r,
    rpc: rpc as { result?: unknown; error?: { code: number; message: string } },
  };
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function tool(
  run: Run,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const r = await mcp(run, "tools/call", { name, arguments: args });
  if (r.status !== 200 || !r.rpc?.result)
    throw new ProbeFail(
      `tools/call ${name}: ${desc(r)}${r.rpc?.error ? `, rpc ${r.rpc.error.code}` : ""}`,
    );
  return r.rpc.result as ToolResult;
}

const toolCode = (t: ToolResult) =>
  (t.structuredContent?.error as { code?: string } | undefined)?.code;

// --- Probes ----------------------------------------------------------------

export interface Probe {
  id: ProbeId;
  title: string;
  run: (r: Run) => Promise<Outcome>;
}

/** Prod probes wait until the prod admin host answers 401 (12.2). */
async function prodLive(run: Run): Promise<boolean> {
  const r = await run.v1("/me", { host: "prodAdmin", auth: "none" });
  return r.status === 401;
}

function rlp(run: Run): RlP {
  if (!run.s.rlp) throw new ProbeFail("no rl-p install (P13 failed)");
  return run.s.rlp;
}

async function releases(run: Run): Promise<Release[]> {
  if (run.s.releases) return run.s.releases;
  const r = await run.v1("/releases");
  expect(r, 200, "R16");
  run.s.releases = (r.json as { items: Release[] }).items;
  return run.s.releases;
}

const cmpVer = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** The newest installable release below the one under test, if any. */
async function previous(run: Run): Promise<string | undefined> {
  return (await releases(run))
    .filter(
      (r) =>
        r.installable &&
        r.variants.includes("redline") &&
        cmpVer(r.version, run.c.version) < 0,
    )
    .map((r) => r.version)
    .sort(cmpVer)
    .pop();
}

async function detail(
  run: Run,
  id: string,
  testUser?: "a" | "b" | "c",
): Promise<Res> {
  return run.v1(`/installs/${id}`, { testUser });
}

async function panelInstall(run: Run): Promise<string | null> {
  if (run.s.panelInstall !== undefined) return run.s.panelInstall;
  const v = (await run.inventory("/installs")) as {
    installs?: { id: string; appHost: string | null; state?: string }[];
  };
  // A live one only: a deleted or purged install's 404 proves no scoping.
  const live = (v?.installs ?? []).filter(
    (x) =>
      x.appHost &&
      !bare(x.appHost).startsWith("rl-") &&
      x.state !== undefined &&
      !["deleted", "deleting"].includes(x.state),
  );
  const i = live.find((x) => x.state === "active") ?? live[0];
  run.s.panelInstall = i?.id ?? null;
  return run.s.panelInstall;
}

const oidcCreate = (
  run: Run,
  slug: string,
  requestId: string,
  version?: string,
) => ({
  requestId,
  slug,
  ownerEmail: `redline-owner@${STAGING_TEST_DOMAIN}`,
  tier: "team",
  auth: { providers: ["email"], domains: [] },
  testHooks: true,
  ...(version ? { version } : {}),
});

export const PROBES: readonly Probe[] = [
  {
    id: "P1",
    title: "GET /api/v1/me on the admin host, no cookie: 401",
    run: async (run) => {
      expect(await run.v1("/me", { host: "admin", auth: "none" }), 401, "P1");
      return pass();
    },
  },
  {
    id: "P2",
    title: "a forged __Host-oa-admin: 401",
    run: async (run) => {
      const r = await run.v1("/me", {
        host: "admin",
        auth: "none",
        headers: {
          cookie: `__Host-oa-admin=${randomBytes(32).toString("base64url")}`,
        },
      });
      expect(r, 401, "P2");
      return pass();
    },
  },
  {
    id: "P3",
    title: "the api host with only a Cookie: 401",
    run: async (run) => {
      const r = await run.v1("/me", {
        auth: "none",
        headers: {
          cookie: `__Host-oa-admin=${randomBytes(32).toString("base64url")}`,
        },
      });
      expect(r, 401, "P3");
      return pass();
    },
  },
  {
    id: "P4",
    title: "the admin host with an OIDC bearer: 401",
    run: async (run) => {
      expect(await run.v1("/me", { host: "admin" }), 401, "P4");
      return pass();
    },
  },
  {
    id: "P5",
    title:
      "POST /api/v1/installs with Origin https://evil.example: 403 csrf_failed",
    run: async (run) => {
      const r = await run.v1("/installs", {
        host: "admin",
        auth: "none",
        body: { requestId: run.rid("p5") },
        headers: { origin: EVIL },
      });
      expect(r, 403, "P5", "csrf_failed");
      return pass();
    },
  },
  {
    id: "P6",
    title: "OIDC with a wrong aud, tampered, alg none: 401 each",
    run: async (run) => {
      if (!run.io.stgInventoryJwt)
        throw new ProbeFail("P6: no second-audience JWT to send");
      const wrongAud = await run.io.stgInventoryJwt();
      const good = await run.io.jwt();
      const [h, p, sig] = good.split(".");
      const claims = JSON.parse(
        Buffer.from(p ?? "", "base64url").toString("utf8"),
      );
      const tampered = `${h}.${b64u(JSON.stringify({ ...claims, ref: "refs/heads/evil" }))}.${sig}`;
      const none = `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${p}.`;
      for (const [what, bearer] of [
        ["wrong aud", wrongAud],
        ["tampered", tampered],
        ["alg none", none],
      ] as const)
        expect(await run.v1("/me", { auth: { bearer } }), 401, `P6 ${what}`);
      return pass();
    },
  },
  {
    id: "P7",
    title: "staging OIDC against prod /v1/me: 401",
    run: async (run) => {
      if (!(await prodLive(run)))
        return na("prod admin /api/v1/me does not answer 401 yet");
      expect(await run.v1("/me", { host: "prodApi" }), 401, "P7");
      return pass();
    },
  },
  {
    id: "P8",
    title: "test user a: list shows its own only; GET rl-a is 404",
    run: async (run) => {
      const l = await run.v1("/installs", { testUser: "a" });
      expect(l, 200, "P8 list");
      const items = (l.json as { items: { slug: string; source: string }[] })
        .items;
      const foreign = items.filter(
        (i) => i.source !== "self-serve" || /^rl-(a|b|p-|q-)/.test(i.slug),
      );
      if (foreign.length)
        throw new ProbeFail(
          `P8: the list holds ${foreign.length} install(s) not test user a's`,
        );
      expect(await detail(run, run.c.rlA.id, "a"), 404, "P8 GET rl-a");
      return pass();
    },
  },
  {
    id: "P9",
    title: "test user a: create with ownerEmail or tier: 403",
    run: async (run) => {
      const base = {
        requestId: run.rid("p9-owner"),
        slug: run.slug("u"),
        turnstile: DUMMY_TURNSTILE,
      };
      expect(
        await run.v1("/installs", {
          testUser: "a",
          body: { ...base, ownerEmail: `x@${STAGING_TEST_DOMAIN}` },
        }),
        403,
        "P9 ownerEmail",
      );
      expect(
        await run.v1("/installs", {
          testUser: "a",
          body: { ...base, requestId: run.rid("p9-tier"), tier: "team" },
        }),
        403,
        "P9 tier",
      );
      return pass();
    },
  },
  {
    id: "P10",
    title: "OIDC: GET and upgrade of an install without rl-: 404",
    run: async (run) => {
      const id = await panelInstall(run);
      if (!id) return na("no panel-made (non rl-) install on staging");
      expect(await detail(run, id), 404, "P10 GET");
      expect(
        await run.v1(`/installs/${id}/upgrade`, {
          body: { requestId: run.rid("p10") },
        }),
        404,
        "P10 upgrade",
      );
      return pass();
    },
  },
  {
    id: "P11",
    title: "test user a: upgrade rl-a: 403",
    run: async (run) => {
      const r = await run.v1(`/installs/${run.c.rlA.id}/upgrade`, {
        testUser: "a",
        body: { requestId: run.rid("p11") },
      });
      expect(r, 403, "P11");
      return pass();
    },
  },
  {
    id: "P12",
    title: "OIDC: R13, R19, R25: 403 each",
    run: async (run) => {
      expect(
        await run.v1(`/installs/${run.c.rlA.id}/release-lease`, {
          body: { requestId: run.rid("p12-r13"), confirmSlug: "rl-a" },
        }),
        403,
        "P12 R13",
      );
      expect(
        await run.v1("/tokens", {
          body: {
            requestId: run.rid("p12-r19"),
            label: "redline",
            scopes: ["installs:read"],
          },
        }),
        403,
        "P12 R19",
      );
      const jobs = await run.v1(`/installs/${run.c.rlA.id}/jobs?limit=1`);
      const jobId =
        (jobs.json as { items?: { id: string }[] } | undefined)?.items?.[0]
          ?.id ?? ulidish();
      expect(
        await run.v1(`/jobs/${jobId}/cancel`, {
          body: { requestId: run.rid("p12-r25"), confirmSlug: "rl-a" },
        }),
        403,
        "P12 R25",
      );
      return pass();
    },
  },
  {
    id: "P13",
    title:
      "create rl-p-<run> twice with one requestId: one job, one install, done (redline variant)",
    run: async (run) => {
      const slug = run.slug("p");
      const before = await run.v1(`/installs?q=${slug}`);
      expect(before, 200, "P13 list before");
      const n0 = (before.json as { items: { slug: string }[] }).items.filter(
        (i) => i.slug === slug,
      ).length;
      const version = (await previous(run)) ?? run.c.version;
      const body = oidcCreate(run, slug, run.rid("p13"), version);
      const a = run.accepted(await run.v1("/installs", { body }), "P13 create");
      run.s.rlp = {
        id: a.install.id,
        slug,
        appHost: a.install.appHost,
        contentHost: a.install.contentHost,
        createdAt: version,
        version,
      };
      run.s.createJobId = a.job.id;
      // P16 rides on the running create.
      const up = await run.v1(`/installs/${a.install.id}/upgrade`, {
        body: { requestId: run.rid("p16"), version: run.c.version },
      });
      // A 202 means the create had already finished: P16 is then unproven,
      // and the upgrade runs to done below before the later probes.
      let lateJob: string | undefined;
      if (up.status === 202) {
        lateJob = run.accepted(up, "P16 upgrade").job.id;
        run.s.p16 = "late";
      } else run.s.p16 = up;
      const again = await run.v1("/installs", { body });
      if (again.status < 200 || again.status > 202)
        throw new ProbeFail(`P13 replay: ${desc(again)}`);
      if ((again.json as { job?: { id?: string } })?.job?.id !== a.job.id)
        throw new ProbeFail("P13: the replay answered another job id");
      // P15: before `route`, inventory says mode null and /healthz is 404.
      const p15 = { checked: 0, violations: [] as string[] };
      run.s.p15 = p15;
      const routeAt = a.job.steps.indexOf("route");
      if (routeAt >= 0) {
        const end = run.io.now() + JOB_WITHIN_MS;
        while ((await p15Check(run, a.job.id, routeAt)) === "before") {
          if (run.io.now() >= end)
            throw new ProbeFail("P13: the create never reached route");
          await run.io.wait(POLL_MS);
        }
      }
      const final = await run.done(a.job.id, "P13 create");
      if (lateJob) {
        await run.done(lateJob, "P16 late upgrade");
        run.s.rlp.version = run.c.version;
      }
      const after = await run.v1(`/installs?q=${slug}`);
      const n1 = (after.json as { items: { slug: string }[] }).items.filter(
        (i) => i.slug === slug,
      ).length;
      if (n1 - n0 !== 1)
        throw new ProbeFail(`P13: installs +${n1 - n0}, want +1`);
      const d = await detail(run, a.install.id);
      expect(d, 200, "P13 R3");
      if ((d.json as InstallDetail).testHooks !== true)
        throw new ProbeFail("P13: testHooks is not true");
      const h = await run.page(a.install.appHost);
      const hz = h.json as { testHooks?: unknown } | undefined;
      if (h.status !== 200 || hz?.testHooks !== true)
        throw new ProbeFail(
          `P13: /healthz is not the redline variant (${desc(h)})`,
        );
      return pass(`job ${final.id} at ${version}`);
    },
  },
  {
    id: "P14",
    title: "a second create of that slug with a new requestId: 409 slug_taken",
    run: async (run) => {
      const p = rlp(run);
      expect(
        await run.v1("/installs", {
          body: oidcCreate(run, p.slug, run.rid("p14")),
        }),
        409,
        "P14",
        "slug_taken",
      );
      return pass();
    },
  },
  {
    id: "P15",
    title:
      "during the create: inventory mode null and public /healthz 404 until route",
    run: async (run) => {
      // Without the inventory, p15Check reads mode as null: /healthz alone
      // would pass the probe.
      if (!run.c.inventory || !run.io.stgInventoryJwt)
        throw new ProbeFail("P15: no staging inventory configured");
      const p = run.s.p15;
      if (!p) throw new ProbeFail("P15: P13 never ran its create");
      if (p.violations.length)
        throw new ProbeFail(`P15: ${p.violations.join("; ")}`);
      if (p.checked === 0)
        return unproven("the create reached route before a check could run");
      return pass(`${p.checked} check(s) before route`);
    },
  },
  {
    id: "P16",
    title: "upgrade while its create runs: 409 job_in_progress",
    run: async (run) => {
      const r = run.s.p16;
      if (!r) throw new ProbeFail("P16: P13 never sent it");
      if (r === "late") return unproven("the create had finished first");
      expect(r, 409, "P16", "job_in_progress");
      return pass();
    },
  },
  {
    id: "P17",
    title: "create with version 0.0.1: 422 release_not_published",
    run: async (run) => {
      const r = await run.v1("/installs", {
        body: oidcCreate(run, run.slug("v"), run.rid("p17"), "0.0.1"),
      });
      expect(r, 422, "P17", "release_not_published");
      return pass();
    },
  },
  {
    id: "P18",
    title: "upgrade to its current version: 409 downgrade_refused",
    run: async (run) => {
      const p = rlp(run);
      const r = await run.v1(`/installs/${p.id}/upgrade`, {
        body: { requestId: run.rid("p18"), version: p.version },
      });
      expect(r, 409, "P18", "downgrade_refused");
      return pass();
    },
  },
  {
    id: "P19",
    title: "delete with a wrong confirmSlug: 400; unchanged",
    run: async (run) => {
      const p = rlp(run);
      const r = await run.v1(`/installs/${p.id}/delete`, {
        body: { requestId: run.rid("p19"), confirmSlug: "rl-wrong" },
      });
      if (r.status !== 400)
        throw new ProbeFail(`P19: want 400, got ${desc(r)}`);
      const d = await detail(run, p.id);
      if ((d.json as InstallDetail | undefined)?.state !== "active")
        throw new ProbeFail("P19: the install is no longer active");
      return pass();
    },
  },
  {
    id: "P45",
    title:
      "OIDC on /mcp: tools/list, get_world, get_install, delete_install refusal, upgrade_install",
    run: async (run) => {
      const p = rlp(run);
      const init = await mcp(run, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oa-redline", version: "1" },
      });
      if (init.status !== 200 || !init.rpc?.result)
        throw new ProbeFail(`P45 initialize: ${desc(init)}`);
      const list = await mcp(run, "tools/list", {});
      const names = (
        (list.rpc?.result as { tools?: { name: string }[] })?.tools ?? []
      )
        .map((t) => t.name)
        .sort();
      if (
        JSON.stringify(names) !== JSON.stringify([...ADMIN_TOOL_NAMES].sort())
      )
        throw new ProbeFail("P45: tools/list names differ from ADMIN_TOOLS");
      // get_world equals REST R27 for this principal (O is 403 on R27: 4.2).
      const world = await tool(run, "get_world", {});
      const rest = await run.v1("/world");
      if (rest.status === 200) {
        if (world.isError)
          throw new ProbeFail(`P45 get_world: ${toolCode(world)}`);
      } else if (!world.isError || toolCode(world) !== errCode(rest))
        throw new ProbeFail(
          `P45 get_world: ${toolCode(world) ?? "ok"} on /mcp, ${desc(rest)} on /v1`,
        );
      const gi = await tool(run, "get_install", { id: p.id });
      const gr = await detail(run, p.id);
      if (
        gi.isError ||
        JSON.stringify(gi.structuredContent) !== JSON.stringify(gr.json)
      )
        throw new ProbeFail(
          "P45: get_install differs from GET /v1/installs/:id",
        );
      const other = await panelInstall(run);
      if (other) {
        const o = await tool(run, "get_install", { id: other });
        if (!o.isError || toolCode(o) !== "not_found")
          throw new ProbeFail(
            "P45: get_install of a non-rl install is not not_found",
          );
      }
      const del = await tool(run, "delete_install", {
        id: p.id,
        requestId: run.rid("p45-del"),
        confirmSlug: "rl-wrong",
      });
      if (!del.isError || toolCode(del) !== "confirm_mismatch")
        throw new ProbeFail(`P45 delete_install: ${toolCode(del) ?? "ok"}`);
      if (((await detail(run, p.id)).json as InstallDetail).state !== "active")
        throw new ProbeFail("P45: delete_install changed the install");
      if (p.version === run.c.version)
        return unproven(
          p.createdAt === run.c.version
            ? "no older installable release: upgrade_install has nothing to upgrade to"
            : "P16's upgrade was accepted (the create had finished): upgrade_install has nothing to upgrade to",
        );
      const up = await tool(run, "upgrade_install", {
        id: p.id,
        requestId: run.rid("p45-up"),
        version: run.c.version,
      });
      if (up.isError)
        throw new ProbeFail(`P45 upgrade_install: ${toolCode(up)}`);
      const job = (up.structuredContent as { job?: Job })?.job;
      if (!job?.id) throw new ProbeFail("P45 upgrade_install: no job");
      run.s.jobIds.push(job.id);
      if (job.actor.kind !== "oidc" || job.actor.label !== run.s.actor)
        throw new ProbeFail("P45: the job's actor is not the OIDC actor");
      await run.done(job.id, "P45 upgrade_install");
      p.version = run.c.version;
      return pass(
        other ? undefined : "no non-rl install for the not_found leg",
      );
    },
  },
  {
    id: "P31",
    title:
      "rollback of the rl-p install after an upgrade: the previous version",
    run: async (run) => {
      const p = rlp(run);
      if (p.createdAt === run.c.version)
        return na("no older installable release, so no upgrade to roll back");
      if (p.version === p.createdAt)
        return unproven("no upgrade reached done, so none to roll back");
      const a = run.accepted(
        await run.v1(`/installs/${p.id}/rollback`, {
          body: { requestId: run.rid("p31") },
        }),
        "P31",
      );
      await run.done(a.job.id, "P31 rollback");
      const v = ((await detail(run, p.id)).json as InstallDetail).version;
      if (v !== p.createdAt)
        throw new ProbeFail(`P31: version ${v}, want ${p.createdAt}`);
      p.version = v;
      return pass();
    },
  },
  {
    id: "P20",
    title:
      "suspend: 503 paused page on both hosts within 120 s; inventory paused",
    run: async (run) => {
      const p = rlp(run);
      const a = run.accepted(
        await run.v1(`/installs/${p.id}/suspend`, {
          body: { requestId: run.rid("p20"), reason: "red-line P20" },
        }),
        "P20",
      );
      await run.done(a.job.id, "P20 suspend");
      await run.within(
        PAGE_WITHIN_MS,
        "P20 paused page",
        async () =>
          (await run.page(p.appHost, "/")).status === 503 &&
          (await run.page(p.contentHost, "/")).status === 503,
      );
      const m = await run.hostMode(p.appHost);
      if (m.mode !== "paused")
        throw new ProbeFail(`P20: inventory mode ${m.mode}`);
      return pass();
    },
  },
  {
    id: "P21",
    title: "resume: 200 within 120 s",
    run: async (run) => {
      const p = rlp(run);
      const a = run.accepted(
        await run.v1(`/installs/${p.id}/resume`, {
          body: { requestId: run.rid("p21") },
        }),
        "P21",
      );
      await run.done(a.job.id, "P21 resume");
      await run.within(
        PAGE_WITHIN_MS,
        "P21 /healthz 200",
        async () => (await run.page(p.appHost)).status === 200,
      );
      return pass();
    },
  },
  {
    id: "P22",
    title: "delete, then restore: 503 closed page on both hosts, then serving",
    run: async (run) => {
      const p = rlp(run);
      const d = run.accepted(
        await run.v1(`/installs/${p.id}/delete`, {
          body: { requestId: run.rid("p22-del"), confirmSlug: p.slug },
        }),
        "P22 delete",
      );
      await run.done(d.job.id, "P22 delete");
      await run.within(
        PAGE_WITHIN_MS,
        "P22 closed page",
        async () =>
          (await run.page(p.appHost, "/")).status === 503 &&
          (await run.page(p.contentHost, "/")).status === 503,
      );
      if ((await run.hostMode(p.appHost)).mode !== "closed")
        throw new ProbeFail("P22: inventory mode is not closed");
      const r = run.accepted(
        await run.v1(`/installs/${p.id}/restore`, {
          body: { requestId: run.rid("p22-res") },
        }),
        "P22 restore",
      );
      await run.done(r.job.id, "P22 restore");
      await run.within(
        PAGE_WITHIN_MS,
        "P22 serving",
        async () => (await run.page(p.appHost)).status === 200,
      );
      if ((await run.hostMode(p.appHost)).mode !== "serving")
        throw new ProbeFail("P22: inventory mode is not serving");
      return pass();
    },
  },
  {
    id: "P23",
    title: "delete, then purge: 404; inventory deleted; no HOSTS key",
    run: async (run) => {
      const p = rlp(run);
      const d = run.accepted(
        await run.v1(`/installs/${p.id}/delete`, {
          body: { requestId: run.rid("p23-del"), confirmSlug: p.slug },
        }),
        "P23 delete",
      );
      await run.done(d.job.id, "P23 delete");
      const g = run.accepted(
        await run.v1(`/installs/${p.id}/purge`, {
          body: { requestId: run.rid("p23-purge"), confirmSlug: p.slug },
        }),
        "P23 purge",
      );
      await run.done(g.job.id, "P23 purge");
      await run.within(
        PAGE_WITHIN_MS,
        "P23 404",
        async () => (await run.page(p.appHost)).status === 404,
      );
      const inv = (await run.inventory("/installs")) as {
        installs?: { id: string; state: string }[];
      };
      const row = inv?.installs?.find((i) => i.id === p.id);
      if (!row) throw new ProbeFail("P23: inventory has no row for it");
      if (row.state !== "deleted")
        throw new ProbeFail(`P23: inventory state ${row.state}`);
      const m = await run.hostMode(p.appHost);
      if (m.installId !== null || m.mode !== null)
        throw new ProbeFail("P23: HOSTS still maps the app host");
      return pass();
    },
  },
  {
    id: "P24",
    title:
      "rl-a and rl-b run the release under test (upgraded by the workflow, R5)",
    run: async (run) => {
      for (const t of [run.c.rlA, run.c.rlB]) {
        const d = await detail(run, t.id);
        expect(d, 200, `P24 R3 ${t.id}`);
        const v = (d.json as InstallDetail).version;
        if (v !== run.c.version)
          throw new ProbeFail(
            `P24: ${(d.json as InstallDetail).slug} runs ${v}, want ${run.c.version}`,
          );
      }
      return pass();
    },
  },
  {
    id: "P26",
    title: "GET /auth/test-signin: 404 (staging; prod when applicable)",
    run: async (run) => {
      expect(
        await run.raw(`${run.c.admin}/auth/test-signin`, { auth: "none" }),
        404,
        "P26 staging",
      );
      if (!(await prodLive(run)))
        return pass("prod half gated: prod admin is not live");
      expect(
        await run.raw(`${run.c.prodAdmin}/auth/test-signin`, { auth: "none" }),
        404,
        "P26 prod",
      );
      return pass();
    },
  },
  {
    id: "P27",
    title:
      "inventory: no token, wrong audience, staging token on prod: 404 each; correct 200",
    run: async (run) => {
      if (!run.c.inventory || !run.io.stgInventoryJwt)
        throw new ProbeFail("P27: no staging inventory configured");
      const u = `${run.c.inventory}/installs`;
      expect(await run.raw(u, { auth: "none" }), 404, "P27 no token");
      expect(
        await run.raw(u, { auth: { bearer: await run.io.jwt() } }),
        404,
        "P27 wrong audience",
      );
      expect(
        await run.raw(u, { auth: { bearer: await run.io.stgInventoryJwt() } }),
        200,
        "P27 correct",
      );
      if (!run.c.prodInventory)
        return unproven(
          "no prod inventory URL: the staging-token-on-prod leg did not run",
        );
      expect(
        await run.raw(`${run.c.prodInventory}/installs`, {
          auth: { bearer: await run.io.stgInventoryJwt() },
        }),
        404,
        "P27 staging on prod",
      );
      return pass();
    },
  },
  {
    id: "P28",
    title: "GET /releases: the release under test is installable",
    run: async (run) => {
      run.s.releases = undefined;
      const r = (await releases(run)).find((x) => x.version === run.c.version);
      if (!r?.installable)
        throw new ProbeFail(
          `P28: ${run.c.version} is ${r ? "not installable" : "not listed"}`,
        );
      return pass();
    },
  },
  {
    id: "P29",
    title:
      "SIGNUPS_ENABLED=test-users: test user b self-serve create reaches done; delete leaves it deleting",
    run: async (run) => {
      const slug = run.slug("s");
      const c = await run.v1("/installs", {
        testUser: "b",
        body: { requestId: run.rid("p29"), slug, turnstile: DUMMY_TURNSTILE },
      });
      // 7 and 12.2: staging runs SIGNUPS_ENABLED=test-users; closed is drift.
      if (c.status === 503 && errCode(c) === "signups_closed")
        throw new ProbeFail(
          "P29: 503 signups_closed: staging's SIGNUPS_ENABLED must be test-users (7)",
        );
      // Design gap: no principal can purge a test user's install within a
      // run (U's R11 is 403, O cannot reach a self-serve install, the
      // scheduler purges at purge_at), so an earlier run's claim holds.
      if (c.status === 409 && errCode(c) === "signup_limit")
        return unproven(
          "test user b still holds signup_accounts from an earlier run: no principal can purge a self-serve install within a run",
        );
      const a = run.accepted(c, "P29 create", { asTestUser: true });
      const j = await run.done(a.job.id, "P29 create", "b");
      const d = await detail(run, a.install.id, "b");
      expect(d, 200, "P29 R3");
      const di = d.json as InstallDetail;
      if (di.testHooks !== false || di.source !== "self-serve")
        throw new ProbeFail("P29: not a self-serve release-variant install");
      const del = run.accepted(
        await run.v1(`/installs/${a.install.id}/delete`, {
          testUser: "b",
          body: { requestId: run.rid("p29-del"), confirmSlug: slug },
        }),
        "P29 delete",
        { asTestUser: true },
      );
      await run.done(del.job.id, "P29 delete", "b");
      const after = await detail(run, a.install.id, "b");
      expect(after, 200, "P29 R3 after delete");
      const st = (after.json as InstallDetail).state;
      if (st !== "deleting")
        throw new ProbeFail(`P29: after delete, state is ${st}, want deleting`);
      expect(
        await run.v1(`/installs/${a.install.id}/purge`, {
          testUser: "b",
          body: { requestId: run.rid("p29-purge"), confirmSlug: slug },
        }),
        403,
        "P29 R11 as the user",
      );
      return unproven(
        `create job ${j.id} done and deleted; the purge that frees signup_accounts is not runnable by any principal in a run (design gap)`,
      );
    },
  },
  {
    id: "P30",
    title:
      "dispatch only: 5 callbacks with a forged flow cookie are refused; signin_refused_burst opens",
    run: async (run) => {
      if (!run.c.dispatch) return na("dispatch runs only");
      for (let i = 0; i < 5; i++) {
        const r = await run.raw(
          `${run.c.admin}/auth/callback/google?code=redline&state=${randomBytes(16).toString("base64url")}`,
          {
            auth: "none",
            headers: {
              cookie: `__Host-oa-admin-flow=${randomBytes(32).toString("base64url")}`,
            },
          },
        );
        if (r.headers.get("set-cookie")?.includes("__Host-oa-admin="))
          throw new ProbeFail("P30: a forged flow cookie got a session");
        if (r.status === 200)
          throw new ProbeFail(`P30: callback ${i + 1} answered 200`);
      }
      return unproven(
        "5 forged callbacks refused; the alert is not readable by O (R27 and other actors' R17 rows are 403)",
      );
    },
  },
  {
    id: "P32",
    title:
      "create rl-q-<run> below the floor: failed release_unverified, retry the same, R11 discards; slug free",
    run: async (run) => {
      const below = (await releases(run))
        .filter(
          (r) =>
            !r.installable &&
            r.publishedAt !== null &&
            r.variants.includes("redline"),
        )
        .map((r) => r.version)
        .sort(cmpVer)
        .pop();
      if (!below) return na("no published release below the floor");
      const slug = run.slug("q");
      const a = run.accepted(
        await run.v1("/installs", {
          body: oidcCreate(run, slug, run.rid("p32"), below),
        }),
        "P32 create",
      );
      const code = (j: Job) => j.lastErrorCode ?? j.error?.code;
      const j1 = await run.waitJob(a.job.id);
      if (j1.status !== "failed" || code(j1) !== "release_unverified")
        throw new ProbeFail(`P32 create: ${j1.status} ${code(j1)}`);
      const r = run.accepted(
        await run.v1(`/installs/${a.install.id}/retry`, {
          body: { requestId: run.rid("p32-retry") },
        }),
        "P32 retry",
      );
      const j2 = await run.waitJob(r.job.id);
      if (j2.status !== "failed" || code(j2) !== "release_unverified")
        throw new ProbeFail(`P32 retry: ${j2.status} ${code(j2)}`);
      const p = run.accepted(
        await run.v1(`/installs/${a.install.id}/purge`, {
          body: { requestId: run.rid("p32-purge"), confirmSlug: slug },
        }),
        "P32 purge",
      );
      if (p.job.kind !== "discard")
        throw new ProbeFail(`P32: R11 ran ${p.job.kind}, want discard`);
      await run.done(p.job.id, "P32 discard");
      expect(await detail(run, a.install.id), 404, "P32 R3");
      const s = await run.v1(`/slugs/${slug}`);
      if ((s.json as { status?: string })?.status !== "ok")
        throw new ProbeFail(`P32: slug ${desc(s)}`);
      return pass();
    },
  },
  {
    id: "P33",
    title: "R17 for this run's actor: this run's job.accepted rows",
    run: async (run) => {
      if (!run.s.actor || run.s.jobIds.length === 0)
        throw new ProbeFail("P33: no job was accepted this run");
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const q = new URLSearchParams({
          actor: run.s.actor,
          action: "job.accepted",
          limit: "100",
        });
        if (cursor) q.set("cursor", cursor);
        const r = await run.v1(`/audit?${q}`);
        expect(r, 200, "P33 R17");
        const b = r.json as {
          items: { jobId: string | null }[];
          nextCursor: string | null;
        };
        for (const i of b.items) if (i.jobId) seen.add(i.jobId);
        cursor = b.nextCursor;
        if (!cursor || run.s.jobIds.every((id) => seen.has(id))) break;
      }
      const missing = run.s.jobIds.filter((id) => !seen.has(id));
      if (missing.length)
        throw new ProbeFail(
          `P33: ${missing.length} of this run's jobs have no job.accepted row`,
        );
      return pass(`${run.s.jobIds.length} job(s)`);
    },
  },
  {
    id: "P34",
    title:
      "400 unsigned broker authorize for i000000admin: 404s; /auth/start still reaches Google",
    run: async (run) => {
      let bad = 0;
      for (let i = 0; i < P34_REQUESTS; i += 10) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(10, P34_REQUESTS - i) }, () =>
            run.raw(
              `${run.c.broker}/google/authorize?install=i000000admin&state=${randomBytes(12).toString("base64url")}&nonce=${randomBytes(12).toString("base64url")}&code_challenge=${randomBytes(32).toString("base64url")}`,
              { auth: "none" },
            ),
          ),
        );
        bad += batch.filter((r) => r.status !== 404).length;
      }
      if (bad)
        throw new ProbeFail(
          `P34: ${bad} of ${P34_REQUESTS} unsigned authorize requests were not 404`,
        );
      const start = await run.raw(`${run.c.admin}/auth/start`, {
        auth: "none",
      });
      const loc = start.headers.get("location");
      if (start.status !== 302 || !loc)
        throw new ProbeFail(`P34 /auth/start: ${desc(start)}`);
      const hop = await run.raw(new URL(loc, run.c.admin).toString(), {
        auth: "none",
      });
      const g = hop.headers.get("location");
      if (
        hop.status < 300 ||
        hop.status > 303 ||
        !g ||
        new URL(g).hostname !== "accounts.google.com"
      )
        throw new ProbeFail(
          `P34: the broker did not send /auth/start on to Google (${desc(hop)})`,
        );
      return pass();
    },
  },
  {
    id: "P35",
    title: "reachable path: a Worker without a route fetches rl-a /healthz",
    run: async () =>
      unproven(
        "needs a Worker with no route (spike S7); the runner cannot stand in for it",
      ),
  },
  {
    id: "P36",
    title:
      "R26 for rl-a: the sealed PAT works on /api/v1/me (revoked at the run's end)",
    run: async (run) => {
      if (!run.io.rlAPat)
        throw new ProbeFail("P36: no R26 PAT for rl-a in this run");
      const r = await run.raw(`${run.c.rlA.app}/api/v1/me`, {
        auth: { bearer: run.io.rlAPat() },
      });
      expect(r, 200, "P36");
      return pass(
        "the 401 after revoke is checked by the workflow's revoke step",
      );
    },
  },
  {
    id: "P37",
    title:
      "POST /mcp, no Authorization: 401 with invalid_token and resource_metadata",
    run: async (run) => {
      const r = await mcp(run, "tools/list", {}, { auth: "none" });
      if (r.status !== 401) throw new ProbeFail(`P37: ${desc(r)}`);
      const w = r.headers.get("www-authenticate") ?? "";
      const meta = `${run.c.api}/.well-known/oauth-protected-resource/mcp`;
      if (
        !w.includes('error="invalid_token"') ||
        !w.includes(`resource_metadata="${meta}"`)
      )
        throw new ProbeFail(
          "P37: WWW-Authenticate lacks invalid_token or resource_metadata",
        );
      return pass();
    },
  },
  {
    id: "P38",
    title:
      "both metadata documents: resource, authorization_endpoint, five scopes, S256",
    run: async (run) => {
      const prm = await run.raw(
        `${run.c.api}/.well-known/oauth-protected-resource/mcp`,
        { auth: "none" },
      );
      expect(prm, 200, "P38 protected resource");
      const as = await run.raw(
        `${run.c.api}/.well-known/oauth-authorization-server`,
        { auth: "none" },
      );
      expect(as, 200, "P38 authorization server");
      const p = prm.json as Record<string, unknown>;
      const a = as.json as Record<string, unknown>;
      if (p.resource !== `${run.c.api}/mcp`)
        throw new ProbeFail("P38: resource is not api /mcp");
      const ae =
        typeof a.authorization_endpoint === "string"
          ? new URL(a.authorization_endpoint).origin
          : "";
      if (ae !== run.c.admin)
        throw new ProbeFail(
          "P38: authorization_endpoint is not on the admin host",
        );
      const five = JSON.stringify([...TOKEN_SCOPES].sort());
      for (const [n, d] of [
        ["authorization server", a],
        ["protected resource", p],
      ] as const)
        if (
          !Array.isArray(d.scopes_supported) ||
          JSON.stringify([...(d.scopes_supported as string[])].sort()) !== five
        )
          throw new ProbeFail(
            `P38: ${n} scopes_supported is not exactly the five`,
          );
      if (JSON.stringify(a.code_challenge_methods_supported) !== '["S256"]')
        throw new ProbeFail(
          "P38: code_challenge_methods_supported is not [S256]",
        );
      return pass();
    },
  },
  {
    id: "P39",
    title:
      "/mcp with a forged oat_, a forged opaque bearer, only a Cookie: 401 each",
    run: async (run) => {
      const forged: [string, Auth, Record<string, string>][] = [
        [
          "oat_",
          { bearer: `oat_${randomBytes(32).toString("base64url")}` },
          {},
        ],
        ["opaque", { bearer: randomBytes(32).toString("base64url") }, {}],
        [
          "cookie",
          "none",
          {
            cookie: `__Host-oa-admin=${randomBytes(32).toString("base64url")}`,
          },
        ],
      ];
      for (const [what, auth, headers] of forged) {
        const r = await mcp(run, "tools/list", {}, { auth, headers });
        if (r.status !== 401) throw new ProbeFail(`P39 ${what}: ${desc(r)}`);
      }
      return pass();
    },
  },
  {
    id: "P40",
    title: "POST admin /mcp; GET api /oauth/authorize: 404 each",
    run: async (run) => {
      const a = await mcp(
        run,
        "tools/list",
        {},
        { auth: "none", host: "admin" },
      );
      if (a.status !== 404) throw new ProbeFail(`P40 admin /mcp: ${desc(a)}`);
      expect(
        await run.raw(`${run.c.api}/oauth/authorize`, { auth: "none" }),
        404,
        "P40 api /oauth/authorize",
      );
      return pass();
    },
  },
  {
    id: "P41",
    title: "/mcp with Origin https://evil.example and a valid OIDC bearer: 403",
    run: async (run) => {
      const r = await mcp(run, "tools/list", {}, { headers: { origin: EVIL } });
      if (r.status !== 403) throw new ProbeFail(`P41: ${desc(r)}`);
      return pass();
    },
  },
  {
    id: "P42",
    title: "/mcp with a 40 KiB body: 413",
    run: async (run) => {
      const r = await mcp(run, "tools/call", {
        name: "whoami",
        arguments: { pad: "x".repeat(P42_BYTES) },
      });
      if (r.status !== 413) throw new ProbeFail(`P42: ${desc(r)}`);
      return pass();
    },
  },
  {
    id: "P44",
    title:
      "/oauth/register: foreign redirect URIs 400 invalid_redirect_uri; the 11th registration refused",
    run: async (run) => {
      const reg = (uris: string[]) =>
        run.raw(`${run.c.api}/oauth/register`, {
          auth: "none",
          body: {
            client_name: "oa-redline",
            redirect_uris: uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          },
        });
      expect(
        await reg([`${EVIL}/cb`]),
        400,
        "P44 evil",
        "invalid_redirect_uri",
      );
      expect(
        await reg(["https://claude.ai/api/mcp/redline_not_listed"]),
        400,
        "P44 unlisted claude.ai",
        "invalid_redirect_uri",
      );
      // The cap is 10 per ipKey per UTC day (9A.7); refused registrations
      // give their slot back, so only an earlier 201 from this egress IP today
      // spends it. 10 x 201 then 429 proves the limit; fewer 201s before the
      // 429 cannot tell a lower cap from a spent one, so that is unproven. OAuth
      // endpoints answer RFC 6749 errors (3.5): 429 is temporarily_unavailable.
      let ok = 0;
      for (let i = 1; i <= P44_REGISTRATIONS; i++) {
        const r = await reg([run.c.mcpRedirectUri]);
        if (r.status === 429) {
          expect(r, 429, `P44 registration ${i}`, "temporarily_unavailable");
          if (ok === P44_REGISTRATIONS - 1) return pass();
          return unproven(
            `the 429 came after ${ok} registration(s): this IP's daily cap was partly spent earlier`,
          );
        }
        const id = (r.json as { client_id?: unknown } | undefined)?.client_id;
        if (r.status !== 201 || typeof id !== "string" || !id)
          throw new ProbeFail(
            `P44: registration ${i} want 201 with a client_id or 429, got ${desc(r)}`,
          );
        if (ok === 0) run.s.clientId = id;
        ok++;
      }
      throw new ProbeFail(
        `P44 registration ${P44_REGISTRATIONS}: want 429 temporarily_unavailable, got 201`,
      );
    },
  },
  {
    id: "P43",
    title:
      "GET /oauth/authorize, no cookie, cross-site: 200 bounce page; with b=1: 302 to /auth/start",
    run: async (run) => {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: run.s.clientId ?? "redline-unregistered",
        redirect_uri: run.c.mcpRedirectUri,
        code_challenge: randomBytes(32).toString("base64url"),
        code_challenge_method: "S256",
        state: randomBytes(16).toString("base64url"),
        scope: "installs:read",
        resource: `${run.c.api}/mcp`,
      });
      const u = `${run.c.admin}/oauth/authorize?${q}`;
      const h = { "sec-fetch-site": "cross-site" };
      expect(await run.raw(u, { auth: "none", headers: h }), 200, "P43 bounce");
      q.set("b", "1");
      const r = await run.raw(`${run.c.admin}/oauth/authorize?${q}`, {
        auth: "none",
        headers: h,
      });
      const loc = r.headers.get("location");
      if (
        r.status !== 302 ||
        !loc ||
        new URL(loc, run.c.admin).pathname !== "/auth/start"
      )
        throw new ProbeFail(`P43 b=1: ${desc(r)}`);
      return pass(run.s.clientId ? undefined : "no client from P44");
    },
  },
  {
    id: "P46",
    title: "staging OIDC on prod /mcp: 401",
    run: async (run) => {
      if (!(await prodLive(run)))
        return na("prod admin /api/v1/me does not answer 401 yet");
      const r = await mcp(run, "tools/list", {}, { host: "prodApi" });
      if (r.status !== 401) throw new ProbeFail(`P46: ${desc(r)}`);
      return pass();
    },
  },
  {
    id: "P47",
    title: "/v1/me with an OAuth-shaped bearer: 401 unauthenticated",
    run: async (run) => {
      const bearer = `${randomBytes(8).toString("hex")}:${randomBytes(8).toString("hex")}:${randomBytes(24).toString("base64url")}`;
      expect(
        await run.v1("/me", { auth: { bearer } }),
        401,
        "P47",
        "unauthenticated",
      );
      return pass();
    },
  },
  {
    id: "P25",
    title: "15 rapid GET /auth/start: at least one 429",
    // Last: it spends RL_PV_SIGNIN_IP (10 per 60 s), which P30's callbacks
    // and P34's /auth/start share; nothing after it signs in.
    run: async (run) => {
      const out = await Promise.all(
        Array.from({ length: P25_REQUESTS }, () =>
          run.raw(`${run.c.admin}/auth/start`, { auth: "none" }),
        ),
      );
      if (!out.some((r) => r.status === 429))
        throw new ProbeFail("P25: no 429 in 15 requests");
      return pass();
    },
  },
];

/**
 * P15's check, run by P13's poll: called with the job as polled; reads
 * inventory and /healthz, then the job again, and keeps the reading only if
 * the job was still before `route` on both sides.
 */
export async function p15Check(
  run: Run,
  jobId: string,
  routeAt: number,
): Promise<"before" | "after"> {
  const p = run.s.rlp;
  const rec = run.s.p15;
  if (!p || !rec) return "after";
  const mode = run.c.inventory ? (await run.hostMode(p.appHost)).mode : null;
  const hz = (await run.page(p.appHost)).status;
  const j = await run.v1(`/jobs/${jobId}`);
  const job = j.json as Job | undefined;
  if (
    !job ||
    job.stepIndex >= routeAt ||
    (job.status !== "running" && job.status !== "queued")
  )
    return "after";
  rec.checked++;
  if (mode !== null) rec.violations.push(`inventory mode ${mode} before route`);
  if (hz !== 404) rec.violations.push(`public /healthz ${hz} before route`);
  return "before";
}

// --- Bring-up and teardown (the workflow's R5 and R26 steps) ---------------

export interface CredsOut {
  pat: string;
  hookKey: string;
}

/**
 * R5 for one red-line install (P24): upgrade to `version` unless it already
 * runs it; a newer version is refused (a downgrade is never the bring-up).
 */
export async function bringUpgrade(
  run: Run,
  id: string,
  slug: string,
): Promise<"upgraded" | "current"> {
  const d = await detail(run, id);
  expect(d, 200, `R3 ${slug}`);
  const i = d.json as InstallDetail;
  if (i.slug !== slug) throw new ProbeFail(`${id} is ${i.slug}, not ${slug}`);
  if (i.version === run.c.version) return "current";
  if (i.version && cmpVer(i.version, run.c.version) > 0)
    throw new ProbeFail(
      `${slug} runs ${i.version}, newer than ${run.c.version}`,
    );
  const a = run.accepted(
    await run.v1(`/installs/${id}/upgrade`, {
      body: { requestId: run.rid(`up-${slug}`), version: run.c.version },
    }),
    `R5 ${slug}`,
  );
  await run.done(a.job.id, `R5 ${slug}`);
  return "upgraded";
}

/**
 * The staging-first record (W9a's scripts/ci/staging-first-gate.sh): after
 * bring-up, rl-a's and rl-b's public /healthz must both report the release
 * under test; returns it (X.Y.Z) for version.txt. Any other answer fails.
 */
export async function stagedVersion(run: Run): Promise<string> {
  for (const [slug, app] of [
    ["rl-a", run.c.rlA.app],
    ["rl-b", run.c.rlB.app],
  ] as const) {
    const r = await run.raw(`${app}/healthz`, { auth: "none" });
    const v = (r.json as { version?: unknown } | undefined)?.version;
    if (r.status !== 200 || v !== run.c.version)
      throw new ProbeFail(
        `${slug} /healthz: want 200 version ${run.c.version}, got ${r.status === 200 ? `version ${typeof v === "string" ? v.slice(0, 20) : "none"}` : desc(r)}`,
      );
  }
  return run.c.version;
}

/** R26 mint for one install: the sealed {pat, hookKey}, opened with this run's key. */
export async function mintCreds(
  run: Run,
  id: string,
  slug: string,
  recipient: { publicKey: string; open: (sealed: string) => Promise<CredsOut> },
): Promise<CredsOut> {
  const a = run.accepted(
    await run.v1(`/installs/${id}/redline-creds`, {
      body: {
        requestId: run.rid(`creds-${slug}`),
        recipientKey: recipient.publicKey,
      },
    }),
    `R26 ${slug}`,
  );
  // R15 hands `sealed` out once, on the first read after the seal step, and
  // the job is still `running` then (done is a later step): keep it from
  // whichever read carries it, then require done.
  let sealed: string | null = null;
  const first = await run.waitJob(a.job.id, {
    until: (j) => {
      if (sealed === null) sealed = j.sealed ?? null;
      return sealed !== null || j.status === "done" || j.status === "failed";
    },
  });
  if (first.status !== "done" && first.status !== "failed")
    await run.done(a.job.id, `R26 ${slug}`);
  else if (first.status !== "done")
    throw new ProbeFail(
      `R26 ${slug}: job failed (${first.lastErrorCode ?? first.error?.code ?? "no code"})`,
    );
  if (!sealed) throw new ProbeFail(`R26 ${slug}: no sealed creds on the job`);
  return recipient.open(sealed);
}

/** R26 revoke for one install; then, when the run's PAT is known, it must be 401. */
export async function revokeCreds(
  run: Run,
  id: string,
  slug: string,
  app: string,
  pat?: string,
): Promise<void> {
  const a = run.accepted(
    await run.v1(`/installs/${id}/redline-creds`, {
      body: { requestId: run.rid(`revoke-${slug}`), revoke: true },
    }),
    `R26 revoke ${slug}`,
  );
  await run.done(a.job.id, `R26 revoke ${slug}`);
  if (pat) {
    const r = await run.raw(`${app}/api/v1/me`, { auth: { bearer: pat } });
    if (r.status !== 401)
      throw new ProbeFail(
        `R26 revoke ${slug}: the run's PAT is ${desc(r)}, want 401`,
      );
  }
}

/** The run's probe config from the environment (CI sets these; see redline-staging.yml). */
export function provConfig(
  env: Record<string, string | undefined>,
  targets: {
    a: { installId: string; app: string };
    b: { installId: string; app: string };
  },
): ProvConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const version = need("REDLINE_RELEASE").replace(/^v/, "");
  if (!/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version))
    throw new Error("REDLINE_RELEASE is not a version (x.y.z or vx.y.z)");
  const runId = need("REDLINE_RUN_ID");
  if (!/^[A-Za-z0-9-]{1,24}$/.test(runId))
    throw new Error("REDLINE_RUN_ID must be 1-24 letters, digits or dashes");
  const o = (k: string, d: string) => {
    const v = env[k] || d;
    const u = new URL(v);
    if (u.protocol !== "https:" || u.pathname !== "/" || u.search)
      throw new Error(`${k} must be a bare https origin`);
    return u.origin;
  };
  const c: ProvConfig = {
    api: o("REDLINE_PROV_API", "https://api.open-artifacts-staging.app"),
    admin: o("REDLINE_PROV_ADMIN", "https://admin.open-artifacts-staging.app"),
    broker: o("REDLINE_BROKER", "https://auth.open-artifacts-staging.app"),
    prodApi: o("REDLINE_PROD_PROV_API", "https://api.open-artifacts.app"),
    prodAdmin: o("REDLINE_PROD_PROV_ADMIN", "https://admin.open-artifacts.app"),
    runId,
    version,
    dispatch: env.REDLINE_DISPATCH === "1",
    rlA: { id: targets.a.installId, app: targets.a.app },
    rlB: { id: targets.b.installId, app: targets.b.app },
    mcpRedirectUri:
      env.REDLINE_MCP_REDIRECT_URI || "https://claude.ai/api/mcp/auth_callback",
  };
  if (env.REDLINE_STG_INVENTORY_URL)
    c.inventory = o("REDLINE_STG_INVENTORY_URL", "");
  if (env.REDLINE_PROD_INVENTORY_URL)
    c.prodInventory = o("REDLINE_PROD_INVENTORY_URL", "");
  return c;
}

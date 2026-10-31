import {
  ADMIN_TOOL_NAMES,
  JOB_STEPS,
  TOKEN_SCOPES,
} from "@oa/shared/provisioning";
import type { ProvConfig, ProvIo } from "../src/provisioning.ts";
import { sealTo } from "./provisioner-seal.ts";

// An in-memory staging Provisioning API, inventory, broker and tenant hosts
// that behave as design v7 says, as a fetch function. Each R15 read moves a
// running job one step (no timers); the clock moves only by io.wait. Tests
// flip `faults` to make one behaviour wrong and check the probe catches it.

const B64 = (v: unknown) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString(
    "base64url",
  );
export const jwt = (aud: string, exp = 4_102_444_800) =>
  `${B64({ alg: "RS256", kid: "k" })}.${B64({ aud, exp, ref: "refs/heads/main" })}.${B64("sig")}`;
export const API_JWT = jwt("https://api.open-artifacts-staging.app");
export const INV_JWT = jwt("https://oa-s-inventory");

export const CONFIG: ProvConfig = {
  api: "https://api.open-artifacts-staging.app",
  admin: "https://admin.open-artifacts-staging.app",
  broker: "https://auth.open-artifacts-staging.app",
  prodApi: "https://api.open-artifacts.app",
  prodAdmin: "https://admin.open-artifacts.app",
  runId: "1234",
  version: "0.82.0",
  dispatch: true,
  rlA: { id: "irlaaaaaaaaa", app: "https://rl-a.open-artifacts-staging.app" },
  rlB: { id: "irlbbbbbbbbb", app: "https://rl-b.open-artifacts-staging.app" },
  mcpRedirectUri: "https://claude.ai/api/mcp/auth_callback",
  inventory: "https://inventory.open-artifacts-staging.app",
  prodInventory: "https://inventory.open-artifacts.app",
};

type Mode = "serving" | "paused" | "closed" | null;
interface FInstall {
  id: string;
  slug: string;
  appHost: string;
  contentHost: string;
  state: string;
  version: string | null;
  previousVersion: string | null;
  testHooks: boolean;
  source: "admin" | "self-serve";
  owner: string;
  mode: Mode;
  activeJobId: string | null;
}
interface FJob {
  id: string;
  kind: string;
  installId: string;
  status: "queued" | "running" | "done" | "failed";
  steps: string[];
  stepIndex: number;
  owner: string;
  args: Record<string, unknown>;
  failAt?: { step: string; code: string };
  sealed: string | null;
  sealedRead: boolean;
  onStep?: (step: string) => void;
  onDone?: () => void;
}

export type Fault =
  | "p1_200"
  | "p6_alg_none_ok"
  | "p13_replay_new_job"
  | "p15_mode_early"
  | "p16_late"
  | "p22_closed_404"
  | "p23_no_row"
  | "p44_unlisted_redirect"
  | "p24_old"
  | "p27_no_token_ok"
  | "p34_admin_429"
  | "p37_no_header"
  | "p38_prm_no_scopes"
  | "p44_no_limit"
  | "p44_cap_spent"
  | "p44_wrong_code"
  | "p45_extra_tool"
  | "p47_wrong_code"
  | "signups_closed"
  | "revoke_noop"
  | "prod_live";

export interface FakeApi {
  fetch: typeof fetch;
  io: ProvIo;
  installs: Map<string, FInstall>;
  jobs: Map<string, FJob>;
  pats: Map<string, { install: string; revoked: boolean }>;
  faults: Set<Fault>;
  clock: { t: number };
  audit: { actor: string; action: string; jobId: string }[];
  /** Every request URL, in order. */
  log: string[];
}

const ACTOR = {
  kind: "oidc",
  label: "github:open-artifacts-ai/open-artifacts",
  tokenId: null,
};
const err = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status });
const ok = (v: unknown, status = 200) => Response.json(v, { status });

let seq = 0;
const ulid = () => `01${String(++seq).padStart(24, "0")}`;
const iid = (n: number) => `i${String(n).padStart(11, "0")}`;

export function fakeApi(): FakeApi {
  const clock = { t: 1_800_000_000_000 };
  const installs = new Map<string, FInstall>();
  const jobs = new Map<string, FJob>();
  const pats = new Map<string, { install: string; revoked: boolean }>();
  const faults = new Set<Fault>();
  const audit: FakeApi["audit"] = [];
  const replays = new Map<string, Response>();
  const log: string[] = [];
  const signupAccounts = new Set<string>();
  const purged = new Map<string, FInstall>();
  const authStarts = new Map<number, number>();
  let registrations = 0;
  let n = 0;
  const releases = [
    {
      version: "0.80.0",
      publishedAt: 1,
      variants: ["release", "redline"],
      installable: false,
      latest: false,
    },
    {
      version: "0.81.0",
      publishedAt: 2,
      variants: ["release", "redline"],
      installable: true,
      latest: false,
    },
    {
      version: "0.82.0",
      publishedAt: 3,
      variants: ["release", "redline"],
      installable: true,
      latest: true,
    },
  ];
  const add = (i: Partial<FInstall> & { slug: string }): FInstall => {
    const x: FInstall = {
      id: i.id ?? iid(++n),
      appHost: `${i.slug}.open-artifacts-staging.app`,
      contentHost: `${i.slug}.open-artifacts-staging.page`,
      state: "active",
      version: "0.82.0",
      previousVersion: null,
      testHooks: true,
      source: "admin",
      owner: "oidc",
      mode: "serving",
      activeJobId: null,
      ...i,
    };
    installs.set(x.id, x);
    return x;
  };
  add({ id: CONFIG.rlA.id, slug: "rl-a", version: "0.81.0" });
  add({ id: CONFIG.rlB.id, slug: "rl-b", version: "0.82.0" });
  // Listed first: a deleted panel install P10 and P45 must skip.
  add({ slug: "gone", testHooks: false, owner: "admin", state: "deleted" });
  const panel = add({ slug: "acme", testHooks: false, owner: "admin" });

  const summary = (i: FInstall) => ({
    id: i.id,
    slug: i.slug,
    appHost: i.appHost,
    contentHost: i.contentHost,
    state: i.state,
    servingMode: i.mode ?? "unmapped",
    version: i.version,
    tier: "team",
    auth: { providers: ["email"], domainCount: 0 },
    health: "ok",
    source: i.source,
    activeJobId: i.activeJobId,
    createdAt: 1,
  });
  const detail = (i: FInstall) => ({
    ...summary(i),
    ownerEmail: null,
    auth: { providers: ["email"], domains: [] },
    previousVersion: i.previousVersion,
    suspendedAt: null,
    suspendReason: null,
    deletedAt: null,
    purgeAt: null,
    restorable: i.state === "deleting",
    testHooks: i.testHooks,
    lease: { held: false, until: null },
    mismatch: null,
  });
  const jobView = (j: FJob, withSealed: boolean) => ({
    id: j.id,
    kind: j.kind,
    installId: j.installId,
    status: j.status,
    step: j.steps[j.stepIndex] ?? null,
    steps: j.steps,
    stepIndex: j.stepIndex,
    attempt: 1,
    lastErrorCode: j.status === "failed" ? (j.failAt?.code ?? null) : null,
    retryAt: null,
    actor:
      j.owner === "oidc"
        ? ACTOR
        : { kind: "user", label: j.owner, tokenId: null },
    args: j.args,
    error:
      j.status === "failed" ? { code: j.failAt?.code, message: "x" } : null,
    sealed: withSealed ? j.sealed : null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
  });
  const startJob = (
    i: FInstall,
    kind: string,
    owner: string,
    extra: Partial<FJob> = {},
  ): FJob => {
    const steps = [
      ...((JOB_STEPS as Record<string, readonly string[]>)[kind] ?? ["done"]),
    ];
    const j: FJob = {
      id: ulid(),
      kind,
      installId: i.id,
      status: "running",
      steps,
      stepIndex: 0,
      owner,
      args: {},
      sealed: null,
      sealedRead: false,
      ...extra,
    };
    jobs.set(j.id, j);
    i.activeJobId = j.id;
    audit.push({
      actor: owner === "oidc" ? ACTOR.label : owner,
      action: "job.accepted",
      jobId: j.id,
    });
    return j;
  };
  const advance = (j: FJob) => {
    if (j.status !== "running") return;
    const step = j.steps[j.stepIndex] as string;
    if (j.failAt?.step === step) {
      j.status = "failed";
      const i = installs.get(j.installId);
      if (i) {
        i.activeJobId = null;
        i.state = "failed";
      }
      return;
    }
    j.onStep?.(step);
    j.stepIndex++;
    if (j.stepIndex >= j.steps.length - 1) {
      j.stepIndex = j.steps.length - 1;
      j.status = "done";
      const i = installs.get(j.installId);
      if (i) i.activeJobId = null;
      j.onDone?.();
    }
  };

  const principal = (h: Headers): string | "bad" | null => {
    const a = h.get("authorization");
    if (!a) return null;
    if (a !== `Bearer ${API_JWT}`) {
      if (
        faults.has("p6_alg_none_ok") &&
        a.startsWith(`Bearer ${B64({ alg: "none", typ: "JWT" })}`)
      )
        return "oidc";
      return "bad";
    }
    const u = h.get("x-oa-test-user");
    return u ? `user:rl-test-${u}` : "oidc";
  };
  const sees = (p: string, i: FInstall) =>
    p === "oidc" ? i.slug.startsWith("rl-") && i.testHooks : i.owner === p;

  async function api(url: URL, req: Request, base: string): Promise<Response> {
    const path = url.pathname.slice(base.length);
    const p = principal(req.headers);
    if (p === null || p === "bad") return err(401, "unauthenticated");
    const body =
      req.method === "POST"
        ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
        : {};
    const key = `${p}\n${String(body.requestId ?? "")}`;
    if (req.method === "POST" && replays.has(key)) {
      const prior = replays.get(key) as Response;
      if (faults.has("p13_replay_new_job") && path === "/installs") {
        const j = (await prior.clone().json()) as { job: { id: string } };
        return ok({ job: { ...j.job, id: ulid() } }, 202);
      }
      return prior.clone();
    }
    const res = await route(path, url, req.method, body, p);
    if (req.method === "POST" && res.status === 202)
      replays.set(key, res.clone());
    return res;
  }

  async function route(
    path: string,
    url: URL,
    method: string,
    body: Record<string, unknown>,
    p: string,
  ): Promise<Response> {
    const user = p.startsWith("user:");
    if (path === "/me") return ok({ principal: user ? "user" : "oidc" });
    if (path === "/world") return err(403, "forbidden");
    if (path === "/tokens") return err(403, "forbidden");
    if (path === "/releases")
      return user ? err(403, "forbidden") : ok({ items: releases });
    if (path === "/audit") {
      const actor = url.searchParams.get("actor");
      return ok({
        items: audit
          .filter(
            (a) =>
              a.actor === actor && a.action === url.searchParams.get("action"),
          )
          .map((a) => ({ jobId: a.jobId })),
        nextCursor: null,
      });
    }
    let m = path.match(/^\/slugs\/(.+)$/);
    if (m)
      return ok({
        slug: m[1],
        status: [...installs.values()].some((i) => i.slug === m?.[1])
          ? "taken"
          : "ok",
      });
    m = path.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
    if (m) {
      if (m[2]) return err(403, "forbidden");
      const j = jobs.get(m[1] as string);
      if (!j || j.owner !== p) return err(404, "not_found");
      advance(j);
      // As W3/W5b: sealed is written while the job is still running (step
      // seal, before done) and handed out once, whatever the status.
      const withSealed = !j.sealedRead && j.sealed !== null;
      if (withSealed) j.sealedRead = true;
      return ok(jobView(j, withSealed));
    }
    if (path === "/installs" && method === "GET") {
      const q = url.searchParams.get("q");
      return ok({
        items: [...installs.values()]
          .filter((i) => sees(p, i) && (!q || i.slug.includes(q)))
          .map(summary),
        nextCursor: null,
      });
    }
    if (path === "/installs" && method === "POST") {
      if (user) {
        if (faults.has("signups_closed")) return err(503, "signups_closed");
        if (body.ownerEmail !== undefined || body.tier !== undefined)
          return err(403, "forbidden");
      } else if (
        !String(body.slug).startsWith("rl-") ||
        body.testHooks !== true
      )
        return err(403, "forbidden");
      // One live install per account (signup_accounts): freed only on a
      // failed create or 7 days after a purge, never within a run.
      if (user && signupAccounts.has(p)) return err(409, "signup_limit");
      if ([...installs.values()].some((i) => i.slug === body.slug))
        return err(409, "slug_taken");
      const version = (body.version as string | undefined) ?? "0.82.0";
      const rel = releases.find((r) => r.version === version);
      if (!rel) return err(422, "release_not_published");
      const i = add({
        slug: String(body.slug),
        state: "provisioning",
        mode: null,
        version: null,
        testHooks: !user,
        source: user ? "self-serve" : "admin",
        owner: p,
      });
      if (user) signupAccounts.add(p);
      const j = startJob(i, "create", p, {
        failAt: rel.installable
          ? undefined
          : { step: "release_gate", code: "release_unverified" },
        onStep: (s) => {
          if (s === "route") i.mode = "serving";
          if (faults.has("p15_mode_early") && s === "admit") i.mode = "serving";
        },
        onDone: () => {
          i.state = "active";
          i.version = version;
        },
      });
      // The create finishes before the probe's next request.
      if (faults.has("p16_late") && !user)
        while (j.status === "running") advance(j);
      return ok({ job: jobView(j, false), install: summary(i) }, 202);
    }
    m = path.match(/^\/installs\/([^/]+)(?:\/([a-z-]+))?$/);
    if (!m) return err(404, "not_found");
    const i = installs.get(m[1] as string);
    const op = m[2];
    if (op === "release-lease") return err(403, "forbidden");
    // 4.2: U has no R5-R8, R12 and no R11 purge.
    if (
      user &&
      ["upgrade", "purge", "retry", "suspend", "resume"].includes(op ?? "")
    )
      return err(403, "forbidden");
    if (!i || !sees(p, i)) return err(404, "not_found");
    if (!op) return ok(detail(i));
    if (op === "jobs")
      return ok({
        items: [...jobs.values()]
          .filter((j) => j.installId === i.id)
          .map((j) => jobView(j, false)),
        nextCursor: null,
      });
    if (i.activeJobId) return err(409, "job_in_progress");
    const confirm = () => body.confirmSlug === i.slug;
    switch (op) {
      case "upgrade": {
        const to = (body.version as string | undefined) ?? "0.82.0";
        if (i.version && to <= i.version) return err(409, "downgrade_refused");
        const j = startJob(i, "upgrade", p, {
          onDone: () => {
            i.previousVersion = i.version;
            i.version = to;
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "rollback": {
        const j = startJob(i, "rollback", p, {
          onDone: () => {
            i.version = i.previousVersion;
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "suspend": {
        const j = startJob(i, "suspend", p, {
          onDone: () => {
            i.mode = "paused";
            i.state = "suspended";
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "resume": {
        const j = startJob(i, "resume", p, {
          onDone: () => {
            i.mode = "serving";
            i.state = "active";
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "delete": {
        if (!confirm()) return err(400, "confirm_mismatch");
        const j = startJob(i, "delete", p, {
          onDone: () => {
            i.mode = "closed";
            i.state = "deleting";
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "restore": {
        const j = startJob(i, "restore", p, {
          onDone: () => {
            i.mode = "serving";
            i.state = "active";
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "purge": {
        if (!confirm()) return err(400, "confirm_mismatch");
        const kind = i.state === "failed" ? "discard" : "purge";
        // Inventory keeps the row as deleted (install_status); HOSTS and
        // the API forget it.
        const j = startJob(i, kind, p, {
          onDone: () => {
            installs.delete(i.id);
            if (!faults.has("p23_no_row"))
              purged.set(i.id, { ...i, state: "deleted", mode: null });
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "retry": {
        const j = startJob(i, "retry", p, {
          failAt: { step: "release_gate", code: "release_unverified" },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
      case "redline-creds": {
        if (body.revoke === true) {
          const j = startJob(i, "redline_creds", p, {
            steps: [...JOB_STEPS.redline_creds_revoke],
            onDone: () => {
              if (faults.has("revoke_noop")) return;
              for (const v of pats.values())
                if (v.install === i.id) v.revoked = true;
            },
          });
          return ok({ job: jobView(j, false), install: summary(i) }, 202);
        }
        const pat = `oa_pat_${i.slug}_${++n}`;
        const sealed = await sealTo(
          String(body.recipientKey),
          JSON.stringify({ pat, hookKey: "h".repeat(43) }),
        );
        const j = startJob(i, "redline_creds", p, {
          onStep: (s) => {
            if (s !== "mint") return;
            pats.set(pat, { install: i.id, revoked: false });
            j.sealed = sealed;
          },
        });
        return ok({ job: jobView(j, false), install: summary(i) }, 202);
      }
    }
    return err(404, "not_found");
  }

  const rpcOk = (id: unknown, result: unknown) =>
    ok({ jsonrpc: "2.0", id, result });
  const toolErr = (code: string) => ({
    isError: true,
    content: [{ type: "text", text: code }],
    structuredContent: { error: { code, message: code } },
  });
  async function mcp(req: Request, host: string): Promise<Response> {
    if (host !== "api.open-artifacts-staging.app")
      return new Response(null, {
        status: host.startsWith("admin.") ? 404 : 401,
      });
    const text = await req.text();
    if (text.length > 32 * 1024) return ok({ error: "too large" }, 413);
    const p = principal(req.headers);
    if (p === null || p === "bad")
      return new Response(null, {
        status: 401,
        headers: faults.has("p37_no_header")
          ? {}
          : {
              "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${CONFIG.api}/.well-known/oauth-protected-resource/mcp"`,
            },
      });
    if (req.headers.get("origin")) return new Response(null, { status: 403 });
    const rpc = JSON.parse(text) as {
      id: unknown;
      method: string;
      params: { name?: string; arguments?: Record<string, unknown> };
    };
    if (rpc.method === "initialize")
      return rpcOk(rpc.id, {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "x", version: "1" },
      });
    if (rpc.method === "tools/list")
      return rpcOk(rpc.id, {
        tools: [
          ...ADMIN_TOOL_NAMES,
          ...(faults.has("p45_extra_tool") ? ["mint_token"] : []),
        ].map((name) => ({ name })),
      });
    const a = rpc.params.arguments ?? {};
    const name = rpc.params.name;
    if (name === "get_world") return rpcOk(rpc.id, toolErr("forbidden"));
    const i = installs.get(String(a.id));
    if (!i || !sees(p, i)) return rpcOk(rpc.id, toolErr("not_found"));
    if (name === "get_install")
      return rpcOk(rpc.id, { structuredContent: detail(i) });
    const fwd = new Request(
      `${CONFIG.api}/v1/installs/${i.id}/${name === "delete_install" ? "delete" : "upgrade"}`,
      {
        method: "POST",
        headers: {
          authorization: req.headers.get("authorization") as string,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: a.requestId,
          confirmSlug: a.confirmSlug,
          version: a.version,
        }),
      },
    );
    const r = await api(new URL(fwd.url), fwd, "/v1");
    const b = (await r.json()) as { error?: { code: string } };
    return rpcOk(
      rpc.id,
      r.status === 202
        ? { structuredContent: b }
        : toolErr(b.error?.code ?? "internal"),
    );
  }

  const page = (host: string, path: string): Response => {
    const i = [...installs.values()].find(
      (x) => x.appHost === host || x.contentHost === host,
    );
    if (host === "rl-a.open-artifacts-staging.app" && path === "/api/v1/me")
      return new Response(null, { status: 401 });
    if (!i || i.mode === null) return new Response("nf", { status: 404 });
    if (i.mode === "paused") return new Response("paused", { status: 503 });
    // Dispatch serves the closed page as 503 too (apps/dispatch/src/unavailable.ts).
    if (i.mode === "closed")
      return new Response("closed", {
        status: faults.has("p22_closed_404") ? 404 : 503,
      });
    return path === "/healthz"
      ? ok({
          ok: true,
          version: i.version,
          testHooks: i.testHooks,
          installId: i.id,
        })
      : new Response("app");
  };

  const handler = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const host = url.hostname;
    log.push(`${req.method} ${url.origin}${url.pathname}`);
    if (url.pathname === "/mcp") return mcp(req, host);
    if (host === "api.open-artifacts-staging.app") {
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return ok({
          resource: `${CONFIG.api}/mcp`,
          authorization_servers: [CONFIG.api],
          ...(faults.has("p38_prm_no_scopes")
            ? {}
            : { scopes_supported: [...TOKEN_SCOPES] }),
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return ok({
          issuer: CONFIG.api,
          authorization_endpoint: `${CONFIG.admin}/oauth/authorize`,
          scopes_supported: [...TOKEN_SCOPES],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/oauth/register") {
        const b = (await req.json()) as { redirect_uris: string[] };
        if (
          b.redirect_uris[0] !== CONFIG.mcpRedirectUri ||
          faults.has("p44_unlisted_redirect")
        )
          return ok({ error: "invalid_redirect_uri" }, 400);
        // An earlier run today from this IP spent 4 of the 10 (9A.7).
        const spent = faults.has("p44_cap_spent") ? 4 : 0;
        if (++registrations + spent > 10 && !faults.has("p44_no_limit"))
          return ok(
            {
              error: faults.has("p44_wrong_code")
                ? "rate_limited"
                : "temporarily_unavailable",
            },
            429,
          );
        return ok({ client_id: `c${registrations}` }, 201);
      }
      if (url.pathname === "/oauth/authorize")
        return new Response(null, { status: 404 });
      if (
        url.pathname.startsWith("/v1/me") &&
        req.headers.get("authorization")?.split(" ")[1]?.split(":").length === 3
      )
        return err(
          401,
          faults.has("p47_wrong_code") ? "internal" : "unauthenticated",
        );
      return api(url, req, "/v1");
    }
    if (host === "admin.open-artifacts-staging.app") {
      if (url.pathname === "/api/v1/me" && !faults.has("p1_200"))
        return err(401, "unauthenticated");
      if (url.pathname === "/api/v1/me") return ok({});
      if (url.pathname === "/api/v1/installs" && req.headers.get("origin"))
        return err(403, "csrf_failed");
      if (url.pathname === "/auth/start") {
        const w = Math.floor(clock.t / 60_000);
        const c = (authStarts.get(w) ?? 0) + 1;
        authStarts.set(w, c);
        if (c > 10 || faults.has("p34_admin_429"))
          return new Response(null, { status: 429 });
        return new Response(null, {
          status: 302,
          headers: {
            location: `${CONFIG.broker}/google/authorize?install=i000000admin&ticket=t`,
          },
        });
      }
      if (url.pathname === "/auth/test-signin")
        return new Response(null, { status: 404 });
      if (url.pathname === "/auth/callback/google")
        return new Response(null, {
          status: 303,
          headers: { location: "/?error=signin" },
        });
      if (url.pathname === "/oauth/authorize") {
        if (url.searchParams.get("b") === "1")
          return new Response(null, {
            status: 302,
            headers: { location: "/auth/start?return=x" },
          });
        return new Response("<html>bounce</html>", { status: 200 });
      }
      return err(404, "not_found");
    }
    if (
      host === "admin.open-artifacts.app" ||
      host === "api.open-artifacts.app"
    )
      return faults.has("prod_live") && /^\/(api\/)?v1\/me$/.test(url.pathname)
        ? err(401, "unauthenticated")
        : new Response(null, { status: 404 });
    if (host === "auth.open-artifacts-staging.app") {
      if (url.searchParams.get("ticket"))
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
          },
        });
      return new Response(null, { status: 404 });
    }
    if (host === "inventory.open-artifacts-staging.app") {
      const a = req.headers.get("authorization");
      if (a !== `Bearer ${INV_JWT}` && !(faults.has("p27_no_token_ok") && !a))
        return new Response(null, { status: 404 });
      if (url.pathname === "/installs")
        return ok({
          installs: [...installs.values(), ...purged.values()].map((i) => ({
            id: i.id,
            appHost: i.appHost,
            contentHost: i.contentHost,
            state: i.state,
            testHooks: i.testHooks,
            mode: i.mode,
          })),
        });
      if (url.pathname === "/hosts") {
        const h = url.searchParams.get("host");
        const i = [...installs.values()].find(
          (x) => x.appHost === h || x.contentHost === h,
        );
        return ok({ host: h, installId: i?.id ?? null, mode: i?.mode ?? null });
      }
    }
    if (host === "inventory.open-artifacts.app")
      return new Response(null, { status: 404 });
    if (
      host === "rl-a.open-artifacts-staging.app" &&
      url.pathname === "/api/v1/me"
    ) {
      const t = req.headers.get("authorization")?.slice(7) ?? "";
      const v = pats.get(t);
      return new Response(null, { status: v && !v.revoked ? 200 : 401 });
    }
    return page(host, url.pathname);
  };

  const io: ProvIo = {
    fetch: handler as typeof fetch,
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    jwt: async () => API_JWT,
    stgInventoryJwt: async () => INV_JWT,
  };
  void panel;
  return {
    fetch: io.fetch,
    io,
    installs,
    jobs,
    pats,
    faults,
    clock,
    audit,
    log,
  };
}

/** The fake's version for rl-a after P24's bring-up (tests set it). */
export function setVersion(f: FakeApi, id: string, v: string): void {
  const i = f.installs.get(id);
  if (i) i.version = v;
}

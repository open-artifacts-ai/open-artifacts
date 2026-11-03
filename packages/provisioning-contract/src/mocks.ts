/**
 * MSW v2 handlers for the Provisioning API (@oa/provisioning-contract), for the
 * admin panel's component tests and local dev. Opt-in:
 * `createProvisioningHandlers()` is separate from createHandlers().
 *
 * - Both bases: `/api/v1/*` (admin host) and `/v1/*` (api host), any origin.
 * - The caller is an admin session: every route but R26 answers. No authz,
 *   CSRF or rate limits (those are API Worker tests).
 * - Stateful per call: writes validate the route's body schema (400
 *   invalid_input), check TRANSITIONS (409 invalid_state), the active job
 *   (409 job_in_progress) and confirmSlug (400 confirm_mismatch), then return
 *   202 with a queued job. R4 also checks the admin field rules (3.3) and the
 *   slug rule. Idempotency as 3.1: the same requestId with the same body hash
 *   replays the job as it is now (header `oa-idempotent-replay: 1`); with any
 *   other route, install or body it is 409 idempotency_conflict.
 * - Jobs stay `queued` until a test moves them: `advanceJob(id, status)` or
 *   `finishAllJobs()` on createProvisioningMock(). A finished job frees the
 *   install and applies its TRANSITIONS state; a failed create or retry
 *   leaves the install `failed`.
 * - R25 cancels only the install's active job (else 409 invalid_state): the
 *   job fails `canceled` and a `cleanup` job becomes the active one. When the
 *   cleanup finishes or fails the install is free again (a canceled create or
 *   retry settles `failed`).
 * - R27 world is computed from the store (attention from the fixtures);
 *   `world: "empty"` starts with no installs.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import { checkCreateFields, TRANSITIONS } from "./authz.js";
import { bodyHash } from "./bodyhash.js";
import { LIVE_TOKENS_PER_ADMIN } from "./constants.js";
import { jobStepsFor, type ProvisioningEnv } from "./enums.js";
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  type JobErrorCode,
} from "./errors.js";
import { FAKE_RELEASES } from "./fakes.js";
import {
  emptyWorld,
  fixtureInstall,
  fixtureMe,
  fixtureWorld,
} from "./fixtures.js";
import { mockWorld } from "./mock-world.js";
import { ROUTE_IDS, ROUTES, type RouteDef } from "./routes.js";
import {
  type Accepted,
  type CreateInstall,
  type InstallDetail,
  type InstallSummary,
  type Job,
  PAGE_LIMIT,
  type Token,
  type World,
} from "./schemas.js";
import { slugError, slugRule } from "./slugs.js";

export type ProvisioningMockOptions = {
  env?: ProvisioningEnv;
  world?: "fixtures" | "empty";
  /**
   * The clock for time-of-write fields (token createdAt/expiresAt, job and
   * audit times, the token_limit liveness check). Default: the fixed
   * fixture clock (T0, then +1 s per write), so tests stay deterministic;
   * dev and Playwright pass Date.now.
   */
  now?: () => number;
  /** Tokens the mock starts with (e.g. an `oauth` grant, which R19 never mints). */
  tokens?: readonly Token[];
  /**
   * Whether the caller may read owner emails (the server's pii rule; default
   * true). False is staging's test admin (#1053): R3 sends no ownerEmail and
   * R2's q never matches one, as the API.
   */
  pii?: boolean;
};

export type ProvisioningMock = {
  /** Spread into setupServer/setupWorker. */
  handlers: HttpHandler[];
  /**
   * Moves a job on: `running` from queued; `done` or `failed` from queued or
   * running (`code` defaults to `internal`). Settles the install as the API
   * would. Throws on an unknown job or a move from a finished one.
   */
  advanceJob(
    id: string,
    status: "running" | "done" | "failed",
    code?: JobErrorCode,
  ): Job;
  /** Finishes every queued or running job, oldest first. Returns how many. */
  finishAllJobs(status?: "done" | "failed"): number;
};

const BASES = ["*/api/v1", "*/v1"];

/** The query tag a cursor carries: the route and the filters that made it. */
const queryTag = (route: string, filters: Record<string, unknown>) =>
  `${route}:${JSON.stringify(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )}`;
const b64url = (s: string) =>
  btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const makeCursor = (offset: number, tag: string) =>
  b64url(JSON.stringify({ q: tag, k: offset }));
/** The offset, or null for anything this query didn't issue. */
const readCursor = (c: string, tag: string): number | null => {
  try {
    const o = JSON.parse(atob(c.replaceAll("-", "+").replaceAll("_", "/"))) as {
      q?: unknown;
      k?: unknown;
    };
    return o?.q === tag && Number.isInteger(o.k) && (o.k as number) >= 0
      ? (o.k as number)
      : null;
  } catch {
    return null;
  }
};

/** The API's schema refusal (invokeRoute's parseInput): every failing field. */
const invalidInput = (
  where: "params" | "query" | "body",
  issues: readonly { path: readonly PropertyKey[] }[],
) =>
  err("invalid_input", "invalid input", {
    fields: issues.map((i) => [where, ...i.path.map(String)].join(".")),
  });
const err = (code: ApiErrorCode, message: string, details?: unknown) =>
  HttpResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status: API_ERROR_STATUS[code] },
  );

const summaryOf = (d: InstallDetail): InstallSummary => ({
  id: d.id,
  slug: d.slug,
  appHost: d.appHost,
  contentHost: d.contentHost,
  state: d.state,
  servingMode: d.servingMode,
  version: d.version,
  tier: d.tier,
  auth: { providers: d.auth.providers, domainCount: d.auth.domains.length },
  health: d.health,
  source: d.source,
  activeJobId: d.activeJobId,
  createdAt: d.createdAt,
});

// Mock ids: deterministic per handler set, valid ULIDs and install ids.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const mockUlid = (n: number) => {
  let s = "";
  for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32))
    s = CROCKFORD[v % 32] + s;
  return `01JMCK${s}`;
};
const mockInstallId = (n: number) => `imock${n.toString(36).padStart(7, "0")}`;

export function createProvisioningHandlers(
  opts: ProvisioningMockOptions = {},
): HttpHandler[] {
  return createProvisioningMock(opts).handlers;
}

export function createProvisioningMock(
  opts: ProvisioningMockOptions = {},
): ProvisioningMock {
  const env = opts.env ?? "prod";
  const pii = opts.pii ?? true;
  const T0 = fixtureWorld().at;
  let seq = 0;
  const now = opts.now ?? (() => T0 + ++seq * 1000);
  const start = mockWorld();
  /** R17's rows (mockWorld): `tokenId` is the token that acted (the API's token_id). */
  const audit = start.audit;

  const installs = new Map<string, InstallDetail>();
  const jobs = new Map<string, Job>();
  const tokens: Token[] = (opts.tokens ?? []).map((t) => ({ ...t }));
  const replays = new Map<
    string,
    { hash: string; jobId: string; installId: string }
  >();
  const accepted = (jobId: string, installId: string): Accepted => ({
    job: jobs.get(jobId) as Job,
    install: summaryOf(installs.get(installId) as InstallDetail),
  });
  if (opts.world !== "empty") {
    for (const d of start.installs) installs.set(d.id, d);
    for (const j of start.jobs) jobs.set(j.id, j);
  }

  const newJob = (
    r: RouteDef,
    installId: string,
    args: Record<string, unknown>,
  ): Job => {
    const kind = r.job ?? "create";
    const steps = [...jobStepsFor(kind, args)];
    const j: Job = {
      id: mockUlid(++seq),
      kind,
      installId,
      status: "queued",
      step: null,
      steps,
      stepIndex: 0,
      attempt: 0,
      lastErrorCode: null,
      retryAt: null,
      actor: { kind: "admin", label: "admin", tokenId: null },
      args,
      error: null,
      sealed: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
    };
    jobs.set(j.id, j);
    return j;
  };

  const fail = (j: Job, code: JobErrorCode, message: string) => {
    j.status = "failed";
    j.error = { code, message };
    j.lastErrorCode = code;
    j.finishedAt = now();
  };

  // The install side of a finished job: the TRANSITIONS target on done, a
  // failed create or retry settles `failed`, and the install is free again
  // unless the job handed it on (a cancel's cleanup).
  const settle = (j: Job) => {
    const d = installs.get(j.installId);
    if (!d) return;
    if (d.activeJobId === j.id) d.activeJobId = null;
    const created = (k: string) => k === "create" || k === "retry";
    if (j.kind === "cleanup") {
      const canceled = jobs.get(String(j.args.jobId));
      if (canceled && created(canceled.kind)) d.state = "failed";
      return;
    }
    if (j.status === "failed") {
      if (created(j.kind)) d.state = "failed";
      return;
    }
    const at = now();
    const v = (j.args.version as InstallDetail["version"] | undefined) ?? null;
    const latest = FAKE_RELEASES.find((r) => r.latest)?.version ?? null;
    switch (j.kind) {
      case "create":
      case "retry":
        Object.assign(d, {
          state: "active",
          servingMode: "serving",
          version: v ?? latest,
          health: "ok",
        });
        break;
      case "upgrade":
        Object.assign(d, { previousVersion: d.version, version: v ?? latest });
        break;
      case "rollback":
        Object.assign(d, {
          previousVersion: d.version,
          version: d.previousVersion,
        });
        break;
      case "suspend":
        Object.assign(d, {
          state: "suspended",
          servingMode: "paused",
          suspendedAt: at,
          suspendReason: (j.args.reason as string | undefined) ?? null,
        });
        break;
      case "resume":
        Object.assign(d, {
          state: "active",
          servingMode: "serving",
          suspendedAt: null,
          suspendReason: null,
        });
        break;
      case "delete":
        Object.assign(d, {
          state: "deleting",
          servingMode: "closed",
          deletedAt: at,
          purgeAt: at + 30 * 86_400_000,
          restorable: true,
        });
        break;
      case "restore":
        Object.assign(d, {
          state: d.suspendedAt ? "suspended" : "active",
          servingMode: d.suspendedAt ? "paused" : "serving",
          deletedAt: null,
          purgeAt: null,
          restorable: false,
        });
        break;
      case "purge":
      case "discard":
        Object.assign(d, {
          state: "deleted",
          servingMode: "unmapped",
          restorable: false,
        });
        break;
      case "release_lease":
        d.lease = { held: false, until: null };
        break;
      default: {
        const to = TRANSITIONS[d.state][j.kind]?.to[0];
        if (to) d.state = to;
      }
    }
  };

  const advanceJob: ProvisioningMock["advanceJob"] = (
    id,
    status,
    code = "internal",
  ) => {
    const j = jobs.get(id);
    if (!j) throw new Error(`advanceJob: no job ${id}`);
    if (j.status === "done" || j.status === "failed")
      throw new Error(`advanceJob: job ${id} is already ${j.status}`);
    if (status === "running" && j.status === "running")
      throw new Error(`advanceJob: job ${id} is already running`);
    j.startedAt ??= now();
    if (status === "running") {
      j.status = "running";
      j.step = j.steps[0] ?? null;
      j.stepIndex = 0;
      return j;
    }
    if (status === "done") {
      j.status = "done";
      j.stepIndex = j.steps.length - 1;
      j.step = j.steps[j.stepIndex] ?? null;
      j.finishedAt = now();
    } else {
      j.step ??= j.steps[0] ?? null;
      fail(j, code, `${j.step ?? "job"} failed`);
    }
    settle(j);
    return j;
  };

  const finishAllJobs: ProvisioningMock["finishAllJobs"] = (
    status = "done",
  ) => {
    const open = [...jobs.values()]
      .filter((j) => j.status === "queued" || j.status === "running")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const j of open) advanceJob(j.id, status);
    return open.length;
  };

  const world = (): World => {
    if (opts.world === "empty" && installs.size === 0) return emptyWorld(env);
    const base = fixtureWorld({ env });
    const list = [...installs.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    const count = <K extends string>(
      keys: Record<K, number>,
      f: (d: InstallDetail) => K,
    ) => {
      const out = Object.fromEntries(
        Object.keys(keys).map((k) => [k, 0]),
      ) as Record<K, number>;
      for (const d of list) out[f(d)]++;
      return out;
    };
    const all = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    const attention = base.attention.filter(
      (a) => a.installId === null || installs.has(a.installId),
    );
    return {
      ...base,
      installs: {
        total: list.length,
        byState: count(base.installs.byState, (d) => d.state),
        byServingMode: count(base.installs.byServingMode, (d) => d.servingMode),
        byHealth: count(base.installs.byHealth, (d) => d.health),
        items: list.slice(0, 50).map(summaryOf),
      },
      jobs: {
        active: all.filter(
          (j) => j.status === "queued" || j.status === "running",
        ).length,
        failed24h: all.filter((j) => j.status === "failed").length,
        recent: all.slice(0, 10).map(({ sealed: _s, ...j }) => j),
      },
      attention,
      truncated: list.length > 50 || attention.length > 50,
    };
  };

  /**
   * A page of `items`. The cursor is opaque and tied to the query that made
   * it (`tag`: the route and its filters), as the API's: anything else is the
   * API's 400 `bad cursor`. Inside, only an offset.
   */
  const page = <T>(items: T[], c: Ctx, tag: string) => {
    const limit = (c.query.limit as number | undefined) ?? PAGE_LIMIT.default;
    let start = 0;
    if (c.query.cursor !== undefined) {
      const at = readCursor(String(c.query.cursor), tag);
      if (at === null) return err("invalid_input", "bad cursor");
      start = at;
    }
    const slice = items.slice(start, start + limit);
    const next =
      start + limit < items.length ? makeCursor(start + limit, tag) : null;
    return HttpResponse.json({ items: slice, nextCursor: next });
  };

  type Ctx = {
    params: Record<string, string>;
    url: URL;
    body: unknown;
    /** The query as the route's schema parsed it (defaults and coercion applied). */
    query: Record<string, unknown>;
  };
  const reads: Partial<
    Record<(typeof ROUTE_IDS)[number], (c: Ctx) => Response>
  > = {
    R1: () =>
      HttpResponse.json(
        fixtureMe({
          principal: "admin",
          email: "admin@example.com",
          scopes: [
            "installs:read",
            "installs:write",
            "installs:delete",
            "installs:pii",
            "audit:read",
          ],
          env,
          csrf: "mock-csrf",
          sessionExpiresAt: T0 + 8 * 3_600_000,
          authAt: T0,
          provisioningToken: "active",
          tokenId: null,
          tokenKind: null,
          tokenExpiresAt: null,
        }),
      ),
    R2: (c) => {
      // As the server's R2 q: a case-insensitive substring of the slug, the
      // id, a stored host or (this mock is an admin, so pii) the owner email.
      const matchesQ = (d: InstallDetail, needle: string) =>
        !needle ||
        [
          d.slug,
          d.id,
          d.appHost,
          d.contentHost,
          pii ? d.ownerEmail : null,
        ].some((v) => v?.toLowerCase().includes(needle));
      const q = c.query as { state?: string; source?: string; q?: string };
      const items = [...installs.values()]
        .filter((d) => !q.state || d.state === q.state)
        .filter((d) => !q.source || d.source === q.source)
        .filter((d) => matchesQ(d, (q.q ?? "").toLowerCase()))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(summaryOf);
      return page(
        items,
        c,
        queryTag("R2", { ...q, cursor: undefined, limit: undefined }),
      );
    },
    R3: ({ params }) => {
      const d = installs.get(params.id);
      if (!d) return err("not_found", "No such install.");
      return HttpResponse.json(pii ? d : { ...d, ownerEmail: null });
    },
    R14: (c) => {
      const { params } = c;
      if (!installs.has(params.id)) return err("not_found", "No such install.");
      const items = [...jobs.values()]
        .filter((j) => j.installId === params.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ sealed: _s, ...j }) => j);
      return page(items, c, queryTag("R14", { id: params.id }));
    },
    R15: ({ params }) => {
      const j = jobs.get(params.jobId);
      return j ? HttpResponse.json(j) : err("not_found", "No such job.");
    },
    R16: () => HttpResponse.json({ items: structuredClone(FAKE_RELEASES) }),
    R17: (c) => {
      const q = c.query as {
        installId?: string;
        actor?: string;
        action?: string;
      };
      // As the API's filters: one install, one exact action, and an actor by
      // its label, or `token:<id>` by the token that acted.
      const items = audit
        .filter((r) => !q.installId || r.entry.installId === q.installId)
        .filter((r) => !q.action || r.entry.action === q.action)
        .filter((r) =>
          !q.actor
            ? true
            : q.actor.startsWith("token:")
              ? r.tokenId === q.actor.slice("token:".length)
              : r.entry.actor.label === q.actor,
        )
        .map((r) => r.entry);
      return page(
        items,
        c,
        queryTag("R17", {
          installId: q.installId,
          action: q.action,
          actor: q.actor,
        }),
      );
    },
    R18: ({ params }) => {
      const rule = slugRule(params.slug);
      const taken = [...installs.values()].some(
        (d) => d.slug === params.slug && d.state !== "deleted",
      );
      return HttpResponse.json({
        slug: params.slug,
        status: rule === "ok" && taken ? "taken" : rule,
      });
    },
    R20: () => HttpResponse.json({ items: tokens }),
    R27: () => HttpResponse.json(world()),
  };

  const accept = async (r: RouteDef, c: Ctx): Promise<Response> => {
    const parsed = r.body.safeParse(c.body);
    if (!parsed.success) return err("invalid_input", "Invalid body.");
    const body = parsed.data as Record<string, unknown> & { requestId: string };
    const key = body.requestId;
    const hash = await bodyHash(
      r.id,
      c.params.id ?? c.params.jobId ?? null,
      body,
    );
    const prior = replays.get(key);
    if (prior && prior.hash !== hash)
      return err(
        "idempotency_conflict",
        "That requestId was used with another request.",
      );
    if (prior)
      return HttpResponse.json(accepted(prior.jobId, prior.installId), {
        status: 202,
        headers: { "oa-idempotent-replay": "1" },
      });

    let install: InstallDetail | undefined;
    if (r.id === "R4") {
      const refused = checkCreateFields(
        body as Partial<CreateInstall>,
        "admin",
        env,
        "",
      );
      if (refused)
        return err(refused.code, `${refused.field}: not allowed as sent.`, {
          field: refused.field,
        });
      const slug = body.slug as string;
      const bad = slugError(slug);
      if (bad) return err(bad, "That slug is not allowed.");
      if (
        [...installs.values()].some(
          (d) => d.slug === slug && d.state !== "deleted",
        )
      )
        return err("slug_taken", "That slug is taken.");
      const id = mockInstallId(++seq);
      install = fixtureInstall({
        id,
        slug,
        appHost: `${slug}.open-artifacts.app`,
        contentHost: `${slug}.oa-content.app`,
        state: "provisioning",
        servingMode: "unmapped",
        version: null,
        health: "unknown",
        previousVersion: null,
        suspendReason: null,
        createdAt: now(),
        ownerEmail: (body.ownerEmail as string | undefined) ?? null,
      });
      installs.set(id, install);
    } else if (r.id === "R25") {
      const j = jobs.get(c.params.jobId);
      if (!j) return err("not_found", "No such job.");
      install = installs.get(j.installId);
      if (!install) return err("not_found", "No such install.");
      if (body.confirmSlug !== install.slug)
        return err("confirm_mismatch", "confirmSlug does not match.");
      if (install.activeJobId !== j.id)
        return err("invalid_state", "The job is not active.");
      fail(j, "canceled", "Canceled.");
      body.jobId = j.id;
    } else {
      install = installs.get(c.params.id);
      if (!install) return err("not_found", "No such install.");
      if (install.activeJobId)
        return err("job_in_progress", "A job is running.", {
          jobId: install.activeJobId,
        });
      const kind = r.job ?? "create";
      const from = TRANSITIONS[install.state][kind];
      if (!from?.actors.includes("A"))
        return err(
          "invalid_state",
          `Cannot ${kind} a ${install.state} install.`,
        );
      if ("confirmSlug" in body && body.confirmSlug !== install.slug)
        return err("confirm_mismatch", "confirmSlug does not match.");
    }
    const {
      requestId: _r,
      confirmSlug: _c,
      turnstile: _t,
      ownerEmail: _o,
      ...args
    } = body;
    const job = newJob(r, install.id, args);
    install.activeJobId = job.id;
    replays.set(key, { hash, jobId: job.id, installId: install.id });
    return HttpResponse.json(accepted(job.id, install.id), { status: 202 });
  };

  const handlers: HttpHandler[] = [];
  for (const id of ROUTE_IDS) {
    const r = ROUTES[id];
    if (r.base !== "api" || id === "R26") continue;
    const run = async (c: Ctx): Promise<Response> => {
      if (id === "R28") {
        const p = r.body.safeParse(c.body);
        if (!p.success) return invalidInput("body", p.error.issues);
        // As the API: the session's sid sealed to recipientKey, and its end.
        return HttpResponse.json(
          {
            sealed: "oa-seal-v1.MOCK_not_sealed",
            expiresAt: now() + 3_600_000,
          },
          { status: 201 },
        );
      }
      if (r.method === "GET")
        return reads[id]?.(c) ?? err("internal", "Not mocked.");
      if (id === "R19") {
        const p = r.body.safeParse(c.body);
        if (!p.success) return err("invalid_input", "Invalid body.");
        const b = p.data as {
          label: string;
          scopes: Token["scopes"];
          ttlMinutes: number;
        };
        const at = now();
        const live = tokens.filter(
          (x) => x.revokedAt === null && x.expiresAt > at,
        ).length;
        if (live >= LIVE_TOKENS_PER_ADMIN)
          return err(
            "token_limit",
            `At most ${LIVE_TOKENS_PER_ADMIN} live tokens per admin.`,
          );
        const t: Token = {
          id: mockUlid(++seq),
          kind: "oat",
          label: b.label,
          clientName: null,
          scopes: b.scopes,
          createdAt: at,
          expiresAt: at + b.ttlMinutes * 60_000,
          revokedAt: null,
          lastUsedAt: null,
        };
        tokens.push(t);
        // Fails the oat_ format on purpose: never a live-looking token.
        return HttpResponse.json(
          { ...t, token: "oat_MOCK_not_a_token" },
          { status: 201 },
        );
      }
      if (id === "R21") {
        const at = now();
        if (!c.params.id) {
          for (const t of tokens) t.revokedAt ??= at;
          return new HttpResponse(null, { status: 204 });
        }
        const t = tokens.find((x) => x.id === c.params.id);
        if (!t) return err("not_found", "No such token.");
        t.revokedAt = at;
        return new HttpResponse(null, { status: 204 });
      }
      return accept(r, c);
    };
    for (const base of BASES) {
      const path = `${base}${r.path}`;
      const method =
        r.method === "GET"
          ? http.get
          : r.method === "POST"
            ? http.post
            : http.delete;
      handlers.push(
        method(path, async ({ request, params }) => {
          const body =
            r.method === "POST"
              ? await request.json().catch(() => undefined)
              : undefined;
          const url = new URL(request.url);
          // The route's query schema first, as the API's parseInput.
          const raw: Record<string, string> = {};
          url.searchParams.forEach((v, k) => {
            raw[k] = v;
          });
          const q = r.query.safeParse(raw);
          if (!q.success) return invalidInput("query", q.error.issues);
          return run({
            params: params as Record<string, string>,
            url,
            body,
            query: q.data as Record<string, unknown>,
          });
        }),
      );
    }
  }
  return { handlers, advanceJob, finishAllJobs };
}

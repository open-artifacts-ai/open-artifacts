/**
 * MSW v2 handlers for the Provisioning API (@oa/shared/provisioning), for the
 * admin panel's component tests and local dev. Opt-in:
 * `createProvisioningHandlers()` is separate from createHandlers().
 *
 * - Both bases: `/api/v1/*` (admin host) and `/v1/*` (api host), any origin.
 * - The caller is an admin session: every route but R26 answers. No authz,
 *   CSRF or rate limits (those are API Worker tests).
 * - Stateful per call: writes validate the route's body schema (400
 *   invalid_input), check TRANSITIONS (409 invalid_state), the active job
 *   (409 job_in_progress) and confirmSlug (400 confirm_mismatch), then return
 *   202 with a queued job. The same requestId on the same route and install
 *   replays (header `oa-idempotent-replay: 1`). Jobs never advance.
 * - R27 world is computed from the store (attention from the fixtures);
 *   `world: "empty"` starts with no installs.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import { TRANSITIONS } from "../provisioning/authz.js";
import { JOB_STEPS, type ProvisioningEnv } from "../provisioning/enums.js";
import { API_ERROR_STATUS, type ApiErrorCode } from "../provisioning/errors.js";
import { FAKE_RELEASES } from "../provisioning/fakes.js";
import {
  emptyWorld,
  FIXTURE_IDS,
  fixtureAudit,
  fixtureInstall,
  fixtureJob,
  fixtureMe,
  fixtureWorld,
} from "../provisioning/fixtures.js";
import { ROUTE_IDS, ROUTES, type RouteDef } from "../provisioning/routes.js";
import type {
  Accepted,
  InstallDetail,
  InstallSummary,
  Job,
  Token,
  World,
} from "../provisioning/schemas.js";
import { slugRule } from "../provisioning/slugs.js";

export type ProvisioningMockOptions = {
  env?: ProvisioningEnv;
  world?: "fixtures" | "empty";
};

const BASES = ["*/api/v1", "*/v1"];
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
  const env = opts.env ?? "prod";
  const T0 = fixtureWorld().at;
  let seq = 0;
  const now = () => T0 + ++seq * 1000;

  const installs = new Map<string, InstallDetail>();
  const jobs = new Map<string, Job>();
  const tokens: Token[] = [];
  const replays = new Map<string, Accepted>();
  if (opts.world !== "empty") {
    for (const s of fixtureWorld().installs.items)
      installs.set(
        s.id,
        fixtureInstall({
          ...s,
          auth: fixtureInstall().auth,
          activeJobId: null,
        }),
      );
    jobs.set(
      FIXTURE_IDS.jobLeo,
      fixtureJob({
        status: "done",
        step: "done",
        stepIndex: 5,
        finishedAt: T0 + 5000,
      }),
    );
    jobs.set(
      FIXTURE_IDS.jobBroken,
      fixtureJob({
        id: FIXTURE_IDS.jobBroken,
        kind: "create",
        installId: FIXTURE_IDS.broken,
        status: "failed",
        step: "verify_clean",
        steps: [...JOB_STEPS.create],
        stepIndex: 5,
        lastErrorCode: "prod_dirty",
        error: { code: "prod_dirty", message: "verify_clean refused" },
        args: { version: "1.42.0" },
        finishedAt: T0 + 6000,
      }),
    );
  }

  const newJob = (
    r: RouteDef,
    installId: string,
    args: Record<string, unknown>,
  ): Job => {
    const kind = r.job ?? "create";
    const steps = [...JOB_STEPS[kind]];
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

  const page = <T>(items: T[], url: URL) => {
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? 50) || 50,
      100,
    );
    const start = Number(url.searchParams.get("cursor") ?? 0) || 0;
    const slice = items.slice(start, start + limit);
    const next = start + limit < items.length ? String(start + limit) : null;
    return HttpResponse.json({ items: slice, nextCursor: next });
  };

  type Ctx = { params: Record<string, string>; url: URL; body: unknown };
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
          tokenKind: null,
          tokenExpiresAt: null,
        }),
      ),
    R2: ({ url }) => {
      const q = url.searchParams;
      const items = [...installs.values()]
        .filter((d) => !q.get("state") || d.state === q.get("state"))
        .filter((d) => !q.get("source") || d.source === q.get("source"))
        .filter((d) => !q.get("q") || d.slug.includes(q.get("q") ?? ""))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(summaryOf);
      return page(items, url);
    },
    R3: ({ params }) => {
      const d = installs.get(params.id);
      return d ? HttpResponse.json(d) : err("not_found", "No such install.");
    },
    R14: ({ params, url }) => {
      if (!installs.has(params.id)) return err("not_found", "No such install.");
      const items = [...jobs.values()]
        .filter((j) => j.installId === params.id)
        .sort((a, b) => b.createdAt - a.createdAt);
      return page(items, url);
    },
    R15: ({ params }) => {
      const j = jobs.get(params.jobId);
      return j ? HttpResponse.json(j) : err("not_found", "No such job.");
    },
    R16: () => HttpResponse.json({ items: structuredClone(FAKE_RELEASES) }),
    R17: ({ url }) => page([fixtureAudit()], url),
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
    const key = `${r.id}:${c.params.id ?? c.params.jobId ?? ""}:${body.requestId}`;
    const prior = replays.get(key);
    if (prior)
      return HttpResponse.json(prior, {
        status: 202,
        headers: { "oa-idempotent-replay": "1" },
      });

    let install: InstallDetail | undefined;
    if (r.id === "R4") {
      const slug = body.slug as string;
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
      if (j.status !== "queued" && j.status !== "running")
        return err("invalid_state", "The job is not active.");
      j.status = "failed";
      j.error = { code: "canceled", message: "Canceled." };
      j.lastErrorCode = "canceled";
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
    const out: Accepted = { job, install: summaryOf(install) };
    replays.set(key, out);
    return HttpResponse.json(out, { status: 202 });
  };

  const handlers: HttpHandler[] = [];
  for (const id of ROUTE_IDS) {
    const r = ROUTES[id];
    if (r.base !== "api" || id === "R26") continue;
    const run = async (c: Ctx): Promise<Response> => {
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
        return HttpResponse.json(
          { ...t, token: `oat_${"m".repeat(43)}` },
          { status: 201 },
        );
      }
      if (id === "R21") {
        const t = tokens.find((x) => x.id === c.params.tokenId);
        if (!t) return err("not_found", "No such token.");
        t.revokedAt = now();
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
          return run({
            params: params as Record<string, string>,
            url: new URL(request.url),
            body,
          });
        }),
      );
    }
  }
  return handlers;
}

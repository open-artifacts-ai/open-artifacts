import {
  AUDIT_NEXT_CURSOR_HEADER,
  AUDIT_TEAM_WINDOW_DAYS,
  AUDIT_WINDOW_HEADER,
  type Member,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { scopedPlan } from "../billing/features.js";
import { auditPlanError, billingActive } from "../billing/plan.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  AUDIT_PAGE_MAX,
  auditFilters,
  exportAudit,
  listAudit,
} from "../services/audit.js";
import type { AppType } from "./index.js";

const DEFAULT_LIMIT = 50;

/** 1..AUDIT_PAGE_MAX, default 50; anything else 400. */
function limitOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > AUDIT_PAGE_MAX)
    throw new ApiError("bad_request", "Invalid limit", {
      path: "limit",
      reason: "invalid",
    });
  return n;
}

/**
 * Org owners and admins only (audit.read; a cap drops it); everyone else
 * 404. The route policy gate enforces the same rule first; this keeps the
 * handler safe on its own.
 */
function requireAuditor(c: Context<AppEnv>): Member {
  const user = requireUser(c);
  if (
    !orgCan(user, "audit.read", {
      cap: capOfCaller(caller(c)),
      read: c.req.method === "GET",
    })
  )
    throw new ApiError("not_found", "Not found");
  return user;
}

/**
 * Hosted billing: Business reads the whole log; Team and the Team trial the
 * last AUDIT_TEAM_WINDOW_DAYS days; Solo and free are refused. Returns the
 * window in days (null: all of it). A lapsed plan keeps its tier. Self-hosted
 * is never limited. Runs after requireAuditor, so a non-admin gets 404 first.
 */
function auditWindow(c: Context<AppEnv>): {
  days: number | null;
  since: number;
} {
  if (!billingActive(c.env)) return { days: null, since: 0 };
  const plan = scopedPlan();
  if (plan?.tier === "business") return { days: null, since: 0 };
  if (plan?.tier === "team" || plan?.tier === "trial")
    return {
      days: AUDIT_TEAM_WINDOW_DAYS,
      since: Date.now() - AUDIT_TEAM_WINDOW_DAYS * 86_400_000,
    };
  throw auditPlanError(plan?.tier);
}

export function mountAudit(app: AppType): void {
  app.get(R.audit, async (c) => {
    requireAuditor(c);
    const w = auditWindow(c);
    if (w.days) c.header(AUDIT_WINDOW_HEADER, String(w.days));
    return c.json(
      await listAudit(
        c.env,
        c.req.query("cursor"),
        limitOf(c.req.query("limit")),
        auditFilters(c.req.queries()),
        w.since,
      ),
    );
  });

  // Bounded per request (exportAudit); the header continues it.
  app.get(R.auditExport, async (c) => {
    requireAuditor(c);
    const w = auditWindow(c);
    const { stream, nextCursor } = await exportAudit(
      c.env,
      c.req.query("cursor"),
      auditFilters(c.req.queries()),
      w.since,
    );
    const headers: Record<string, string> = {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": 'attachment; filename="audit.ndjson"',
      "cache-control": "no-store",
    };
    if (w.days) headers[AUDIT_WINDOW_HEADER] = String(w.days);
    if (nextCursor) headers[AUDIT_NEXT_CURSOR_HEADER] = nextCursor;
    return new Response(stream, { headers });
  });
}

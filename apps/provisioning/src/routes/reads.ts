import {
  type AuditEntry,
  InstallIdSchema,
  type InstallSummary,
  type Job,
  JobIdSchema,
  type JobListItem,
  type Me,
  PAGE_LIMIT,
  PrincipalKindSchema,
  type SlugCheck,
  slugRule,
} from "@oa/shared/provisioning";
import { z } from "zod";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { limit as rateLimit } from "../limits.js";
import {
  CreatedCursor,
  decodeCursor,
  detailOf,
  encodeCursor,
  inReach,
  type JobRow,
  jobItemOf,
  jobOf,
  loadInReach,
  loadJob,
  loadStatus,
  reachSql,
  STATUS_SELECT,
  type StatusRow,
  summaryOf,
} from "../model.js";
import type { Principal } from "../principal.js";
import { releases, tokenStatus } from "../services/cache.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";

// The read routes (3.4): R1, R2, R3, R14, R15, R16, R17, R18.

const ok = (body: unknown): RouteResult => ({ status: 200, body, headers: {} });
type Query = Record<string, string | number | undefined>;
const q = (a: HandlerArgs) => (a.input.query ?? {}) as Query;
const pageLimit = (a: HandlerArgs) =>
  (q(a).limit as number | undefined) ?? PAGE_LIMIT.default;

/**
 * What a principal may carry beyond the C4 Principal for R1 (W5a sessions,
 * W5b tokens set them); absent reads as null.
 */
export type MeFacts = {
  csrf?: string | null;
  sessionExpiresAt?: number | null;
  tokenKind?: Me["tokenKind"];
  tokenExpiresAt?: number | null;
};

export async function me(a: HandlerArgs): Promise<RouteResult> {
  const p = a.principal as Principal & MeFacts;
  const body: Me = {
    principal: p.kind,
    email: p.email ?? null,
    role: p.kind === "user" ? "user" : "admin",
    scopes: [...p.scopes],
    env: a.env.OA_ENV,
    csrf: p.csrf ?? null,
    sessionExpiresAt: p.sessionExpiresAt ?? null,
    authAt: p.authAt ?? null,
    provisioningToken:
      p.kind === "admin" ? (await tokenStatus(a.env)).status : null,
    tokenId: p.tokenId ?? null,
    tokenKind: p.tokenKind ?? null,
    tokenExpiresAt: p.tokenExpiresAt ?? null,
  };
  return ok(body);
}

/** R2: install_status newest first, by (created_at desc, install_id desc). */
export async function listInstalls(a: HandlerArgs): Promise<RouteResult> {
  const query = q(a);
  const where: string[] = [];
  const binds: unknown[] = [];
  const r = reachSql(a.principal, a.reach);
  where.push(r.sql);
  binds.push(...r.binds);
  if (query.state) {
    where.push("st.state = ?");
    binds.push(query.state);
  }
  if (query.source) {
    where.push("st.source = ?");
    binds.push(query.source);
  }
  if (query.q) {
    where.push("instr(st.slug, ?) > 0");
    binds.push(String(query.q).toLowerCase());
  }
  if (query.cursor) {
    const [at, id] = decodeCursor(String(query.cursor), CreatedCursor);
    where.push(
      "(st.created_at < ? OR (st.created_at = ? AND st.install_id < ?))",
    );
    binds.push(at, at, id);
  }
  const n = pageLimit(a);
  const rows = (
    await a.env.PLATFORM_DB.prepare(
      `${STATUS_SELECT} WHERE ${where.join(" AND ")} ORDER BY st.created_at DESC, st.install_id DESC LIMIT ?`,
    )
      .bind(...binds, n + 1)
      .all<StatusRow>()
  ).results;
  const items: InstallSummary[] = rows
    .slice(0, n)
    .map((x) => summaryOf(a.env, x));
  const last = rows.length > n ? rows[n - 1] : undefined;
  return ok({
    items,
    nextCursor: last ? encodeCursor([last.created_at, last.install_id]) : null,
  });
}

/** Owner email: admin session, the owner, or a token with installs:pii (3.3). */
const seesEmail = (p: Principal, row: StatusRow) =>
  p.kind === "admin" ||
  (p.kind === "token" && p.scopes.includes("installs:pii")) ||
  (p.kind === "user" && row.owner_sub !== null && row.owner_sub === p.sub);

export async function getInstall(a: HandlerArgs): Promise<RouteResult> {
  const { id } = a.input.params as { id: string };
  const row = await loadInReach(a.env, id, a.principal, a.reach);
  return ok(await detailOf(a.env, row, seesEmail(a.principal, row)));
}

/** R14: the install's jobs newest first; `sealed` is only ever on R15. */
export async function listJobs(a: HandlerArgs): Promise<RouteResult> {
  const { id } = a.input.params as { id: string };
  await loadInReach(a.env, id, a.principal, a.reach);
  const query = q(a);
  const binds: unknown[] = [id];
  let after = "";
  if (query.cursor) {
    const [at, jid] = decodeCursor(String(query.cursor), CreatedCursor);
    after = "AND (created_at < ? OR (created_at = ? AND id < ?))";
    binds.push(at, at, jid);
  }
  const n = pageLimit(a);
  const rows = (
    await a.env.PLATFORM_DB.prepare(
      `SELECT * FROM jobs WHERE install_id = ? ${after} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds, n + 1)
      .all<JobRow>()
  ).results;
  const items: JobListItem[] = rows.slice(0, n).map(jobItemOf);
  const last = rows.length > n ? rows[n - 1] : undefined;
  return ok({
    items,
    nextCursor: last ? encodeCursor([last.created_at, last.id]) : null,
  });
}

/**
 * R15: `sealed` goes only to the OIDC caller that created the job, once:
 * the read clears it in the same statement, so two reads never both get it.
 */
export async function getJob(a: HandlerArgs): Promise<RouteResult> {
  const { jobId } = a.input.params as { jobId: string };
  const p = a.principal;
  const row = await loadJob(a.env, jobId);
  if (!row) throw new ApiError("not_found");
  const install = await loadStatus(a.env, row.install_id);
  if (a.reach === "own" && !(install && inReach(install, p, a.reach)))
    throw new ApiError("not_found");
  let sealed: string | null = null;
  if (
    p.kind === "oidc" &&
    row.actor_key === p.actorKey &&
    row.sealed !== null
  ) {
    const r = await a.env.PLATFORM_DB.prepare(
      "UPDATE jobs SET sealed = NULL WHERE id = ? AND sealed IS NOT NULL RETURNING ? AS sealed",
    )
      .bind(row.id, row.sealed)
      .first<{ sealed: string }>();
    sealed = r?.sealed ?? null;
  }
  const job: Job = jobOf(row, sealed);
  return ok(job);
}

export async function listReleases(a: HandlerArgs): Promise<RouteResult> {
  return ok({ items: await releases(a.env) });
}

/** R18. A self-serve user spends RL_PV_SLUG_IP by IP (4.7). */
export async function checkSlug(a: HandlerArgs): Promise<RouteResult> {
  const { slug } = a.input.params as { slug: string };
  if (a.principal.kind === "user") {
    if (a.surface.kind !== "http") throw new ApiError("forbidden");
    const r = await rateLimit(a.env, "slug_ip", a.surface.client.ip);
    if (r) throw new ApiError(r.code);
  }
  const rule = slugRule(slug);
  let status: SlugCheck["status"] = rule;
  if (rule === "ok" && (await slugHeld(a.env, slug))) status = "taken";
  return ok({ slug, status } satisfies SlugCheck);
}

/** A live install or a live signup holds the slug (3.5 slug_taken). */
export async function slugHeld(env: Env, slug: string): Promise<boolean> {
  const r = await env.PLATFORM_DB.prepare(
    `SELECT 1 AS x FROM installs WHERE slug = ?1
UNION ALL SELECT 1 FROM signups WHERE slug = ?1 AND status <> 'failed' LIMIT 1`,
  )
    .bind(slug)
    .first();
  return r !== null;
}

// R17 (4.9, 9A.8): admin_audit, hosted_audit and audit_refusals merged,
// ids `api:<n>`, `prov:<n>`, `agg:<n>`, order (at desc, source, id desc).

const AUDIT_SOURCES = {
  api: "api",
  provision: "prov",
  refusals: "agg",
} as const;
const AuditCursor = z.object({
  at: z.number(),
  source: z.enum(["api", "provision", "refusals"]),
  id: z.number().int(),
});

const AUDIT_UNION = `SELECT 'api' AS source, id, at, actor_kind, COALESCE(actor_label, '') AS actor_label, token_id, action, install_id, job_id, outcome, code, 1 AS count, detail FROM admin_audit
UNION ALL
SELECT 'provision', id, at, 'system', COALESCE(actor, 'provisioner'), NULL, action, install_id,
  CASE WHEN actor LIKE 'job:%' THEN substr(actor, 5) END,
  CASE WHEN action LIKE '%failed%' THEN 'error' ELSE 'ok' END, NULL, 1, detail FROM hosted_audit
UNION ALL
SELECT 'refusals', id, window_start, 'system', 'anonymous', NULL,
  CASE WHEN code = 'rate_limited' THEN 'rate_limited' ELSE bucket || '.refused' END,
  NULL, NULL, 'refused', code, count, json_object('bucket', bucket) FROM audit_refusals`;

type AuditRow = {
  source: AuditEntry["source"];
  id: number;
  at: number;
  actor_kind: string;
  actor_label: string;
  token_id: string | null;
  action: string;
  install_id: string | null;
  job_id: string | null;
  outcome: AuditEntry["outcome"];
  code: string | null;
  count: number;
  detail: string | null;
};

const EMAIL_FIELDS = ["email", "ownerEmail"] as const;

/** 9A.8: a token without installs:pii sees no email-valued detail field. */
function detailFor(
  p: Principal,
  raw: string | null,
): Record<string, unknown> | null {
  if (raw === null) return null;
  let d: Record<string, unknown>;
  try {
    const v = JSON.parse(raw);
    d = v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch {
    d = { value: raw };
  }
  if (p.kind === "token" && !p.scopes.includes("installs:pii")) {
    for (const f of EMAIL_FIELDS) if (f in d) d[f] = null;
    // The token's own minting admin stays; another admin's email does not.
    if ("admin" in d && d.admin !== p.email) d.admin = null;
  }
  return d;
}

export async function queryAudit(a: HandlerArgs): Promise<RouteResult> {
  const p = a.principal;
  const query = q(a);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (a.reach === "own") {
    // O: its own actor rows only.
    where.push("source = 'api' AND actor_kind = ? AND actor_label = ?");
    binds.push(p.kind, p.label);
  }
  if (query.installId) {
    where.push("install_id = ?");
    binds.push(query.installId);
  }
  if (query.action) {
    where.push("action = ?");
    binds.push(query.action);
  }
  if (query.actor) {
    const actor = String(query.actor);
    if (actor.startsWith("token:")) {
      where.push("token_id = ?");
      binds.push(actor.slice("token:".length));
    } else {
      where.push("actor_label = ?");
      binds.push(actor);
    }
  }
  if (query.cursor) {
    const c = decodeCursor(String(query.cursor), AuditCursor);
    where.push(
      "(at < ? OR (at = ? AND (source > ? OR (source = ? AND id < ?))))",
    );
    binds.push(c.at, c.at, c.source, c.source, c.id);
  }
  const n = pageLimit(a);
  const rows = (
    await a.env.PLATFORM_DB.prepare(
      `SELECT * FROM (${AUDIT_UNION})${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, source ASC, id DESC LIMIT ?`,
    )
      .bind(...binds, n + 1)
      .all<AuditRow>()
  ).results;
  const items: AuditEntry[] = rows.slice(0, n).map((r) => ({
    id: `${AUDIT_SOURCES[r.source]}:${r.id}`,
    at: r.at,
    source: r.source,
    actor: {
      kind: PrincipalKindSchema.catch("system").parse(r.actor_kind),
      label: r.actor_label,
    },
    action: r.action,
    installId: InstallIdSchema.safeParse(r.install_id).success
      ? r.install_id
      : null,
    jobId: JobIdSchema.safeParse(r.job_id).success ? r.job_id : null,
    outcome: r.outcome,
    code: r.code,
    count: r.count,
    detail: detailFor(p, r.detail),
  }));
  const last = rows.length > n ? rows[n - 1] : undefined;
  return ok({
    items,
    nextCursor: last
      ? encodeCursor({ at: last.at, source: last.source, id: last.id })
      : null,
  });
}

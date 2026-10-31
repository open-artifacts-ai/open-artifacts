import { z } from "zod";
import { InstallStateSchema, type JobKind } from "./enums.js";
import { InstallIdSchema, JobIdSchema, TokenIdSchema } from "./ids.js";
import {
  AcceptedSchema,
  AuditEntrySchema,
  CancelJobSchema,
  CreateInstallSchema,
  DeleteSchema,
  InstallDetailSchema,
  InstallSummarySchema,
  JobListItemSchema,
  JobSchema,
  MeSchema,
  MintedTokenSchema,
  MintTokenSchema,
  PAGE_LIMIT,
  PageSchema,
  PurgeSchema,
  RedlineCredsSchema,
  ReleaseLeaseSchema,
  ReleasesSchema,
  RestoreSchema,
  ResumeSchema,
  RetrySchema,
  RollbackSchema,
  SlugCheckSchema,
  SuspendSchema,
  TokensSchema,
  UpgradeSchema,
  WorldSchema,
} from "./schemas.js";

// The route table (design v7 3.4). Paths are relative to the base: `/api/v1`
// on browser hosts and `/v1` on api.<app> for "api" routes; "browser" routes
// (sign-in, logout) sit at the root of the browser hosts only.

export const ROUTE_IDS = [
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
  "R13",
  "R14",
  "R15",
  "R16",
  "R17",
  "R18",
  "R19",
  "R20",
  "R21",
  "R22",
  "R23",
  "R24",
  "R25",
  "R26",
  "R27",
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];
export const RouteIdSchema = z.enum(ROUTE_IDS);
/**
 * The browser routes (R22-R24: cookies, Set-Cookie, redirects). They never
 * reach invokeRoute (9A.4) and no admin tool names one.
 */
export type BrowserRouteId = "R22" | "R23" | "R24";
/** The routes invokeRoute serves and admin tools name: every "api" base route. */
export type ApiRouteId = Exclude<RouteId, BrowserRouteId>;

type Obj = z.ZodObject<z.ZodRawShape>;
/** A route body: one object, or a union of objects (R26 mint | revoke). */
export type RouteBody = Obj | z.ZodUnion<readonly [Obj, ...Obj[]]>;
export interface RouteDef {
  id: RouteId;
  method: "GET" | "POST" | "DELETE";
  path: string;
  base: "api" | "browser";
  params: Obj;
  query: Obj;
  body: RouteBody;
  /** The 2xx body; z.null() for 204 and redirects. */
  response: z.ZodType;
  status: 200 | 201 | 202 | 204 | 302 | 303;
  write: boolean;
  /** The job kind a write starts (R11 may pick discard, 3.2). */
  job?: JobKind;
}

const none = z.object({});
const limit = z.coerce.number().int().min(1).max(PAGE_LIMIT.max).optional();
const cursor = z.string().max(512).optional();
const id = z.object({ id: InstallIdSchema });

const read = (
  r: RouteId,
  path: string,
  response: z.ZodType,
  more: Partial<Pick<RouteDef, "params" | "query">> = {},
): RouteDef => ({
  id: r,
  method: "GET",
  path,
  base: "api",
  params: more.params ?? none,
  query: more.query ?? none,
  body: none,
  response,
  status: 200,
  write: false,
});
const job = (
  r: RouteId,
  path: string,
  kind: JobKind,
  body: RouteBody,
): RouteDef => ({
  id: r,
  method: "POST",
  path,
  base: "api",
  params: path.includes(":jobId")
    ? z.object({ jobId: JobIdSchema })
    : path.includes(":id")
      ? id
      : none,
  query: none,
  body,
  response: AcceptedSchema,
  status: 202,
  write: true,
  job: kind,
});

export const ROUTES: Readonly<Record<RouteId, RouteDef>> = {
  R1: read("R1", "/me", MeSchema),
  R2: read("R2", "/installs", PageSchema(InstallSummarySchema), {
    query: z.object({
      cursor,
      limit,
      q: z.string().max(100).optional(),
      state: InstallStateSchema.optional(),
      source: z.enum(["admin", "self-serve"]).optional(),
    }),
  }),
  R3: read("R3", "/installs/:id", InstallDetailSchema, { params: id }),
  R4: job("R4", "/installs", "create", CreateInstallSchema),
  R5: job("R5", "/installs/:id/upgrade", "upgrade", UpgradeSchema),
  R6: job("R6", "/installs/:id/rollback", "rollback", RollbackSchema),
  R7: job("R7", "/installs/:id/suspend", "suspend", SuspendSchema),
  R8: job("R8", "/installs/:id/resume", "resume", ResumeSchema),
  R9: job("R9", "/installs/:id/delete", "delete", DeleteSchema),
  R10: job("R10", "/installs/:id/restore", "restore", RestoreSchema),
  R11: job("R11", "/installs/:id/purge", "purge", PurgeSchema),
  R12: job("R12", "/installs/:id/retry", "retry", RetrySchema),
  R13: job(
    "R13",
    "/installs/:id/release-lease",
    "release_lease",
    ReleaseLeaseSchema,
  ),
  R14: read("R14", "/installs/:id/jobs", PageSchema(JobListItemSchema), {
    params: id,
    query: z.object({ cursor, limit }),
  }),
  R15: read("R15", "/jobs/:jobId", JobSchema, {
    params: z.object({ jobId: JobIdSchema }),
  }),
  R16: read("R16", "/releases", ReleasesSchema),
  R17: read("R17", "/audit", PageSchema(AuditEntrySchema), {
    query: z.object({
      cursor,
      limit,
      installId: InstallIdSchema.optional(),
      actor: z.string().max(200).optional(),
      action: z.string().max(100).optional(),
    }),
  }),
  R18: read("R18", "/slugs/:slug", SlugCheckSchema, {
    params: z.object({ slug: z.string().max(64) }),
  }),
  R19: {
    id: "R19",
    method: "POST",
    path: "/tokens",
    base: "api",
    params: none,
    query: none,
    body: MintTokenSchema,
    response: MintedTokenSchema,
    status: 201,
    write: true,
  },
  R20: read("R20", "/tokens", TokensSchema),
  // Optional id: `DELETE /tokens` (no id) revokes all of both kinds.
  R21: {
    id: "R21",
    method: "DELETE",
    path: "/tokens/:id?",
    base: "api",
    params: z.object({ id: TokenIdSchema.optional() }),
    query: none,
    body: none,
    response: z.null(),
    status: 204,
    write: true,
  },
  R22: {
    id: "R22",
    method: "GET",
    path: "/auth/start",
    base: "browser",
    params: none,
    // Checked with safeReturn (return.ts), at start and at the callback.
    query: z.object({
      return: z.string().max(2048).optional(),
      reauth: z.enum(["1"]).optional(),
    }),
    body: none,
    response: z.null(),
    status: 302,
    write: false,
  },
  R23: {
    id: "R23",
    method: "GET",
    path: "/auth/callback/google",
    base: "browser",
    params: none,
    query: z.object({
      code: z.string().max(4096).optional(),
      state: z.string().max(4096).optional(),
      error: z.string().max(200).optional(),
    }),
    body: none,
    response: z.null(),
    status: 303,
    write: false,
  },
  R24: {
    id: "R24",
    method: "POST",
    path: "/auth/logout",
    base: "browser",
    params: none,
    query: none,
    body: none,
    response: z.null(),
    status: 204,
    write: true,
  },
  R25: job("R25", "/jobs/:jobId/cancel", "cleanup", CancelJobSchema),
  R26: job(
    "R26",
    "/installs/:id/redline-creds",
    "redline_creds",
    RedlineCredsSchema,
  ),
  R27: read("R27", "/world", WorldSchema),
};

/** The object schemas of a route body: itself, or each union option. */
export const bodyVariants = (r: RouteDef): readonly Obj[] =>
  r.body instanceof z.ZodUnion ? r.body.options : [r.body];

/** Protocol routes: no API principal, their own limits, fixed host (9A.3.1). */
export const isApiRoute = (id: RouteId): id is ApiRouteId =>
  ROUTES[id].base === "api";

export const PROTOCOL_ROUTES = [
  { method: "POST", path: "/mcp", host: "api" },
  { method: "GET", path: "/oauth/authorize", host: "admin" },
  { method: "POST", path: "/oauth/authorize", host: "admin" },
  { method: "POST", path: "/oauth/token", host: "api" },
  { method: "POST", path: "/oauth/register", host: "api" },
  {
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    host: "api",
  },
  // RFC 9728, as WWW-Authenticate's resource_metadata names it.
  {
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    host: "api",
  },
] as const;

import { type ErrorCode, QUOTA_MESSAGE, STATUS_FOR } from "@oa/shared";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import {
  OAuthStoreConfigError,
  storeMisconfigured,
} from "../mcp/oauth-store.js";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const QUOTA_NEEDLE = "exceeded D1's free tier daily";
const MAX_CAUSE_DEPTH = 5;

export function isD1QuotaError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i <= MAX_CAUSE_DEPTH; i++) {
    if (cur === null || typeof cur !== "object") return false;
    const o = cur as { message?: unknown; cause?: unknown };
    if (typeof o.message === "string" && o.message.includes(QUOTA_NEEDLE)) {
      return true;
    }
    cur = o.cause;
  }
  return false;
}

export function errorJson(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
  headers?: HeadersInit,
): Response {
  const error: { code: ErrorCode; message: string; details?: unknown } = {
    code,
    message,
  };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status, headers });
}

const CODE_FOR_HTTP: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  413: "too_large",
};

export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return errorJson(STATUS_FOR[e.code] ?? 500, e.code, e.message, e.details);
  }
  if (isD1QuotaError(e)) {
    return errorJson(
      STATUS_FOR.quota_exceeded,
      "quota_exceeded",
      QUOTA_MESSAGE,
    );
  }
  if (e instanceof OAuthStoreConfigError) return storeMisconfigured(e);
  if (e instanceof HTTPException) {
    return errorJson(
      e.status,
      CODE_FOR_HTTP[e.status] ?? "internal",
      e.message,
    );
  }
  logError("unhandled_error", e);
  return errorJson(STATUS_FOR.internal, "internal", "Internal error");
}

export function appOrigin(env: Pick<Env, "APP_HOST" | "ENVIRONMENT">): string {
  return `${env.ENVIRONMENT === "dev" ? "http" : "https"}://${env.APP_HOST}`;
}

export function contentOrigin(
  env: Pick<Env, "CONTENT_HOST" | "ENVIRONMENT">,
): string {
  return `${env.ENVIRONMENT === "dev" ? "http" : "https"}://${env.CONTENT_HOST}`;
}

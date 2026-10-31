import { API_ERROR_STATUS, type ApiErrorCode } from "@oa/shared/provisioning";

/** A refusal thrown inside invokeRoute (3.5 code); the adapters render it. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A C4 stub reached; streams W4, W5a, W5b, W13a, W13b replace each one. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what}: not implemented`);
    this.name = "NotImplemented";
  }
}

const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });

/** The 3.5 envelope with the code's one status. */
export const errorResponse = (
  code: ApiErrorCode,
  message: string = code,
  details?: unknown,
  headers?: HeadersInit,
) =>
  json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    API_ERROR_STATUS[code],
    headers,
  );

/** The skeleton's 501 body; not an ApiErrorCode, gone once the stubs are. */
export const NOT_IMPLEMENTED_BODY = {
  error: { code: "not_implemented", message: "Not implemented yet." },
} as const;
export const notImplemented = () => json(NOT_IMPLEMENTED_BODY, 501);

/**
 * A protocol route's 405 (9A.3.1) in the 3.5 envelope shape. 3.5 has no 405
 * code, so like the 501 stub it is not an ApiErrorCode; `allow` lists the
 * route's methods.
 */
export const methodNotAllowed = (allow: string) =>
  json(
    { error: { code: "method_not_allowed", message: "Method not allowed." } },
    405,
    { allow },
  );

import { ApiErrorSchema, type ErrorCode } from "@oa/shared";
import type { z } from "zod";
import { EMBED_HEADER, isEmbed } from "../embed";

/** `cpu_limit` is client-only: Cloudflare's error 1102 page, never sent by the API. */
export type ClientErrorCode = ErrorCode | "cpu_limit";

export class ApiClientError extends Error {
  code: ClientErrorCode;
  status: number;
  details?: unknown;
  /** A 429's Retry-After in whole seconds, when the header was there and valid. */
  retryAfter?: number;
  /** Request that failed, when it came from `request`. */
  method?: string;
  path?: string;
  constructor(
    code: ClientErrorCode,
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const internal = (message: string, status: number) =>
  new ApiClientError("internal", message, status);

const CPU_LIMIT_MARKER = "Worker exceeded resource limits";
const CPU_LIMIT_MESSAGE =
  "This request hit Cloudflare's free CPU limit. Retrying generally works.";

let cpuLimitAt: number | null = null;
const cpuListeners = new Set<() => void>();

/** When this tab last got a 1102 from its own instance (ms since epoch), if ever. */
export const lastCpuLimitAt = () => cpuLimitAt;
export const subscribeCpuLimit = (fn: () => void) => {
  cpuListeners.add(fn);
  return () => {
    cpuListeners.delete(fn);
  };
};
export const recordCpuLimit = (at = Date.now()) => {
  cpuLimitAt = at;
  for (const fn of cpuListeners) fn();
};
/** Tests only. */
export const resetCpuLimit = () => {
  cpuLimitAt = null;
};

/**
 * Cloudflare's 1102 page: a 503 HTML body from this origin, not the API's JSON. A
 * cross-origin URL (content host, signed upload elsewhere) is never ours to report.
 */
const isCpuLimit = (
  status: number,
  url: string,
  contentType: string,
  text: string,
) => {
  if (status !== 503 || contentType.includes("json")) return false;
  if (typeof location === "undefined") return false;
  try {
    if (new URL(url || "/", location.href).origin !== location.origin)
      return false;
  } catch {
    return false;
  }
  return text.includes(CPU_LIMIT_MARKER);
};

function toError(
  text: string,
  status: number,
  url = "",
  contentType = "",
): ApiClientError {
  if (isCpuLimit(status, url, contentType, text)) {
    recordCpuLimit();
    return new ApiClientError("cpu_limit", CPU_LIMIT_MESSAGE, status);
  }
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  const parsed = ApiErrorSchema.safeParse(json);
  if (!parsed.success)
    return internal(`Unexpected response (HTTP ${status})`, status);
  const { code, message, details } = parsed.data.error;
  return new ApiClientError(code, message, status, details);
}

/** Per-call extras: more request headers, and a look at a successful response. */
export type RequestExtra = {
  headers?: Record<string, string>;
  onResponse?: (res: Response) => void;
};

/**
 * The fetch options for a request. Framed (embed mode), it is anonymous no
 * matter what the caller asked for: no credentials, plus the embed hint.
 */
export function requestInit(init: RequestInit): RequestInit {
  if (!isEmbed()) return { credentials: "same-origin", ...init };
  const headers = {
    ...Object.fromEntries(new Headers(init.headers)),
    [EMBED_HEADER]: "1",
  };
  return { ...init, headers, credentials: "omit" };
}

async function request(
  path: string,
  init: RequestInit,
  extra?: RequestExtra,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(
      path,
      requestInit({
        ...init,
        ...(extra?.headers
          ? { headers: { ...(init.headers as object), ...extra.headers } }
          : {}),
      }),
    );
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw internal(e instanceof Error ? e.message : "Network error", 0);
  }
  if (res.ok) {
    extra?.onResponse?.(res);
    return res;
  }
  const err = toError(
    await res.text().catch(() => ""),
    res.status,
    res.url || path,
    res.headers.get("content-type") ?? "",
  );
  err.method = init.method;
  err.path = path;
  const ra = res.headers.get("retry-after");
  if (res.status === 429 && ra && /^\d{1,7}$/.test(ra.trim()))
    err.retryAfter = Number(ra);
  throw err;
}

async function parse<T>(
  res: Response,
  schema: z.ZodType<T> | undefined,
): Promise<T> {
  if (!schema || res.status === 204) return undefined as T;
  const out = schema.safeParse(await res.json().catch(() => null));
  if (out.success) return out.data;
  const fields = [
    ...new Set(out.error.issues.map((i) => i.path.join(".") || "(root)")),
  ];
  throw internal(`Invalid response: ${fields.join(", ")}`, res.status);
}

export const api = {
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    extra?: RequestExtra,
  ): Promise<T> {
    return parse(await request(path, { method: "GET", signal }, extra), schema);
  },
  /** Raw body as text (for file contents), with its content type. */
  async getText(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; contentType: string }> {
    const res = await request(path, { method: "GET", signal });
    return {
      text: await res.text(),
      contentType: res.headers.get("content-type") ?? "",
    };
  },
  async send<T = void>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
    signal?: AbortSignal,
    extra?: RequestExtra,
  ): Promise<T> {
    const headers: Record<string, string> = { "X-OA-Request": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await request(
      path,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      },
      extra,
    );
    return parse(res, schema);
  },
  /** Same-origin PUT of a raw body (cookie-authed, so it carries the CSRF header). */
  async putBody(
    path: string,
    body: Blob | string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await request(path, {
      method: "PUT",
      headers: { "X-OA-Request": "1", "Content-Type": contentType },
      body,
      signal,
    });
  },
  /** XHR (not fetch) so upload progress is observable. */
  putRaw(
    url: string,
    body: Blob,
    contentType: string,
    onProgress?: (p: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => new DOMException("Aborted", "AbortError");
      if (signal?.aborted) return reject(abort());
      // A same-origin XHR always carries cookies; a framed shell never uploads.
      if (isEmbed()) return reject(internal("Not available embedded", 0));
      const xhr = new XMLHttpRequest();
      const onAbort = () => {
        xhr.abort();
        reject(abort());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => {
        done();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else
          reject(
            toError(
              xhr.responseText,
              xhr.status,
              xhr.responseURL || url,
              xhr.getResponseHeader("content-type") ?? "",
            ),
          );
      };
      xhr.onerror = () => {
        done();
        reject(internal("Upload failed", 0));
      };
      xhr.send(body);
    });
  },
};

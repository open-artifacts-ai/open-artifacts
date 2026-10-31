import { z } from "zod";
import { safeReturn } from "../auth/safeReturn";

/** Error body from the Provisioning API: `{ error: <code> }`. */
const ErrorBodySchema = z.object({ error: z.string() });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

// TODO(C1): replace with the contract type for GET /api/v1/me.
export const MeSchema = z.object({
  email: z.string(),
  role: z.string(),
  env: z.string(),
  csrf: z.string(),
});
export type Me = z.infer<typeof MeSchema>;

export const SIGN_IN_PATH = "/sign-in";
export const NO_ACCESS_PATH = "/no-access";
/** Auth lives outside /api (design 3.1). */
export const AUTH_START = "/auth/start";
export const AUTH_LOGOUT = "/auth/logout";

export interface ClientOptions {
  /** API prefix; same-origin by default. */
  base?: string;
  fetch?: typeof fetch;
  /** Full-page navigation to an app path. Default: window.location.assign. */
  redirect?: (to: string) => void;
  /** The path to come back to after sign-in. Default: the current location. */
  currentPath?: () => string;
}

const WRITE_METHODS = /^(?!GET$|HEAD$|OPTIONS$)/i;

export function createClient(opts: ClientOptions = {}) {
  const base = (opts.base ?? "/api/v1").replace(/\/+$/, "");
  const doFetch =
    opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const redirect =
    opts.redirect ?? ((to: string) => window.location.assign(to));
  const currentPath =
    opts.currentPath ??
    (() => `${window.location.pathname}${window.location.search}`);
  let csrf: string | null = null;

  const goSignIn = () => {
    const here = currentPath();
    // Already on a signed-out screen: no loop.
    const at = here.split("?")[0];
    if (at === SIGN_IN_PATH || at === NO_ACCESS_PATH) return;
    redirect(`${SIGN_IN_PATH}?return=${encodeURIComponent(safeReturn(here))}`);
  };

  async function request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; root?: boolean } = {},
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (WRITE_METHODS.test(method) && csrf) headers["x-csrf-token"] = csrf;
    const res = await doFetch(`${init.root ? "" : base}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
    const parsed = ErrorBodySchema.safeParse(
      await res.json().catch(() => null),
    );
    const err = new ApiError(
      res.status,
      parsed.success ? parsed.data.error : "unknown",
    );
    if (res.status === 401) goSignIn();
    else if (
      res.status === 403 &&
      err.code === "no_access" &&
      currentPath().split("?")[0] !== NO_ACCESS_PATH
    )
      redirect(NO_ACCESS_PATH);
    throw err;
  }

  /** GET /api/v1/me; keeps the CSRF token for later writes. */
  async function me(): Promise<Me> {
    const body = MeSchema.parse(await request("/me"));
    csrf = body.csrf;
    return body;
  }

  /** POST /auth/logout (204; needs the session and the CSRF token from me). */
  const logout = () =>
    request<void>(AUTH_LOGOUT, { method: "POST", root: true });

  return {
    request,
    logout,
    me,
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "POST", body }),
    put: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "PUT", body }),
    patch: <T>(path: string, body?: unknown) =>
      request<T>(path, { method: "PATCH", body }),
    delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  };
}

export const api = createClient();

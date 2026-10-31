import {
  type Accepted,
  type AuditEntry,
  type InstallDetail,
  type InstallSummary,
  type Job,
  type JobListItem,
  type Me,
  MeSchema,
  ProvisioningErrorSchema,
  type Release,
  ROUTES,
  type RouteId,
  type SlugCheck,
  type Token,
  type World,
} from "@oa/shared/provisioning";
import { safeReturn } from "../auth/safeReturn";

export { type Me, MeSchema } from "@oa/shared/provisioning";

/** A non-2xx answer: the contract envelope `{ error: { code, message, details } }`. */
type Page<T> = { items: T[]; nextCursor: string | null };
type Minted = Token & { token: string };
/** The 2xx body of each route (parsed with the route's schema). */
export interface Results {
  R1: Me;
  R2: Page<InstallSummary>;
  R3: InstallDetail;
  R4: Accepted;
  R5: Accepted;
  R6: Accepted;
  R7: Accepted;
  R8: Accepted;
  R9: Accepted;
  R10: Accepted;
  R11: Accepted;
  R12: Accepted;
  R13: Accepted;
  R14: Page<JobListItem>;
  R15: Job;
  R16: { items: Release[] };
  R17: Page<AuditEntry>;
  R18: SlugCheck;
  R19: Minted;
  R20: { items: Token[] };
  R21: null;
  R25: Accepted;
  R27: World;
}
export type CallId = keyof Results & RouteId;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: unknown,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}

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
    const parsed = ProvisioningErrorSchema.safeParse(
      await res.json().catch(() => null),
    );
    const err = parsed.success
      ? new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        )
      : new ApiError(res.status, "unknown");
    if (res.status === 401) goSignIn();
    throw err;
  }

  /**
   * Call a contract route: the path from the route table, the 2xx body parsed
   * with the route's zod schema.
   */
  async function call<I extends CallId>(
    id: I,
    args: {
      params?: Record<string, string | undefined>;
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<Results[I]> {
    const r = ROUTES[id];
    let path = r.path.replace(/\/:(\w+)(\?)?/g, (_m, name: string) => {
      const v = args.params?.[name];
      return v === undefined ? "" : `/${encodeURIComponent(v)}`;
    });
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args.query ?? {}))
      if (v !== undefined && v !== "") q.set(k, String(v));
    if (q.size) path += `?${q}`;
    const out = await request<unknown>(path, {
      method: r.method,
      body: args.body,
    });
    return r.response.parse(out ?? null) as Results[I];
  }

  /** GET /api/v1/me; keeps the CSRF token for later writes. */
  async function me(): Promise<Me> {
    let raw: unknown;
    try {
      raw = await request("/me");
    } catch (e) {
      // Not an admin for this panel: the no-access screen (not from there).
      if (
        e instanceof ApiError &&
        e.status === 403 &&
        currentPath().split("?")[0] !== NO_ACCESS_PATH
      )
        redirect(NO_ACCESS_PATH);
      throw e;
    }
    const body = MeSchema.parse(raw);
    csrf = body.csrf;
    return body;
  }

  /** POST /auth/logout (204; needs the session and the CSRF token from me). */
  const logout = () =>
    request<void>(AUTH_LOGOUT, { method: "POST", root: true });

  return {
    request,
    call,
    redirect,
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

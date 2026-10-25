import { R } from "@oa/shared";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "./client";
import { qk } from "./queries";

/** No retries for client errors (4xx) or quota exhaustion; otherwise at most 2. */
export const shouldRetry = (failureCount: number, error: unknown): boolean => {
  if (
    error instanceof ApiClientError &&
    ((error.status >= 400 && error.status < 500) ||
      error.code === "quota_exceeded")
  )
    return false;
  return failureCount < 2;
};

/** Cache key of the "daily quota exhausted" flag read by QuotaBanner. */
export const QUOTA_KEY = ["quota-exceeded"] as const;

export const makeQueryClient = () => {
  const client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: shouldRetry } },
    queryCache: new QueryCache({
      onError: (e) => reportApiError(client, e),
      onSuccess: () => reportApiSuccess(client),
    }),
    mutationCache: new MutationCache({
      onError: (e) => reportApiError(client, e),
    }),
  });
  return client;
};

const MAPPINGS = /^\/api\/v1\/spaces\/[^/]+\/mappings(\/|$)/;

/** Admin-only endpoints: they answer 404 once the caller is no longer an admin. */
const roleGated = (e: ApiClientError) => {
  const p = e.path?.split("?")[0] ?? "";
  return (
    p === R.members ||
    p.startsWith(`${R.members}/`) ||
    p === R.usage ||
    (p === R.settings && e.method === "PATCH") ||
    p === R.directory ||
    p.startsWith(`${R.directory}/`) ||
    MAPPINGS.test(p) ||
    p === R.audit ||
    p.startsWith(`${R.audit}/`)
  );
};

const isBreakGlass = (e: unknown) =>
  e instanceof ApiClientError && e.code === "break_glass_required";

/**
 * Raises the quota flag on `quota_exceeded`, and refreshes `/me` on a 404 from
 * a role-gated endpoint. A 401 anywhere means the session is
 * gone: `/me` is marked failed with it, so `useMe` turns anonymous and the
 * sign-in redirects run without refetching a `/me` that may still be cached.
 * Except `reauth_required`: the session is valid, only the directory's
 * break-glass routes want a fresh Google sign-in; and `break_glass_required`
 * (GET /me only), which `useMe` turns into the break-glass card: a 401
 * never overwrites that answer, and one before /me's first answer waits for it.
 */
export const reportApiError = (client: QueryClient, error: unknown) => {
  if (!(error instanceof ApiClientError)) return;
  if (error.code === "quota_exceeded") client.setQueryData(QUOTA_KEY, true);
  // A demoted admin's role-gated calls 404: refresh /me so Gate and the nav follow.
  if (error.status === 404 && roleGated(error))
    void client.invalidateQueries({ queryKey: qk.me, exact: true });
  if (
    error.status !== 401 ||
    error.code === "reauth_required" ||
    error.code === "break_glass_required"
  )
    return;
  const me = client.getQueryCache().find({ queryKey: qk.me, exact: true });
  if (!me || me.state.error === error) return;
  // The locked-out owner gets a plain 401 from everything but /me.
  const markFailed = () => {
    if (isBreakGlass(me.state.error)) return;
    // An in-flight /me must not land afterwards and undo this.
    void client.cancelQueries({ queryKey: qk.me, exact: true }).then(() =>
      me.setState({
        status: "error",
        error,
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
      }),
    );
  };
  if (me.state.data === undefined && me.state.fetchStatus === "fetching")
    void me
      .fetch()
      .catch(() => {})
      .then(markFailed);
  else markFailed();
};

/** Any success means the quota is available again. */
export const reportApiSuccess = (client: QueryClient) => {
  if (client.getQueryData(QUOTA_KEY)) client.setQueryData(QUOTA_KEY, false);
};

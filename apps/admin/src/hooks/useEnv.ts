import { authorize, type Me, type RouteId } from "@oa/shared/provisioning";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** The signed-in admin's /me (one cached query, shared with the shell). */
export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

/** "prod" or "staging", from the same /me answer the sidebar badge reads. */
export const useEnv = () => useMe().data?.env;

/**
 * Whether this /me may call `route`, from the shared authz table (the API's
 * own check), so the panel hides what the server would refuse (#1074).
 */
export const canCall = (route: RouteId, me: Me | undefined) =>
  !!me &&
  authorize(route, { kind: me.principal, scopes: me.scopes }, me.env).ok;

/** canCall for the signed-in session; false until /me loads. */
export const useCan = (route: RouteId) => canCall(route, useMe().data);

/**
 * Whether R2's `q` may match owner email for this /me. Mirrors piiPrincipal
 * in apps/provisioning/src/routes/reads.ts: an admin, or a token with
 * installs:pii (the test admin never is).
 */
export const canSeePii = (me: Me | undefined) =>
  me?.principal === "admin" ||
  (me?.principal === "token" && me.scopes.includes("installs:pii"));

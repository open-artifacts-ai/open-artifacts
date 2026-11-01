import { Button } from "@oa/ui/shadcn";
import { AUTH_START } from "../api/client";
import { safeReturn } from "../auth/safeReturn";
import { EdgePanel } from "../layout/Edge";

export type SignInError = "expired" | "denied" | "no_access" | "rate_limited";

const ERRORS: Record<SignInError, string> = {
  expired: "Sign-in took too long. Try again.",
  denied: "Google did not let you in. Try again, or use another account.",
  no_access:
    "This Google account does not have admin access. Ask an admin to add it, or use another account.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
};

export const parseSignInError = (raw: unknown): SignInError | undefined =>
  typeof raw === "string" && Object.hasOwn(ERRORS, raw)
    ? (raw as SignInError)
    : undefined;

/** GET /auth/start?return= (design 3.1; the broker always asks Google to select an account). */
export const startHref = (ret: unknown) =>
  `${AUTH_START}?return=${encodeURIComponent(safeReturn(ret))}`;

export function SignIn({
  error,
  returnTo,
}: {
  error?: unknown;
  returnTo?: unknown;
}) {
  const known = parseSignInError(error);
  const href = startHref(returnTo);
  return (
    <EdgePanel>
      <h1>Open Artifacts Admin</h1>
      <p>Sign in with the Google account an admin added for you.</p>
      {known && (
        <p className="oa-error" role="alert">
          {ERRORS[known]}
        </p>
      )}
      <div className="oa-acts">
        <Button asChild>
          <a href={href}>Sign in with Google</a>
        </Button>
      </div>
      {known && (
        <p className="oa-cfoot">
          <a href={href}>Use another account?</a>
        </p>
      )}
    </EdgePanel>
  );
}

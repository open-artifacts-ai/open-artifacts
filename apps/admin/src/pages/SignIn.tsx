import { Button } from "@oa/ui/shadcn";
import { api } from "../api/client";
import { safeNext } from "../auth/safeNext";
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

// TODO(C1): confirm the sign-in start path.
export const SIGN_IN_START = "/v1/auth/google/start";

// TODO(C1): confirm the sign-out path and the prompt parameter.
export const SIGN_OUT = "/auth/sign-out";
export const SWITCH_ACCOUNT_HREF = `${SIGN_IN_START}?next=%2F&prompt=select_account`;

/** Signs out first (the server session survives otherwise), then Google's account chooser. */
export function UseAnotherAccount() {
  const go = async () => {
    try {
      await api.post(SIGN_OUT);
    } catch {
      // Still send them to the chooser; a stale session is replaced on sign-in.
    }
    window.location.assign(SWITCH_ACCOUNT_HREF);
  };
  return (
    <button type="button" className="oa-link" onClick={go}>
      Use another account?
    </button>
  );
}

export function SignIn({ error, next }: { error?: unknown; next?: unknown }) {
  const known = parseSignInError(error);
  const href = `${SIGN_IN_START}?next=${encodeURIComponent(safeNext(next))}`;
  return (
    <EdgePanel>
      <h1>Open Artifacts Admin</h1>
      <p>Sign in with the Google account an admin added for you.</p>
      {known && (
        <p className="oa-error" role="alert">
          {ERRORS[known]}
        </p>
      )}
      <Button asChild>
        <a href={href}>Sign in with Google</a>
      </Button>
      {known && (
        <p style={{ marginTop: 16 }}>
          <UseAnotherAccount />
        </p>
      )}
    </EdgePanel>
  );
}

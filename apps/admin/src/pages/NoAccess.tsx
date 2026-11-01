import { Button } from "@oa/ui/shadcn";
import { api } from "../api/client";
import { DEFAULT_RETURN } from "../auth/safeReturn";
import { signOut } from "../auth/signOut";
import { EdgePanel } from "../layout/Edge";
import { startHref } from "./SignIn";

// The callback (R23) redirects here with ?error=unknown_sub&sub=<id> or ?error=not_listed (design 3.4).
const COPY: Record<string, string> = {
  unknown_sub:
    "This email is already on the admin list under a different Google account. Ask an admin to check it.",
  not_listed: "This account isn't a platform admin.",
};
const FALLBACK = "This account isn't a platform admin.";

/** A signed-in admin may land here; end that session before the account chooser. */
async function useAnother() {
  const to = startHref(DEFAULT_RETURN);
  try {
    await api.me();
  } catch {
    // No session (the usual case): nothing to end.
    window.location.assign(to);
    return;
  }
  await signOut(to);
}

export function NoAccess({ error, sub }: { error?: string; sub?: string }) {
  const copy = (error && Object.hasOwn(COPY, error) && COPY[error]) || FALLBACK;
  return (
    <EdgePanel>
      <h1>No access</h1>
      <p role="alert">{copy}</p>
      {error === "unknown_sub" && sub && (
        <p>
          Account id: <code>{sub}</code>
        </p>
      )}
      <div className="oa-acts">
        <Button onClick={useAnother}>Use another account</Button>
      </div>
    </EdgePanel>
  );
}

import { Button } from "@oa/ui/shadcn";
import { api } from "../api/client";
import { DEFAULT_RETURN } from "../auth/safeReturn";
import { signOut } from "../auth/signOut";
import { CopyButton } from "../components/CopyButton";
import { EdgePanel } from "../layout/Edge";
import { startHref } from "./SignIn";

// The callback (R23) redirects here with ?error=unknown_sub&sub=<id> or ?error=not_listed (design 3.4).
// unknown_sub covers a first sign-in waiting to be linked and an email linked
// to a different Google account (#1026): one message asks to link.
const COPY: Record<string, string> = {
  unknown_sub:
    "Your email is on the admin list. Send an admin the account id below so they can link this Google account.",
  not_listed: "This account isn't a platform admin.",
};
const FALLBACK = "This account isn't a platform admin.";

/** A Google account id as the callback sends it; anything else is not shown. */
const SUB_RE = /^[A-Za-z0-9_-]{1,255}$/;

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
  const linking = error === "unknown_sub";
  return (
    <EdgePanel>
      <h1>{linking ? "No access yet" : "No access"}</h1>
      <p role="alert">{copy}</p>
      {linking && sub && SUB_RE.test(sub) && (
        <div className="oa-idrow">
          <span className="oa-idrow-k">Account id</span>
          <code className="oa-mono">{sub}</code>
          <CopyButton text={sub} ariaLabel="Copy account id" />
        </div>
      )}
      <div className="oa-acts">
        <Button variant="outline" size="lg" onClick={useAnother}>
          Use another account
        </Button>
      </div>
    </EdgePanel>
  );
}

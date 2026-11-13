import { AUTH } from "@oa/shared";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuthProviders } from "../api/auth";
import { SIGN_IN_PAGE } from "../api/contract";
import { useSignOut } from "../auth/signOut";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { EdgePanel, SignedInAs } from "./Edge";

export function NoAccess() {
  useDocumentTitle("No access");
  const signOut = useSignOut();
  const navigate = useNavigate();
  const providers = useAuthProviders();
  // Hosted direct mode never lands here: every refusal is /sign-in?error=.
  const hosted = providers.data?.mode === "direct";
  useEffect(() => {
    if (!hosted) return;
    void navigate({
      to: SIGN_IN_PAGE as string,
      search: { error: "no_access" },
      replace: true,
    });
  }, [hosted, navigate]);
  if (hosted) return null;
  return (
    <EdgePanel>
      <h1>You're logged in, but there's nothing here for you yet</h1>
      <p>
        This account isn't a member of this instance, and no artifacts have been
        shared with it.
      </p>
      <p>
        If you expected access, ask the person who sent you the link to share it
        with this email, or ask an admin to invite you.
      </p>
      <SignedInAs />
      <div className="oa-actions">
        <a className="oa-btn oa-primary" href={AUTH.login}>
          Log in as someone else
        </a>
        <button type="button" className="oa-btn" onClick={signOut}>
          Log out
        </button>
      </div>
    </EdgePanel>
  );
}

import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { EdgePanel } from "../layout/Edge";
import { SIGN_IN_START } from "./SignIn";

export function NoAccess({ email }: { email?: string }) {
  // Not the redirecting path: a 403 here is the expected state.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    enabled: email === undefined,
  });
  const shown = email ?? me.data?.email;
  return (
    <EdgePanel>
      <h1>No access</h1>
      {shown && <p>Signed in as {shown}. This account is not an admin here.</p>}
      <p>
        <a className="oa-link" href={`${SIGN_IN_START}?next=%2F`}>
          Use another account?
        </a>
      </p>
    </EdgePanel>
  );
}

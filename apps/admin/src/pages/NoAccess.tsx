import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { EdgePanel } from "../layout/Edge";
import { UseAnotherAccount } from "./SignIn";

export function NoAccess({ email }: { email?: string }) {
  // A 403 no_access here is the expected state; the client does not redirect from /no-access.
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
      {shown ? (
        <p>Signed in as {shown}. This account is not an admin here.</p>
      ) : (
        <p>This account is not an admin here.</p>
      )}
      <p>
        <UseAnotherAccount />
      </p>
    </EdgePanel>
  );
}

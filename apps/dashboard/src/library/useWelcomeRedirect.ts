// #2287: the first time the owner lands on the Library with a Welcome artifact
// the server seeded, open it instead, once. A deleted or unreadable Welcome
// (the server may also have cleared welcomeId) breaks nothing: the Library stays.
import { ArtifactSummarySchema, R } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { api } from "../api/client";
import { qk, useOnboarding, useSetOnboarding } from "../api/queries";
import { useMe } from "../auth/useMe";

/** Ids already handled in this page load, whatever the server says: never twice. */
const handled = new Set<string>();

export function useWelcomeRedirect(enabled: boolean) {
  const state = useMe();
  const owner = state.status === "authed" && state.me.user.role === "owner";
  const onboarding = useOnboarding(enabled && owner);
  const { mutate: save } = useSetOnboarding();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const o = onboarding.data;
  const welcomeId = o?.welcomeId;
  const unopened = o?.welcomeOpened === false;
  useEffect(() => {
    if (!enabled || !owner || !welcomeId || !unopened) return;
    if (handled.has(welcomeId)) return;
    handled.add(welcomeId);
    // Asked for once, whether or not the page opens: a missing one is not retried.
    save({ welcomeOpened: true });
    qc.fetchQuery({
      queryKey: qk.artifact(welcomeId),
      queryFn: ({ signal }) =>
        api.get(R.artifact(welcomeId), ArtifactSummarySchema, signal),
      staleTime: 0,
    }).then(
      (a) => {
        // Only if they are still on the Library: never pull them off a page
        // they opened while this was loading.
        if (a.deletedAt === null && router.state.location.pathname === "/")
          void navigate({ to: "/a/$id", params: { id: welcomeId } });
      },
      () => {},
    );
  }, [enabled, owner, welcomeId, unopened, save, qc, navigate, router]);
}

/** Test hook: forget what was handled. */
export const resetWelcomeRedirect = () => handled.clear();

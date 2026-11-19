/**
 * #2577: the teammates the caller can name for "listens to". Owners and admins
 * read the member list. Anyone else has no list route (R.members is managers
 * only), so they get the people already known to them here: who asked their
 * agents lately, and who is on their list.
 */
import { useMemo } from "react";
import { useAskHistory, useListens } from "../api/agentAsks";
import { useMembers } from "../api/queries";
import { useMe } from "../auth/useMe";
import { personName } from "../layout/person";
import { isOrgAdmin } from "./spaces/access";

export type Teammate = { id: string; name: string; email?: string };

export function useTeammates(): {
  people: Teammate[];
  /** The whole team (a manager), not only people already known. */
  full: boolean;
  loading: boolean;
} {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const admin = isOrgAdmin(me);
  const members = useMembers(undefined, admin);
  // Managers read the member list; everyone else falls back to who is already known.
  const history = useAskHistory(!admin);
  const listens = useListens(!admin);
  return useMemo(() => {
    if (admin) {
      const people = (members.data ?? [])
        .filter(
          (m) =>
            m.role !== "guest" &&
            (m.status ?? "active") === "active" &&
            m.id !== me?.user.id,
        )
        .map((m) => ({ id: m.id, name: personName(m), email: m.email }));
      return { people, full: true, loading: members.isPending };
    }
    const seen = new Map<string, Teammate>();
    for (const e of listens.data?.entries ?? [])
      seen.set(e.member.id, { id: e.member.id, name: e.member.name });
    for (const r of history.data?.rows ?? [])
      if (!seen.has(r.asker.id))
        seen.set(r.asker.id, { id: r.asker.id, name: r.asker.name });
    return {
      people: [...seen.values()],
      full: false,
      loading: history.isPending || listens.isPending,
    };
  }, [
    admin,
    members.data,
    members.isPending,
    history.data,
    history.isPending,
    listens.data,
    listens.isPending,
    me?.user.id,
  ]);
}

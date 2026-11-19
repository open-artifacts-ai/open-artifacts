/**
 * #2577: the teammates the caller can name for "listens to". The team's members
 * from GET /me/teammates (PROVISIONAL (#2577 s2)) for anyone. An older server
 * answers 404; then owners and admins read the member list, and everyone else
 * gets the people already known to them (recent askers, their list).
 */
import { useMemo } from "react";
import { useAskHistory, useListens } from "../api/agentAsks";
import { useMembers } from "../api/queries";
import { useMyTeammates } from "../api/teammates";
import { useMe } from "../auth/useMe";
import { personName } from "../layout/person";
import { isOrgAdmin } from "./spaces/access";

export type Teammate = { id: string; name: string; initials?: string };

export function useTeammates(): {
  people: Teammate[];
  /** The whole team, not only people already known. */
  full: boolean;
  loading: boolean;
} {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const admin = isOrgAdmin(me);
  const mine = useMyTeammates();
  const fallback = mine.isError;
  const members = useMembers(undefined, fallback && admin);
  const history = useAskHistory(fallback && !admin);
  const listens = useListens(fallback && !admin);
  return useMemo(() => {
    if (mine.data)
      return { people: mine.data.members, full: true, loading: false };
    if (!fallback) return { people: [], full: false, loading: true };
    if (admin) {
      const people = (members.data ?? [])
        .filter(
          (m) =>
            m.role !== "guest" &&
            (m.status ?? "active") === "active" &&
            m.id !== me?.user.id,
        )
        .map((m) => ({ id: m.id, name: personName(m) }));
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
    mine.data,
    fallback,
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

import type { PresenceEntry, PresenceFrame } from "@oa/shared";
import { useCallback, useState } from "react";

/**
 * The roster of other viewers, fed by `useLiveVersions`' `onPresence`. `you`
 * (the caller's own key, from hello) is dropped; order is the server's.
 * `total` counts OTHERS: the server's total includes the caller, so one is
 * subtracted only when `you` is among the viewers (the 100-entry cap can cut
 * the caller's own face, and then the server's total already excludes it). A
 * gone artifact sends an empty frame, which clears it. `onPresence` is
 * stable: the events socket's connect effect must not see it change.
 */
export function usePresence() {
  const [state, setState] = useState<{
    others: PresenceEntry[];
    total: number;
  }>({ others: [], total: 0 });
  const onPresence = useCallback((f: PresenceFrame, you?: string) => {
    const others = f.viewers.filter((v) => v.key !== you);
    const selfIn = others.length !== f.viewers.length;
    setState({ others, total: Math.max(0, f.total - (selfIn ? 1 : 0)) });
  }, []);
  return { ...state, onPresence };
}

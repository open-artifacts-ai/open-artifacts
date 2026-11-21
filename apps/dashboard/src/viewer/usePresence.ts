import type { PresenceEntry, PresenceFrame } from "@oa/shared";
import { useCallback, useState } from "react";

/**
 * The roster of other viewers, fed by `useLiveVersions`' `onPresence`. `you`
 * (the caller's own key, from hello) is dropped; order is the server's.
 * `total` counts OTHERS: the server's total is taken over all entries before
 * the list cap, so it always includes the caller (even when the cap cuts the
 * caller's face from `viewers`). When `you` is known, one is subtracted. A
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
    setState({
      others,
      total: Math.max(0, f.total - (you !== undefined ? 1 : 0)),
    });
  }, []);
  return { ...state, onPresence };
}

import type { PresenceEntry, PresenceFrame } from "@oa/shared";
import { useCallback, useState } from "react";

/**
 * The roster of other viewers, fed by `useLiveVersions`' `onPresence`. `you`
 * (the caller's own key, from hello) is dropped; order is the server's. A
 * gone artifact sends an empty frame, which clears it. `onPresence` is
 * stable: the events socket's connect effect must not see it change.
 */
export function usePresence() {
  const [state, setState] = useState<{
    others: PresenceEntry[];
    total: number;
  }>({ others: [], total: 0 });
  const onPresence = useCallback((f: PresenceFrame, you?: string) => {
    setState({
      others: f.viewers.filter((v) => v.key !== you),
      total: f.total,
    });
  }, []);
  return { ...state, onPresence };
}

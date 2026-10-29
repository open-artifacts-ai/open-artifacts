import type { PresenceEntry, PresenceFrame } from "@oa/shared";
import { useCallback, useState } from "react";

type Roster = { others: PresenceEntry[]; total: number };
const EMPTY: Roster = { others: [], total: 0 };

/**
 * The viewers of this artifact other than you, most recent arrival first.
 * `onPresence` is stable: pass it to useLiveVersions. An empty frame (what a
 * gone sends) clears it. Holds only the opaque keys the server sends.
 */
export function usePresence() {
  const [roster, setRoster] = useState<Roster>(EMPTY);
  const onPresence = useCallback(
    (f: PresenceFrame, you: string | undefined) =>
      setRoster({
        others: f.viewers.filter((v) => v.key !== you),
        total: f.total,
      }),
    [],
  );
  return { others: roster.others, total: roster.total, onPresence };
}

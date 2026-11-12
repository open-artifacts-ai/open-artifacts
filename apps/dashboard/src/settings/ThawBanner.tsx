import type { Me } from "@oa/shared";
import { useState } from "react";
import { Notice } from "../layout/Notice";
import { shownDirectoryMode } from "../layout/SyncBanner";
import { THAW_COPY } from "../layout/thawCopy";

const THAW_KEY = "oa.thawNotice.dismissed";
const readThaw = () => {
  try {
    return localStorage.getItem(THAW_KEY);
  } catch {
    return null;
  }
};

/**
 * #2150: on Members, once after a Team to Business thaw put roles back, for
 * owners and admins. Dismissal is kept per thaw (the server's lastThaw.id) in
 * this browser, like the health banner's: no server state or migration, and
 * a new thaw has a new id, so it shows again.
 */
export function ThawBanner({ me }: { me: Me | null }) {
  const [dismissed, setDismissed] = useState(readThaw);
  const role = me?.user.role;
  const t = me?.instance.directory?.lastThaw;
  if (
    !t ||
    t.reverted < 1 ||
    t.names.length < 1 ||
    (role !== "owner" && role !== "admin") ||
    shownDirectoryMode(me) !== "google" ||
    dismissed === t.id
  )
    return null;
  const dismiss = () => {
    try {
      localStorage.setItem(THAW_KEY, t.id);
    } catch {}
    setDismissed(t.id);
  };
  return (
    <Notice tone="info" onDismiss={dismiss}>
      <p>{THAW_COPY.banner(t.names, t.reverted)}</p>
    </Notice>
  );
}

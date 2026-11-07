// The upgrade notice's rules, pure: whether the banner shows, which variant,
// and how it is dismissed. No React and no clock of its own: `now` and the
// store come from the caller, so every rule is testable with a pinned clock.
// (#1628, spec of OA Product 2026-11-07.)
import type { InstanceUpdate } from "@oa/shared";

export type NoticeVariant = "normal" | "breaking" | "custom";
/** x: dismissed for this version for good; remind: hidden for 24 hours. */
export type DismissMode = "x" | "remind";
export type UpgradeNotice =
  | { show: false }
  | { show: true; variant: NoticeVariant; dismiss: DismissMode };

/** The part of localStorage the notice uses. */
export type DismissStore = Pick<Storage, "getItem" | "setItem">;

const DAY = 86_400_000;
/** A release older than this (or a breaking one) can't be dismissed for good. */
export const STALE_AFTER_MS = 14 * DAY;
export const REMIND_MS = DAY;

const dismissedKey = (version: string) => `oa.upgrade.dismissed.${version}`;
const remindKey = (version: string) => `oa.upgrade.remind.${version}`;

type Semver = [number, number, number];
const BASE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\d.])/;
/** [major, minor, patch] from the start of a version; the prerelease or build part is ignored. */
const baseOf = (version: string): Semver | null => {
  const m = BASE.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const older = (a: Semver, b: Semver) => {
  for (let i = 0; i < 3; i++)
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  return false;
};

/** Breaking, or the latest release is over 14 days old: the X becomes "Remind me tomorrow". */
const sticky = (u: InstanceUpdate, now: number) => {
  if (u.breaking === true) return true;
  const at = u.latestPublishedAt ? Date.parse(u.latestPublishedAt) : Number.NaN;
  return Number.isFinite(at) && now - at > STALE_AFTER_MS;
};

/**
 * What the banner does for this update. Hidden for no update, an up-to-date
 * build, a custom build whose base X.Y.Z isn't older than the latest release
 * (the prerelease part is stripped, so dev builds of the newest version stay
 * quiet), and a dismissed notice: an X hides it for that latest version, a
 * remind hides it until the stored time. A newer release brings it back.
 */
export function upgradeNotice(
  update: InstanceUpdate | null | undefined,
  now: number,
  store: DismissStore,
): UpgradeNotice {
  if (!update) return { show: false };
  let variant: NoticeVariant;
  if (update.custom) {
    const cur = baseOf(update.current);
    const latest = baseOf(update.latestVersion);
    if (!cur || !latest || !older(cur, latest)) return { show: false };
    variant = "custom";
  } else {
    if (!update.updateAvailable) return { show: false };
    variant = update.breaking === true ? "breaking" : "normal";
  }
  const dismiss: DismissMode = sticky(update, now) ? "remind" : "x";
  if (dismiss === "x") {
    if (read(store, dismissedKey(update.latestVersion)) !== null)
      return { show: false };
  } else {
    const until = Number(read(store, remindKey(update.latestVersion)));
    // Only a reminder this banner could have set (at most a day ahead): a
    // clock that was wrong once, or junk, never hides it for long.
    if (Number.isFinite(until) && until > now && until - now <= REMIND_MS)
      return { show: false };
  }
  return { show: true, variant, dismiss };
}

/** Record the dismissal the banner's button makes (its mode), for the update's latest version. */
export function dismissNotice(
  update: InstanceUpdate,
  mode: DismissMode,
  now: number,
  store: DismissStore,
) {
  const [key, value] =
    mode === "x"
      ? [dismissedKey(update.latestVersion), "1"]
      : [remindKey(update.latestVersion), String(now + REMIND_MS)];
  try {
    store.setItem(key, value);
  } catch {
    // Storage is full or blocked: hide it for this page session anyway.
    sessionStore.setItem(key, value);
  }
}

const read = (store: DismissStore, key: string) =>
  store.getItem(key) ?? sessionStore.getItem(key);

/** The in-memory stand-in: the notice reads it when the browser's store can't be written. */
const session = new Map<string, string>();
export const sessionStore: DismissStore = {
  getItem: (k) => session.get(k) ?? null,
  setItem: (k, val) => void session.set(k, val),
};

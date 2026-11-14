// Doc versions (#1100): how each version was saved, and the words the
// Versions panel uses for docs. Copy is from the docs mockup (artifact
// 71pjX5mTNuurtJGi v2) unless marked otherwise.
import type { VersionInfo } from "@oa/shared";

export type DocSaveKind = NonNullable<VersionInfo["saveKind"]>;

const RESTORED = /^Restored v\d+$/;

/**
 * How a doc version was saved. The server's `saveKind` when it sends one
 * (PROVISIONAL, #2496); otherwise read from the message: none is an automatic
 * save, "Restored v3" a restore, anything else a name someone gave it.
 */
export function docSaveKind(x: VersionInfo): DocSaveKind {
  if (x.saveKind) return x.saveKind;
  const msg = x.message?.trim();
  if (!msg) return "auto";
  return RESTORED.test(msg) ? "restored" : "named";
}

/** The lead's copy (#1100 task): an automatic version's label. */
export const SAVED_AUTOMATICALLY = "Saved automatically";
/**
 * PENDING (asked of the lead, not in the mockup): the label of the automatic
 * version saved just before an agent's edit. Until it comes, these read as
 * any other automatic version.
 */
export const SAVED_BEFORE_AGENT: string | null = null;

/** The row's title: the name, "Restored v3", or the automatic label. */
export function docVersionLabel(x: VersionInfo): string {
  const kind = docSaveKind(x);
  if (kind === "before_agent") return SAVED_BEFORE_AGENT ?? SAVED_AUTOMATICALLY;
  if (kind === "auto") return SAVED_AUTOMATICALLY;
  return x.message?.trim() ?? "";
}

/** Mockup: the Save version box. */
export const VERSION_NAME_LABEL = "Version name";
export const VERSION_NAME_PLACEHOLDER =
  "Name this version, for example: Before launch";
export const SAVE_VERSION_NOTE = "Keeps the doc as it is now.";
export const SAVE_VERSION = "Save version";
/** Mockup: what the server calls an unnamed save. */
export const defaultVersionName = (n: number) => `Version ${n}`;
/** Mockup: the toast after Save version. */
export const savedToast = (name: string, n: number) =>
  `Saved "${name}" as v${n}.`;
/**
 * PENDING (asked of the lead, not in the mockup): the toast when Save
 * version fails. Until it comes, the server's error message, or this.
 */
export const SAVE_FAILED_FALLBACK = "Couldn't save the version";
/** Mockup: the note under the list. */
export const VERSIONS_NOTE =
  "Pick a version to compare it with the doc as it is now. Restore makes a new version, so nothing is lost.";
/**
 * Mockup: the toast after a restore. Backend's room saves unsaved edits as an
 * automatic version first, then saves the restore as `version`: the doc as it
 * was is always the version just before it.
 */
export const restoredToast = (from: number, version: number) =>
  `Restored v${from}. Nothing is lost: the doc as it was is kept as v${version - 1}.`;

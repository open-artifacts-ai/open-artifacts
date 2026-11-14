// Doc versions (#1100): how each version was saved, and the words the
// Versions panel uses for docs. Copy is from the docs mockup (artifact
// 71pjX5mTNuurtJGi v2), Product, or the lead, as marked.
import type { DocSave, VersionInfo } from "@oa/shared";

export type DocSaveKind = DocSave["kind"];

const RESTORED = /^Restored v\d+$/;

/**
 * How a doc version was saved: Backend's `docSave.kind` when it sends one
 * (PROVISIONAL, the edit_doc PR); otherwise read from the message: none is
 * an automatic save, "Restored v3" a restore, anything else a name.
 */
export function docSaveKind(x: VersionInfo): DocSaveKind {
  if (x.docSave) return x.docSave.kind;
  const msg = x.message?.trim();
  if (!msg) return "auto";
  return RESTORED.test(msg) ? "restore" : "named";
}

/** The lead's copy (#1100 task): an automatic version's label. */
export const SAVED_AUTOMATICALLY = "Saved automatically";
/** Product's copy: the automatic version saved just before an agent edits. */
export const beforeAgent = (agent: string | null | undefined) =>
  agent ? `Before ${agent} edited` : "Before an agent edited";

/** The agent named in a before_agent marker, if any (an AgentRef has `version`). */
const agentOf = (x: VersionInfo): string | null => {
  const by = x.docSave?.by;
  return by && "version" in by ? by.name : null;
};

/**
 * The row's title: the name, the automatic labels, or for a restore its
 * message ("Restored v3"; PENDING: the lead may give a restore row label).
 */
export function docVersionLabel(x: VersionInfo): string {
  const kind = docSaveKind(x);
  if (kind === "before_agent") return beforeAgent(agentOf(x));
  if (kind === "auto") return SAVED_AUTOMATICALLY;
  return x.message?.trim() ?? "";
}

/** Mockup: the Save version box. */
export const VERSION_NAME_LABEL = "Version name";
export const VERSION_NAME_PLACEHOLDER =
  "Name this version, for example: Before launch";
export const SAVE_VERSION_NOTE = "Keeps the doc as it is now.";
export const SAVE_VERSION = "Save version";
/** Product's copy: the toasts after Save version. */
export const VERSION_SAVED = "Version saved.";
export const SAVE_FAILED = "Couldn't save a version. Try again.";
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

// Text frames the doc room (DocRoom) sends to every socket, besides the binary
// Yjs sync and awareness frames. Errors are { type: "error", code, message }.

/** A version was saved (automatically, or named by someone). */
export type DocSavedFrame = {
  type: "saved";
  version: number;
  /** Set for a named save only. */
  name?: string;
  /** True for an automatic save (no name). */
  auto: boolean;
};

/** An earlier version was restored as a new version. */
export type DocRestoredFrame = {
  type: "restored";
  /** The version whose content was restored. */
  from: number;
  /** The new version the restore created. */
  version: number;
};

export type DocRoomTextFrame = DocSavedFrame | DocRestoredFrame;

// Text frames the doc room (DocRoom) sends to every socket, besides the binary
// Yjs sync and awareness frames. Errors are { type: "error", code, message }.

/** Who made a version or a restore. */
export type DocFrameActor = {
  kind: "person" | "agent";
  /** The user behind a person, or the token owner an agent acts as. */
  userId: string | null;
  /** An agent's display name; null for a person. */
  name: string | null;
};

/** A version was saved (automatically, or named by someone). */
export type DocSavedFrame = {
  type: "saved";
  version: number;
  /** Set for a named save. */
  name?: string;
  /** True for an automatic save (no name). */
  auto: boolean;
  /** The author: whoever saved, or edited last for an automatic save. */
  by: DocFrameActor | null;
};

/** An earlier version was restored as a new version. */
export type DocRestoredFrame = {
  type: "restored";
  /** The version whose content was restored. */
  from: number;
  /** The new version the restore created. */
  version: number;
  by: DocFrameActor | null;
};

export type DocRoomTextFrame = DocSavedFrame | DocRestoredFrame;

import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo } from "react";
import type * as Y from "yjs";
import { colorFor } from "./cursors";
import {
  collabExtensions,
  contentExtensions,
  type DocUser,
} from "./extensions";
import { Toolbar } from "./Toolbar";
import {
  type DocStatus,
  defaultProvider,
  errorCopy,
  type RoomProvider,
  useDocRoom,
} from "./useDocRoom";

export const STATUS_TEXT: Record<DocStatus, string> = {
  connecting: "Connecting…",
  saving: "Saving…",
  saved: "Saved",
  offline: "Offline",
};

export interface DocEditorProps {
  artifactId: string;
  title: string;
  /** artifact.can.edit: read-only viewers get no toolbar and no edits. */
  canEdit: boolean;
  /** The signed-in viewer, or null (signed out). */
  viewer: { name: string | null; email?: string } | null;
  /** Signed-out or guest viewers never see agent details. */
  outsider: boolean;
  /** Reports the saved/saving text for the title bar; null on unmount. */
  onStatus?: (status: DocStatus | null) => void;
  /** A test seam: the provider for a room. */
  makeProvider?: (artifactId: string, ydoc: Y.Doc) => RoomProvider;
}

export function DocEditor(props: DocEditorProps) {
  const { room, status, error } = useDocRoom(
    props.artifactId,
    props.makeProvider ?? defaultProvider,
  );
  const { onStatus } = props;
  useEffect(() => {
    onStatus?.(room ? status : null);
  }, [onStatus, room, status]);
  useEffect(() => () => onStatus?.(null), [onStatus]);
  if (!room) return <div className="oa-doc" aria-busy="true" />;
  return <Loaded {...props} room={room} error={error} />;
}

function Loaded({
  room,
  error,
  title,
  canEdit,
  viewer,
  outsider,
}: DocEditorProps & {
  room: NonNullable<ReturnType<typeof useDocRoom>["room"]>;
  error: string | null;
}) {
  const name = viewer?.name?.trim() || "Guest";
  const user = useMemo<DocUser>(
    () => ({ name, color: colorFor(name), kind: "user" }),
    [name],
  );
  const extensions = useMemo(
    () => [
      ...contentExtensions(),
      ...collabExtensions({
        ydoc: room.ydoc,
        provider: room.provider,
        user,
        outsider,
      }),
    ],
    [room, user, outsider],
  );
  const editor = useEditor(
    {
      extensions,
      editable: canEdit,
      editorProps: {
        attributes: {
          class: "oa-doc-prose",
          "aria-label": title,
          "aria-multiline": "true",
          role: "textbox",
        },
      },
      // The room is the source of truth; no initial content.
      immediatelyRender: false,
    },
    [extensions],
  );
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);
  const message = errorCopy(error);
  return (
    <div className="oa-doc" data-editable={canEdit ? "" : undefined}>
      {canEdit && editor && <Toolbar editor={editor} />}
      {message && (
        <p role="alert" className="oa-doc-error">
          {message}
        </p>
      )}
      <div className="oa-doc-scroll">
        <EditorContent editor={editor} className="oa-doc-page" />
      </div>
    </div>
  );
}

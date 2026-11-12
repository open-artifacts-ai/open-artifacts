import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";
import type * as Y from "yjs";
import { colorFor } from "./cursors";
import {
  collabExtensions,
  contentExtensions,
  type DocUser,
} from "./extensions";
import { clearFresh } from "./fresh";
import { Toolbar } from "./Toolbar";
import { TitleField } from "./TitleField";
import {
  DOC_TOO_LARGE_CODE,
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
  /** Saves a new title as the artifact's title (the rename path). */
  onRename?: (title: string) => void;
  /** Made by New doc a moment ago: open with the title selected. */
  fresh?: boolean;
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
    // The state belongs to editing: a read-only viewer has nothing to save.
    onStatus?.(room && props.canEdit ? status : null);
  }, [onStatus, room, status, props.canEdit]);
  useEffect(() => () => onStatus?.(null), [onStatus]);
  if (!room) return <div className="oa-doc" aria-busy="true" />;
  return <Loaded {...props} room={room} error={error} status={status} />;
}

function Loaded({
  room,
  error,
  status,
  artifactId,
  title,
  canEdit,
  viewer,
  outsider,
  onRename,
  fresh = false,
}: DocEditorProps & {
  room: NonNullable<ReturnType<typeof useDocRoom>["room"]>;
  error: string | null;
  status: DocStatus;
}) {
  const name = viewer?.name?.trim() || "Guest";
  const user = useMemo<DocUser>(
    () => ({ name, color: colorFor(name), kind: "user" }),
    [name],
  );
  const page = useRef<HTMLDivElement>(null);
  // At the size limit the server refuses edits: read-only until it is under.
  const tooLarge = error === DOC_TOO_LARGE_CODE;
  const editable = canEdit && !tooLarge;
  const extensions = useMemo(
    () => [
      ...contentExtensions(),
      ...collabExtensions({
        ydoc: room.ydoc,
        provider: room.provider,
        user,
        outsider,
        root: () => page.current,
      }),
    ],
    [room, user, outsider],
  );
  const editor = useEditor(
    {
      extensions,
      editable,
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
    editor?.setEditable(editable);
  }, [editor, editable]);
  // Once the server has said what the doc holds: a new doc puts the cursor in
  // the title (selected), any other doc in the body.
  const titleInput = useRef<HTMLInputElement>(null);
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !editor || !editable || status !== "saved") return;
    placed.current = true;
    if (fresh) {
      titleInput.current?.focus();
      titleInput.current?.select();
      clearFresh(artifactId);
    } else editor.commands.focus("start");
  }, [editor, editable, status, fresh, artifactId]);
  const message = errorCopy(error);
  return (
    <div className="oa-doc" data-editable={editable ? "" : undefined}>
      {editable && editor && <Toolbar editor={editor} />}
      {message && (
        <p role="alert" className="oa-doc-error">
          {message}
        </p>
      )}
      <div className="oa-doc-scroll">
        <div ref={page} className="oa-doc-page">
          <TitleField
            title={title}
            editable={editable}
            onSave={(t) => onRename?.(t)}
            onEnter={() => editor?.commands.focus("start")}
            inputRef={titleInput}
          />
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

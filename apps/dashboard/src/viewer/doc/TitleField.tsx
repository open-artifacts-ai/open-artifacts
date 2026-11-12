import { useEffect, useRef, useState } from "react";

export const TITLE_MAX = 200;
/** What an emptied title saves as. */
export const UNTITLED = "Untitled";
/** A pause in typing this long saves the title. */
export const TITLE_SAVE_MS = 800;

/**
 * The doc's first line: its title, in the editing column at H1 size. Saves
 * through onSave (the artifact's rename, not the Y.Doc) on blur and after a
 * pause in typing; empty saves "Untitled". Enter or Down moves to the body.
 */
export function TitleField({
  title,
  editable,
  onSave,
  onEnter,
  inputRef,
}: {
  title: string;
  editable: boolean;
  onSave: (title: string) => void;
  onEnter: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState(title);
  const saved = useRef(title);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dirty = useRef(false);
  // The artifact's title changes elsewhere (the title bar): follow it unless
  // the cursor is here.
  useEffect(() => {
    saved.current = title;
    if (document.activeElement !== inputRef.current && !dirty.current)
      setValue(title);
  }, [title, inputRef]);

  const save = (text: string) => {
    clearTimeout(timer.current);
    dirty.current = false;
    const next = text.trim().slice(0, TITLE_MAX) || UNTITLED;
    if (next === saved.current) return;
    saved.current = next;
    onSave(next);
  };
  // A pending save still goes out when the field goes away.
  const latest = useRef(value);
  latest.current = value;
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount only.
  useEffect(
    () => () => {
      if (dirty.current) save(latest.current);
      clearTimeout(timer.current);
    },
    [],
  );

  return (
    <input
      ref={inputRef}
      className="oa-doc-title"
      aria-label="Title"
      placeholder={UNTITLED}
      maxLength={TITLE_MAX}
      readOnly={!editable}
      spellCheck={false}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        dirty.current = true;
        clearTimeout(timer.current);
        const text = e.target.value;
        timer.current = setTimeout(() => save(text), TITLE_SAVE_MS);
      }}
      onBlur={() => dirty.current && save(value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

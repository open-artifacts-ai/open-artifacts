import {
  Button,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  SquareCode,
} from "lucide-react";
import { useEffect, useState } from "react";
import { trackViewportVar, useKeyboardOpen } from "../comments/viewport";
import { LINK_REFUSED, toAllowedHref } from "./extensions";

/** A shortcut as Tiptap binds it: "Mod" is Cmd on a Mac and Ctrl elsewhere. */
type Keys = { mod?: true; alt?: true; shift?: true; key: string };

const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘⌥1" on a Mac, "Ctrl+Alt+1" elsewhere. */
export function shortcutText(k: Keys, mac = isMac()): string {
  const key = k.key.length === 1 ? k.key.toUpperCase() : k.key;
  if (mac)
    return `${k.mod ? "⌘" : ""}${k.alt ? "⌥" : ""}${k.shift ? "⇧" : ""}${key}`;
  return [k.mod && "Ctrl", k.alt && "Alt", k.shift && "Shift", key]
    .filter(Boolean)
    .join("+");
}

/** The aria-keyshortcuts form: "Control+Alt+1" or "Meta+Alt+1". */
export function ariaShortcut(k: Keys, mac = isMac()): string {
  return [
    k.mod && (mac ? "Meta" : "Control"),
    k.alt && "Alt",
    k.shift && "Shift",
    k.key.length === 1 ? k.key.toUpperCase() : k.key,
  ]
    .filter(Boolean)
    .join("+");
}

type Item = {
  id: string;
  label: string;
  /** The key binding Tiptap gives the command (Link's is ours, in LinkButton). */
  keys: Keys;
  icon: LucideIcon;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
};

const chain = (e: Editor) => e.chain().focus();

const ITEMS: Item[] = [
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: `Heading ${level}`,
    keys: { mod: true, alt: true, key: String(level) } as Keys,
    icon: [Heading1, Heading2, Heading3][level - 1],
    active: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => chain(e).toggleHeading({ level }).run(),
  })),
  {
    id: "bold",
    label: "Bold",
    keys: { mod: true, key: "b" },
    icon: Bold,
    active: (e) => e.isActive("bold"),
    run: (e) => chain(e).toggleBold().run(),
  },
  {
    id: "italic",
    label: "Italic",
    keys: { mod: true, key: "i" },
    icon: Italic,
    active: (e) => e.isActive("italic"),
    run: (e) => chain(e).toggleItalic().run(),
  },
];
export const LINK_KEYS: Keys = { mod: true, key: "k" };

const LISTS: Item[] = [
  {
    id: "bullet",
    label: "Bulleted list",
    keys: { mod: true, shift: true, key: "8" },
    icon: List,
    active: (e) => e.isActive("bulletList"),
    run: (e) => chain(e).toggleBulletList().run(),
  },
  {
    id: "ordered",
    label: "Numbered list",
    keys: { mod: true, shift: true, key: "7" },
    icon: ListOrdered,
    active: (e) => e.isActive("orderedList"),
    run: (e) => chain(e).toggleOrderedList().run(),
  },
  {
    id: "task",
    label: "Task list",
    keys: { mod: true, shift: true, key: "9" },
    icon: ListTodo,
    active: (e) => e.isActive("taskList"),
    run: (e) => chain(e).toggleTaskList().run(),
  },
];
const CODE: Item[] = [
  {
    id: "code",
    label: "Inline code",
    keys: { mod: true, key: "e" },
    icon: Code,
    active: (e) => e.isActive("code"),
    run: (e) => chain(e).toggleCode().run(),
  },
  {
    id: "codeBlock",
    label: "Code block",
    keys: { mod: true, alt: true, key: "c" },
    icon: SquareCode,
    active: (e) => e.isActive("codeBlock"),
    run: (e) => chain(e).toggleCodeBlock().run(),
  },
];

/** A tooltip body: the name, then the shortcut. */
function Hint({ label, keys }: { label: string; keys: Keys }) {
  return (
    <>
      {label} <span className="oa-doc-keys">{shortcutText(keys)}</span>
    </>
  );
}

function ToolButton({
  item,
  editor,
  on,
}: {
  item: Item;
  editor: Editor;
  on: boolean;
}) {
  const Icon = item.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={on ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={item.label}
          aria-pressed={on}
          aria-keyshortcuts={ariaShortcut(item.keys)}
          data-tool={item.id}
          // Keep the selection in the editor when the button is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => item.run(editor)}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      {/* Below the button: above, it covers the title and the Comments button. */}
      <TooltipContent side="bottom" sideOffset={4} collisionPadding={8}>
        <Hint label={item.label} keys={item.keys} />
      </TooltipContent>
    </Tooltip>
  );
}

/** The link button: a small inline popover asks for the URL. */
function LinkButton({ editor, on }: { editor: Editor; on: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const show = (next: boolean) => {
    if (next) {
      setValue((editor.getAttributes("link").href as string | undefined) ?? "");
      setError(null);
    }
    setOpen(next);
  };
  // Mod-K opens the popover from the editor.
  useEffect(() => {
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        show(true);
      }
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  });
  const apply = () => {
    if (!value.trim() && on) {
      chain(editor).extendMarkRange("link").unsetLink().run();
      setOpen(false);
      return;
    }
    const href = toAllowedHref(value);
    if (!href) {
      setError(LINK_REFUSED);
      return;
    }
    chain(editor).extendMarkRange("link").setLink({ href }).run();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={show}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverAnchor asChild>
            <Button
              type="button"
              variant={on ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Link"
              aria-pressed={on}
              aria-keyshortcuts={ariaShortcut(LINK_KEYS)}
              aria-haspopup="dialog"
              aria-expanded={open}
              data-tool="link"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => show(!open)}
            >
              <LinkIcon aria-hidden="true" />
            </Button>
          </PopoverAnchor>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4} collisionPadding={8}>
          <Hint label="Link" keys={LINK_KEYS} />
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-72 p-2">
        <form
          className="oa-doc-linkform"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Input
            autoFocus
            type="text"
            inputMode="url"
            aria-label="Link URL"
            placeholder="https://"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "oa-doc-link-error" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" size="sm">
            {on && !value.trim() ? "Remove" : "Apply"}
          </Button>
          {error && (
            <p id="oa-doc-link-error" role="alert" className="oa-doc-linkerr">
              {error}
            </p>
          )}
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** One quiet row under the title bar; scrolls sideways on a phone. */
export function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      on: Object.fromEntries(
        [...ITEMS, ...LISTS, ...CODE].map((i) => [i.id, i.active(e)]),
      ),
      link: e.isActive("link"),
    }),
  });
  // On a phone the toolbar is fixed to the bottom and lifted above the
  // on-screen keyboard: --oa-kb follows the visual viewport (#2276).
  useEffect(() => trackViewportVar(), []);
  const keyboard = useKeyboardOpen();
  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="oa-doc-toolbar"
        data-keyboard={keyboard ? "" : undefined}
        role="toolbar"
        aria-label="Formatting"
        aria-orientation="horizontal"
      >
        {ITEMS.map((i) => (
          <ToolButton
            key={i.id}
            item={i}
            editor={editor}
            on={!!state.on[i.id]}
          />
        ))}
        <LinkButton editor={editor} on={state.link} />
        <span className="oa-doc-sep" aria-hidden="true" />
        {LISTS.map((i) => (
          <ToolButton
            key={i.id}
            item={i}
            editor={editor}
            on={!!state.on[i.id]}
          />
        ))}
        <span className="oa-doc-sep" aria-hidden="true" />
        {CODE.map((i) => (
          <ToolButton
            key={i.id}
            item={i}
            editor={editor}
            on={!!state.on[i.id]}
          />
        ))}
      </div>
    </TooltipProvider>
  );
}

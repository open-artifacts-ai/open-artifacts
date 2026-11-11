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
import { useState } from "react";
import { LINK_REFUSED, toAllowedHref } from "./extensions";

type Item = {
  id: string;
  label: string;
  icon: LucideIcon;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
};

const chain = (e: Editor) => e.chain().focus();

const ITEMS: Item[] = [
  ...([1, 2, 3] as const).map((level) => ({
    id: `h${level}`,
    label: `Heading ${level}`,
    icon: [Heading1, Heading2, Heading3][level - 1],
    active: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => chain(e).toggleHeading({ level }).run(),
  })),
  {
    id: "bold",
    label: "Bold",
    icon: Bold,
    active: (e) => e.isActive("bold"),
    run: (e) => chain(e).toggleBold().run(),
  },
  {
    id: "italic",
    label: "Italic",
    icon: Italic,
    active: (e) => e.isActive("italic"),
    run: (e) => chain(e).toggleItalic().run(),
  },
];
const LISTS: Item[] = [
  {
    id: "bullet",
    label: "Bulleted list",
    icon: List,
    active: (e) => e.isActive("bulletList"),
    run: (e) => chain(e).toggleBulletList().run(),
  },
  {
    id: "ordered",
    label: "Numbered list",
    icon: ListOrdered,
    active: (e) => e.isActive("orderedList"),
    run: (e) => chain(e).toggleOrderedList().run(),
  },
  {
    id: "task",
    label: "Task list",
    icon: ListTodo,
    active: (e) => e.isActive("taskList"),
    run: (e) => chain(e).toggleTaskList().run(),
  },
  {
    id: "code",
    label: "Code",
    icon: Code,
    active: (e) => e.isActive("code"),
    run: (e) => chain(e).toggleCode().run(),
  },
  {
    id: "codeBlock",
    label: "Code block",
    icon: SquareCode,
    active: (e) => e.isActive("codeBlock"),
    run: (e) => chain(e).toggleCodeBlock().run(),
  },
];

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
          data-tool={item.id}
          // Keep the selection in the editor when the button is pressed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => item.run(editor)}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{item.label}</TooltipContent>
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
        <TooltipContent>Link</TooltipContent>
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
        [...ITEMS, ...LISTS].map((i) => [i.id, i.active(e)]),
      ),
      link: e.isActive("link"),
    }),
  });
  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="oa-doc-toolbar"
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
      </div>
    </TooltipProvider>
  );
}

import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";

// The fixed slice-1 content set for collaborative docs (#1100). Node and mark
// names, content expressions and attributes follow Tiptap 3 (StarterKit plus
// TaskList and TaskItem from @tiptap/extension-list), so a Tiptap editor and
// this schema read the same Yjs document. The editor must configure Tiptap to
// match the choices made here; test/tiptap.test.ts pins them. y-prosemirror
// deletes a Yjs element this schema cannot read, so drift loses text:
//
// - StarterKit without underline (not in the content set); hardBreak is in it.
// - Heading levels [1, 2, 3].
// - TaskItem.configure({ nested: true }): task items hold nested blocks, as in
//   GitHub Markdown.
// - Code.extend({ excludes: "" }): inline code keeps its link or bold, so
//   [`api`](https://x) survives a round trip.
//
// No toDOM/parseDOM: this schema renders nowhere and must load in Workers
// without a DOM.

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: { content: "inline*", group: "block" },
  heading: {
    attrs: {
      level: {
        default: 1,
        validate: (value: unknown) => {
          if (value !== 1 && value !== 2 && value !== 3)
            throw new RangeError(`Unsupported heading level ${String(value)}`);
        },
      },
    },
    content: "inline*",
    group: "block",
    defining: true,
  },
  blockquote: { content: "block+", group: "block", defining: true },
  codeBlock: {
    attrs: { language: { default: null, validate: validateLanguage } },
   
    marks: "",
    group: "block",
    code: true,
    defining: true,
  },
  horizontalRule: { group: "block" },
  bulletList: { content: "listItem+", group: "block list" },
  orderedList: {
    attrs: { start: { default: 1, validate: "number" } },
    content: "listItem+",
    group: "block list",
  },
  listItem: { content: "paragraph block*", defining: true },
  taskList: { content: "taskItem+", group: "block list" },
  taskItem: {
    attrs: { checked: { default: false, validate: "boolean" } },
    content: "paragraph block*",
    defining: true,
  },
  text: { group: "inline" },
  // Tiptap's HardBreak (Shift+Enter): an inline line break. Wherever inline
  // content is allowed (paragraphs, headings, so list items and quotes too);
  // never in a code block, where a newline is just text.
  hardBreak: {
    inline: true,
    group: "inline",
    selectable: false,
    linebreakReplacement: true,
  },
};

// Order matters for Markdown output: marks open in this order, so code is
// always innermost.
const ALLOWED_HREF =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
  /^(?:https?|mailto):[^\s\u0000-\u001f\u007f-\u009f<>"`\\]*$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const CONTROL_QUOTE_BACKSLASH = /[\u0000-\u001f\u007f-\u009f"\\]/;

/**
 * Only http:, https: and mailto: links are allowed (scheme is
 * case-insensitive), with no whitespace, control characters or backslash, < > " `.
 */
export function isAllowedHref(href: unknown): href is string {
  return typeof href === "string" && ALLOWED_HREF.test(href);
}

/** A link title is a string without line breaks, control characters, quotes or backslashes. */
export function isAllowedTitle(title: unknown): title is string | null {
  return (
    title === null ||
    (typeof title === "string" && !CONTROL_QUOTE_BACKSLASH.test(title))
  );
}

function validateHref(href: unknown): void {
  if (!isAllowedHref(href)) {
    throw new RangeError("A link must be a plain http:, https: or mailto: URL");
  }
}

function validateTitle(title: unknown): void {
  if (!isAllowedTitle(title)) {
    throw new RangeError(
      "A link title must be text without quotes or line breaks",
    );
  }
}

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

/** A code block language: null, or a short plain name like "ts" or "c++". */
export function isAllowedLanguage(
  language: unknown,
): language is string | null {
  return (
    language === null ||
    (typeof language === "string" && LANGUAGE.test(language))
  );
}

function validateLanguage(language: unknown): void {
  if (!isAllowedLanguage(language)) {
    throw new RangeError("A code block language must be a short plain name");
  }
}

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: {
      href: { validate: validateHref },
      title: { default: null, validate: validateTitle },
    },
    inclusive: false,
  },
  bold: {},
  italic: {},
  strike: {},
  code: { excludes: "code" },
};

export const docSchema = new Schema({ nodes, marks });

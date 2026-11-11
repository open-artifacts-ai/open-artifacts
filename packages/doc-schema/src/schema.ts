import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";

// The fixed slice-1 content set for collaborative docs (#1100). Node and mark
// names, content expressions and attributes follow Tiptap 3 (StarterKit plus
// TaskList and TaskItem from @tiptap/extension-list), so a Tiptap editor and
// this schema read the same Yjs document. The editor must configure Tiptap to
// match the choices made here; test/tiptap.test.ts pins them. y-prosemirror
// deletes a Yjs element this schema cannot read, so drift loses text:
//
// - StarterKit without hardBreak and underline (not in the content set).
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
    attrs: { language: { default: null } },
    content: "text*",
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
};

// Order matters for Markdown output: marks open in this order, so code is
// always innermost.
const ALLOWED_HREF = /^(?:https?|mailto):/i;

/** Only http:, https: and mailto: links are allowed (scheme is case-insensitive). */
export function isAllowedHref(href: unknown): href is string {
  return typeof href === "string" && ALLOWED_HREF.test(href);
}

function validateHref(href: unknown): void {
  if (!isAllowedHref(href)) {
    throw new RangeError("A link must be http:, https: or mailto:");
  }
}

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: { validate: validateHref }, title: { default: null } },
    inclusive: false,
  },
  bold: {},
  italic: {},
  strike: {},
  code: { excludes: "code" },
};

export const docSchema = new Schema({ nodes, marks });

import { isAllowedHref } from "@oa/doc-schema";
import { Extension, type Extensions } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import type { Fragment, Mark } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import type * as Y from "yjs";
import { renderCaret, renderSelection } from "./cursors";

/** The one message for a link the doc would refuse. */
export const LINK_REFUSED =
  "Links must start with http://, https:// or mailto:";

/** isAllowedHref without its type guard, so a false branch keeps `string`. */
const allowed = (s: string): boolean => isAllowedHref(s);

/**
 * Turn what someone typed into a link target, or null if the doc would refuse
 * it. A bare "example.com" gets https://; any other scheme (javascript:, data:,
 * ftp:, ...) is refused, never rewritten.
 */
export function toAllowedHref(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (allowed(text)) return text;
  // "example.com:8080/x" is a host and port, not a scheme.
  const hostPort = /^[^/?#:@]+\.[^/?#:@]+:\d+(?:[/?#]|$)/.test(text);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  if (text.startsWith("/")) return null;
  return /^[^/?#:@]+\.[^/?#:@]+/.test(text) ? `https://${text}` : null;
}

/**
 * Defence in depth: a transaction that would put a link with a disallowed href
 * into the doc (a paste, a command, a bug elsewhere) is dropped, so it can
 * never reach the Y.Doc. Remote changes are never filtered.
 */
const LinkGuard = Extension.create({
  name: "linkGuard",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(tr) {
          if (!tr.docChanged || tr.getMeta("y-sync$")) return true;
          const bad = (marks: readonly Mark[]) =>
            marks.some(
              (m) => m.type.name === "link" && !isAllowedHref(m.attrs.href),
            );
          for (const step of tr.steps as unknown as {
            mark?: Mark;
            slice?: { content: Fragment };
          }[]) {
            // AddMarkStep and AddNodeMarkStep carry a mark ...
            if (step.mark && bad([step.mark])) return false;
            // ... replace steps carry new content with its own marks.
            let found = false;
            step.slice?.content.descendants((node) => {
              if (bad(node.marks)) found = true;
              return !found;
            });
            if (found) return false;
          }
          return true;
        },
      }),
    ];
  },
});

export interface DocUser {
  name: string;
  color: string;
  kind: "user" | "agent";
}

/**
 * The content extensions: exactly the set @oa/doc-schema mirrors (see its
 * test/tiptap.test.ts). Change one and the schema-equality test fails.
 */
export function contentExtensions(): Extensions {
  return [
    StarterKit.configure({
      hardBreak: false,
      underline: false,
      // Collaboration brings its own undo/redo.
      undoRedo: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ["http", "https", "mailto"],
        defaultProtocol: "https",
        validate: (url) => isAllowedHref(url),
        isAllowedUri: (url) => isAllowedHref(url),
        shouldAutoLink: (url) => isAllowedHref(url),
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
      },
    }).extend({
      addExtensions() {
        return (this.parent?.() ?? []).map((ext) => {
          if (ext.name === "code") return ext.extend({ excludes: "" });
          // Only the attributes docSchema has: href and title.
          if (ext.name === "link")
            return ext.extend({
              addAttributes() {
                return { href: { default: null }, title: { default: null } };
              },
            });
          return ext;
        });
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    LinkGuard,
  ];
}

export function collabExtensions(opts: {
  ydoc: Y.Doc;
  // biome-ignore lint/suspicious/noExplicitAny: Tiptap types the provider as any.
  provider: any;
  user: DocUser;
  /** Signed-out or guest viewers never see agent details. */
  outsider: boolean;
}): Extensions {
  return [
    Collaboration.configure({ document: opts.ydoc, field: "default" }),
    CollaborationCaret.configure({
      provider: opts.provider,
      user: opts.user,
      render: (u) => renderCaret(u, opts.outsider),
      selectionRender: (u) => renderSelection(u, opts.outsider),
    }),
  ];
}

import MarkdownIt, { type StateBlock, type Token } from "markdown-it";
import {
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";
import { type DocJSON, toDocNode } from "./json.ts";
import {
  docSchema,
  isAllowedHref,
  isAllowedLanguage,
  isAllowedTitle,
} from "./schema.ts";

/** What a Markdown import changed because the doc cannot hold it. */
export type ImportChangeKind =
  | "html" // raw HTML, block or inline: kept as plain text
  | "table" // a table: each row kept as a plain-text paragraph
  | "image" // an image: kept as its Markdown source in plain text
  | "footnote" // a footnote definition: kept as plain text
  | "heading_level" // a heading 4 to 6: kept as a paragraph
  | "link" // a link that isn't http(s) or mailto:: kept as plain text
  | "code_language" // a code fence info string that isn't a plain language name: dropped
  | "heading_break" // a line break inside a heading: became a space
  | "mixed_task_list"; // a list with some task items: kept as a bullet list, "[ ]" as text

export interface ImportChange {
  kind: ImportChangeKind;
  /** 1-based line in the Markdown source, when known. */
  line: number | null;
  /** The source text that changed, shortened to 80 characters. */
  text: string;
}

export interface MarkdownImport {
  doc: PMNode;
  json: DocJSON;
  changes: ImportChange[];
}

const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/;
const TASK_PREFIX = /^\[([ xX])\](?:[ \t]+|$)/;

function short(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
}

// A footnote definition ("[^1]: note") would otherwise be read as a link
// reference definition and vanish. Catch it first and keep it as text.
function footnoteDefRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const line = state.src.slice(start, state.eMarks[startLine]);
  if (!FOOTNOTE_DEF.test(line)) return false;
  if (silent) return true;
  let next = startLine + 1;
  while (next < endLine) {
    if (state.isEmpty(next)) {
      // A blank line continues the definition only if an indented line follows.
      let after = next + 1;
      while (after < endLine && state.isEmpty(after)) after++;
      if (after < endLine && state.sCount[after] - state.blkIndent >= 4) {
        next = after;
        continue;
      }
      break;
    }
    if (state.sCount[next] - state.blkIndent < 4) break;
    next++;
  }
  const token = state.push("oa_footnote_def", "", 0);
  token.map = [startLine, next];
  token.content = state.getLines(startLine, next, state.blkIndent, false);
  token.block = true;
  state.line = next;
  return true;
}

const md = MarkdownIt("commonmark", { html: true }).enable([
  "strikethrough",
  "table",
]);
// markdown-it silently refuses javascript: and data: links; accept every href
// here so rewriteInline sees it and reports the link it keeps as plain text.
md.validateLink = () => true;
md.block.ruler.before("reference", "oa_footnote_def", footnoteDefRule, {
  alt: ["paragraph", "reference"],
});
const TokenCtor = new md.core.State("", md, {}).Token;

function textToken(content: string, level: number): Token {
  const t = new TokenCtor("text", "", 0);
  t.content = content;
  t.level = level;
  return t;
}

// Plain-text paragraphs, one per non-blank line, at the given block level.
function plainParagraphs(text: string, level: number, map: Token["map"]) {
  const out: Token[] = [];
  for (const raw of text.split("\n")) {
    // Leading spaces would read back as an indented code block.
    const line = raw.trim();
    if (line === "") continue;
    const open = new TokenCtor("paragraph_open", "p", 1);
    open.level = level;
    open.block = true;
    open.map = map;
    const inline = new TokenCtor("inline", "", 0);
    inline.level = level + 1;
    inline.block = true;
    inline.content = line;
    inline.map = map;
    inline.children = [textToken(line, 0)];
    const close = new TokenCtor("paragraph_close", "p", -1);
    close.level = level;
    close.block = true;
    out.push(open, inline, close);
  }
  return out;
}

function lineOf(token: Token): number | null {
  return token.map ? token.map[0] + 1 : null;
}

// The rows of a table as Markdown source lines, cells unparsed.
function tableLines(tokens: Token[], from: number, to: number): string[] {
  const lines: string[] = [];
  let cells: string[] = [];
  const aligns: string[] = [];
  for (let i = from; i <= to; i++) {
    const t = tokens[i];
    if (t.type === "thead_close") lines.push(`| ${aligns.join(" | ")} |`);
    else if (t.type === "tr_open") cells = [];
    else if (t.type === "tr_close") lines.push(`| ${cells.join(" | ")} |`);
    else if (t.type === "th_open" || t.type === "td_open") {
      cells.push(tokens[i + 1]?.type === "inline" ? tokens[i + 1].content : "");
      if (t.type === "th_open") {
        const style = t.attrGet("style") ?? "";
        aligns.push(
          style.includes("center")
            ? ":---:"
            : style.includes("right")
              ? "---:"
              : style.includes("left")
                ? ":---"
                : "---",
        );
      }
    }
  }
  return lines;
}

function rewriteInline(
  inline: Token,
  changes: ImportChange[],
  inHeading: boolean,
): void {
  const children = inline.children;
  if (!children) return;
  const line = lineOf(inline);
  let dropClose = false;
  // A hard break at the very end of a block means nothing: drop it.
  while (children.at(-1)?.type === "hardbreak") children.pop();
  inline.children = children.flatMap((child) => {
    if (child.type === "link_open") {
      const href = child.attrGet("href") ?? "";
      if (
        !isAllowedHref(href) ||
        !isAllowedTitle(child.attrGet("title") ?? null)
      ) {
        changes.push({ kind: "link", line, text: short(href) });
        dropClose = true;
        return [];
      }
    }
    if (child.type === "link_close" && dropClose) {
      dropClose = false;
      return [];
    }
    return [rewriteChild(child)];
  });

  function rewriteChild(child: Token): Token {
    if (child.type === "html_inline") {
      changes.push({ kind: "html", line, text: short(child.content) });
      return textToken(child.content, child.level);
    }
    if (child.type === "image") {
      const src = child.attrGet("src") ?? "";
      const title = child.attrGet("title");
      const source = `![${child.content}](${src}${title ? ` "${title}"` : ""})`;
      changes.push({ kind: "image", line, text: short(source) });
      return textToken(source, child.level);
    }
    // A heading is one line: a break in a (setext) heading becomes a space.
    if (child.type === "hardbreak" && inHeading) {
      changes.push({
        kind: "heading_break",
        line,
        text: short(inline.content),
      });
      return textToken(" ", child.level);
    }
    return child;
  }
}

function matchingClose(tokens: Token[], open: number): number {
  const closeType = tokens[open].type.replace(/_open$/, "_close");
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i].type === closeType && tokens[i].level === tokens[open].level)
      return i;
  }
  return tokens.length - 1;
}

function rewriteBlocks(tokens: Token[], changes: ImportChange[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "html_block") {
      changes.push({ kind: "html", line: lineOf(t), text: short(t.content) });
      out.push(...plainParagraphs(t.content, t.level, t.map));
    } else if (t.type === "oa_footnote_def") {
      changes.push({
        kind: "footnote",
        line: lineOf(t),
        text: short(t.content),
      });
      out.push(...plainParagraphs(t.content, t.level, t.map));
    } else if (
      t.type === "fence" &&
      !isAllowedLanguage(t.info.trim() || null)
    ) {
      changes.push({
        kind: "code_language",
        line: lineOf(t),
        text: short(t.info),
      });
      t.info = "";
      out.push(t);
    } else if (t.type === "table_open") {
      const close = matchingClose(tokens, i);
      const lines = tableLines(tokens, i, close);
      changes.push({
        kind: "table",
        line: lineOf(t),
        text: short(lines[0] ?? ""),
      });
      out.push(...plainParagraphs(lines.join("\n"), t.level, t.map));
      i = close;
    } else if (t.type === "heading_open" && Number(t.tag.slice(1)) > 3) {
      const inline = tokens[i + 1];
      changes.push({
        kind: "heading_level",
        line: lineOf(t),
        text: short(`${t.markup} ${inline?.content ?? ""}`),
      });
      t.type = "paragraph_open";
      t.tag = "p";
      const close = matchingClose(tokens, i);
      tokens[close].type = "paragraph_close";
      tokens[close].tag = "p";
      out.push(t);
    } else {
      if (t.type === "inline")
        rewriteInline(t, changes, tokens[i - 1]?.type === "heading_open");
      out.push(t);
    }
  }
  return out;
}

// GitHub task lists: a bullet list whose every item starts with "[ ]" or
// "[x]" becomes a task list.
function markTaskLists(tokens: Token[], changes: ImportChange[]): void {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "bullet_list_open") continue;
    const close = matchingClose(tokens, i);
    const items: { open: number; close: number; checked: boolean }[] = [];
    let matched = 0;
    for (let k = i + 1; k < close; k++) {
      const item = tokens[k];
      if (item.type !== "list_item_open" || item.level !== tokens[i].level + 1)
        continue;
      const inline = tokens[k + 2];
      const first = inline?.children?.[0];
      // Match the source, not the text: "\[ \] x" is an escaped plain item.
      const m =
        tokens[k + 1]?.type === "paragraph_open" &&
        first?.type === "text" &&
        TASK_PREFIX.test(first.content)
          ? TASK_PREFIX.exec(inline.content)
          : null;
      if (m) matched++;
      items.push({
        open: k,
        close: matchingClose(tokens, k),
        checked: m?.[1] !== " " && !!m,
      });
    }
    if (matched === 0) continue;
    if (matched < items.length) {
      changes.push({
        kind: "mixed_task_list",
        line: lineOf(tokens[i]),
        text: short(tokens[i + 3]?.content ?? ""),
      });
      continue;
    }
    tokens[i].type = "task_list_open";
    tokens[close].type = "task_list_close";
    for (const item of items) {
      tokens[item.open].type = "task_item_open";
      tokens[item.open].meta = { checked: item.checked };
      tokens[item.close].type = "task_item_close";
      const inline = tokens[item.open + 2];
      const first = inline.children?.[0];
      if (first) first.content = first.content.replace(TASK_PREFIX, "");
      inline.content = inline.content.replace(TASK_PREFIX, "");
    }
  }
}

function tokenize(source: string, changes: ImportChange[]): Token[] {
  const tokens = rewriteBlocks(md.parse(source, {}), changes);
  markTaskLists(tokens, changes);
  return tokens;
}

function parserFor(changes: ImportChange[]): MarkdownParser {
  const tokenizer = {
    parse: (source: string) => tokenize(source, changes),
  } as unknown as MarkdownIt;
  return new MarkdownParser(docSchema, tokenizer, {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok) => ({ start: Number(tok.attrGet("start") ?? 1) || 1 }),
    },
    task_list: { block: "taskList" },
    task_item: {
      block: "taskItem",
      getAttrs: (tok) => ({ checked: tok.meta?.checked === true }),
    },
    heading: {
      block: "heading",
      getAttrs: (tok) => ({ level: Number(tok.tag.slice(1)) }),
    },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: tok.info.trim() || null }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: {
      mark: "link",
      getAttrs: (tok) => ({
        href: tok.attrGet("href") ?? "",
        title: tok.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  });
}

/**
 * Markdown to a doc. Anything outside the slice-1 content set becomes plain
 * text, and `changes` lists each such spot.
 */
export function markdownToDoc(source: string): MarkdownImport {
  const changes: ImportChange[] = [];
  // toDocNode rebuilds the doc: a break carries no marks.
  const doc = toDocNode(
    parserFor(changes).parse(source.replace(/\r\n?/g, "\n")),
  );
  return { doc, json: doc.toJSON() as DocJSON, changes };
}

type ListName = "bulletList" | "taskList" | "orderedList";

// Two lists of the same kind in a row would merge on re-import unless their
// markers differ, so alternate the marker.
// Computed once per parent and kind set: each list's place in its run.
const flips = new WeakMap<PMNode, Map<string, boolean[]>>();

function alternate(parent: PMNode, index: number, kinds: ListName[]): boolean {
  let byKinds = flips.get(parent);
  if (!byKinds) {
    byKinds = new Map();
    flips.set(parent, byKinds);
  }
  const key = kinds.join(",");
  let list = byKinds.get(key);
  if (!list) {
    list = [];
    let flip = false;
    for (let i = 0; i < parent.childCount; i++) {
      flip = kinds.includes(parent.child(i).type.name as ListName)
        ? !flip
        : false;
      // flip is now whether list i is an odd step after the run's start.
      list.push(flip);
    }
    byKinds.set(key, list);
  }
  // Run start: flip=true after the first list means index 0 of run is false.
  return index > 0 ? (list[index - 1] ?? false) : false;
}

const BULLETS: ListName[] = ["bulletList", "taskList"];

function renderBulletLike(
  state: MarkdownSerializerState,
  node: PMNode,
  parent: PMNode,
  index: number,
) {
  const bullet = alternate(parent, index, BULLETS) ? "*" : "-";
  state.renderList(node, "  ", () => `${bullet} `);
}

const marks = defaultMarkdownSerializer.marks;

const serializer = new MarkdownSerializer(
  {
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${state.repeat("#", node.attrs.level)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    codeBlock(state, node) {
      const runs = node.textContent.match(/`{3,}/g);
      const fence = runs
        ? `${runs.reduce((a, b) => (b.length > a.length ? b : a))}\``
        : "```";
      state.write(`${fence}${node.attrs.language ?? ""}\n`);
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    horizontalRule(state, node) {
      state.write("---");
      state.closeBlock(node);
    },
    bulletList: renderBulletLike,
    taskList: renderBulletLike,
    orderedList(state, node, parent, index) {
      const delim = alternate(parent, index, ["orderedList"]) ? ")" : ".";
      const start: number = node.attrs.start ?? 1;
      const width = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", width + 2);
      state.renderList(node, space, (i) => {
        const n = String(start + i);
        return `${state.repeat(" ", width - n.length)}${n}${delim} `;
      });
    },
    listItem(state, node) {
      state.renderContent(node);
    },
    taskItem(state, node) {
      state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    hardBreak(state, node, parent, index) {
      // A break at the end of a block is dropped.
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state, node, parent, index) {
      const text = node.text ?? "";
      const next =
        index + 1 < parent.childCount ? parent.child(index + 1) : null;
      const link = docSchema.marks.link;
      // Set by the link mark while writing <https://...>; not in the types.
      const inAutolink = (state as unknown as { inAutolink?: boolean })
        .inAutolink;
      // "!" right before a link would turn the link into an image.
      if (
        text.endsWith("!") &&
        !inAutolink &&
        next &&
        link.isInSet(next.marks) &&
        !link.isInSet(node.marks)
      ) {
        state.text(text.slice(0, -1), true);
        state.text("\\!", false);
        return;
      }
      state.text(text, !inAutolink);
    },
  },
  {
    link: marks.link,
    bold: marks.strong,
    italic: marks.em,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    code: marks.code,
  },
  {
    // tightLists is read at runtime but missing from the option types.
    ...({ tightLists: true } as object),
    // Beyond the default escapes: "<" (raw HTML), "&" before an entity, ")"
    // after a number at the start of text ("1) " starts a list).
    escapeExtraCharacters: /<|&(?=#?[a-zA-Z0-9]+;)|(?<=^\s*\d+)\)/g,
  },
);

/** A doc (node or JSON) to Markdown, ending in one newline unless empty. */
export function docToMarkdown(doc: PMNode | DocJSON): string {
  const node = toDocNode(doc);
  const out = serializer.serialize(node).replace(/\s+$/, "");
  return out === "" ? "" : `${out}\n`;
}

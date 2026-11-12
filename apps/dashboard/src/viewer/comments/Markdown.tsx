import { Fragment, type ReactNode } from "react";
import {
  type Block,
  type Inline,
  parseInlineOnly,
  parseMarkdown,
} from "./mdparse";

/** Renders the safe subset from markdown.ts as React elements. The only elements
    are div, p, strong, em, code, pre, blockquote, ul, ol, li and a (plus whatever
    `text` returns for plain text, e.g. mention chips). Never HTML. */
type TextFn = (s: string, key: string) => ReactNode;

function inline(nodes: Inline[], text: TextFn, key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text":
        return <Fragment key={k}>{text(n.s, k)}</Fragment>;
      case "b":
        return <strong key={k}>{inline(n.c, text, k)}</strong>;
      case "i":
        return <em key={k}>{inline(n.c, text, k)}</em>;
      case "code":
        return (
          <code
            key={k}
            className="rounded bg-muted px-1 font-mono text-[0.9em] [overflow-wrap:anywhere]"
          >
            {n.s}
          </code>
        );
      default:
        return (
          <a
            key={k}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline [overflow-wrap:anywhere]"
          >
            {n.label}
          </a>
        );
    }
  });
}

const P = "m-0 whitespace-pre-wrap break-words";

function blocks(bs: Block[], text: TextFn, key: string): ReactNode[] {
  return bs.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p":
        return (
          <p key={k} className={P}>
            {inline(b.c, text, k)}
          </p>
        );
      case "h":
        return (
          <p key={k} className={`${P} font-semibold`}>
            <strong>{inline(b.c, text, k)}</strong>
          </p>
        );
      case "pre":
        return (
          <pre
            key={k}
            className="m-0 overflow-x-auto rounded bg-muted p-2 font-mono text-[0.9em] whitespace-pre"
          >
            <code>{b.s}</code>
          </pre>
        );
      case "q":
        return (
          <blockquote
            key={k}
            className="m-0 flex flex-col gap-1 border-l-2 border-border pl-2 text-muted-foreground"
          >
            {blocks(b.c, text, k)}
          </blockquote>
        );
      default: {
        const Tag = b.ordered ? "ol" : "ul";
        return (
          <Tag
            key={k}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={`m-0 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}
          >
            {b.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static parse output
              <li key={j} className={P}>
                {inline(it, text, `${k}.${j}`)}
              </li>
            ))}
          </Tag>
        );
      }
    }
  });
}

/** A comment body as formatted blocks. `text` renders each plain-text piece. */
export function Markdown({
  body,
  text = (s) => s,
}: {
  body: string;
  text?: TextFn;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {blocks(parseMarkdown(body), text, "m")}
    </div>
  );
}

/** Inline markup only, as spans of phrasing content (safe inside a button). */
export function MarkdownInline({
  body,
  text = (s) => s,
}: {
  body: string;
  text?: TextFn;
}) {
  return <>{inline(parseInlineOnly(body), text, "m")}</>;
}

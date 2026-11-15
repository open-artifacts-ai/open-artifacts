// A doc's rendered page (index.html of each version, #1100): static HTML from
// the schema's JSON, no scripts. Only schema nodes and marks are known; text
// and attributes are escaped, so a doc can't inject markup.
import { type DocJSON, isAllowedHref } from "@oa/doc-schema";

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

type Mark = NonNullable<DocJSON["marks"]>[number];

function text(n: DocJSON): string {
  let out = esc(n.text ?? "");
  // Marks open in schema order (link, bold, italic, strike, code): the first
  // listed is outermost.
  const marks = [...(n.marks ?? [])].reverse();
  for (const m of marks) out = wrapMark(m, out);
  return out;
}

function wrapMark(m: Mark, inner: string): string {
  switch (m.type) {
    case "bold":
      return `<strong>${inner}</strong>`;
    case "italic":
      return `<em>${inner}</em>`;
    case "strike":
      return `<s>${inner}</s>`;
    case "code":
      return `<code>${inner}</code>`;
    case "link": {
      // A raw Yjs update can carry any href: only allowed ones become links.
      const raw = m.attrs?.href;
      if (!isAllowedHref(raw)) return inner;
      const href = esc(raw);
      const title = m.attrs?.title
        ? ` title="${esc(String(m.attrs.title))}"`
        : "";
      return `<a href="${href}"${title} rel="noopener noreferrer">${inner}</a>`;
    }
    default:
      return inner;
  }
}

const kids = (n: DocJSON) => (n.content ?? []).map(node).join("");

function node(n: DocJSON): string {
  switch (n.type) {
    case "text":
      return text(n);
    case "paragraph":
      return `<p>${kids(n)}</p>`;
    case "heading": {
      const l = Math.min(3, Math.max(1, Number(n.attrs?.level ?? 1)));
      return `<h${l}>${kids(n)}</h${l}>`;
    }
    case "blockquote":
      return `<blockquote>${kids(n)}</blockquote>`;
    case "codeBlock": {
      const lang = n.attrs?.language
        ? ` class="language-${esc(String(n.attrs.language))}"`
        : "";
      return `<pre><code${lang}>${kids(n)}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr>";
    case "bulletList":
      return `<ul>${kids(n)}</ul>`;
    case "orderedList": {
      const start = Number(n.attrs?.start ?? 1);
      return `<ol${start !== 1 ? ` start="${start}"` : ""}>${kids(n)}</ol>`;
    }
    case "listItem":
      return `<li>${kids(n)}</li>`;
    case "taskList":
      return `<ul class="tasks">${kids(n)}</ul>`;
    case "taskItem":
      return `<li><input type="checkbox" disabled${n.attrs?.checked ? " checked" : ""}> ${kids(n)}</li>`;
    default:
      return kids(n);
  }
}

const CSS =
  ":root{color-scheme:light dark}body{max-width:46rem;margin:2rem auto;padding:0 1rem;font:16px/1.6 system-ui,sans-serif}pre{overflow-x:auto;padding:.75rem;background:#8881;border-radius:6px}code{font-family:ui-monospace,monospace}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid #8886}ul.tasks{list-style:none;padding-left:0}img{max-width:100%}";

/** The doc as one standalone HTML page. */
export function docToHtml(json: DocJSON, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${kids(json)}</body></html>`;
}

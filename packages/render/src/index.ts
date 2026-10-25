import {
  FORMATS,
  type Format,
  PROTOCOL_VERSION,
  sendToShell,
} from "@oa/shared";

import { renderCode } from "./code";
import { wireCodeButtons } from "./copy";
import { prepareMarkdown, renderMarkdown } from "./markdown";
import { renderMermaid } from "./mermaid";
import { renderPdf } from "./pdf";
import {
  currentTheme,
  followSystemTheme,
  onThemeChange,
  watchShellTheme,
} from "./theme";
// Built by Vite, so the fonts theme.css names are emitted next to it, hashed.
import themeHref from "./theme.css?url";

export { prepareMarkdown, renderCode, renderMarkdown, renderPdf };

function meta(name: string): string {
  return (
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ??
    ""
  );
}

/** Entry path → URL relative to this page (keeps the artifact/version prefix). */
export function entryUrl(entry: string, base: string): string {
  const encoded = entry
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return new URL(encoded, base).href;
}

function injectTheme(): void {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = themeHref;
  document.head.appendChild(link);
}

function fail(message: string): void {
  const p = document.createElement("p");
  p.className = "oa-error";
  p.textContent = message;
  document.body.replaceChildren(p);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the artifact (${res.status}).`);
  return res.text();
}

async function boot(): Promise<void> {
  const format = meta("oa-format") as Format;
  if (!FORMATS.includes(format) || format === "html") return;
  injectTheme();
  watchShellTheme();
  followSystemTheme();
  wireCodeButtons(document);
  sendToShell({
    oa: 1,
    type: "hello",
    protocol: PROTOCOL_VERSION,
    kind: format,
  });

  const entry = meta("oa-entry");
  const url = entryUrl(entry, location.href);
  try {
    if (format === "markdown") {
      const src = await fetchText(url);
      await prepareMarkdown(src);
      document.body.innerHTML = renderMarkdown(src);
      await renderMermaid(document.body, currentTheme());
      onThemeChange((t) => void renderMermaid(document.body, t));
    } else if (format === "code") {
      const src = await fetchText(url);
      const name = entry.slice(entry.lastIndexOf("/") + 1);
      document.body.innerHTML = await renderCode(
        src,
        meta("oa-language") || "text",
        name,
      );
    } else {
      await renderPdf(url, document.body);
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : "Could not render the artifact.");
  }
  // Readiness marker: server-side thumbnails screenshot once it is set.
  document.documentElement.dataset.oaRendered = "";
}

if (
  typeof document !== "undefined" &&
  document.querySelector('meta[name="oa-format"]')
)
  void boot();

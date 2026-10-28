import {
  displayLang,
  escapeHtml,
  highlightSync,
  loadLanguages,
  plainHtml,
} from "./highlight";

/** Above this size shiki is too slow in the browser; render plain numbered lines. */
const HIGHLIGHT_MAX_CHARS = 512 * 1024;
/** Above this the code view isn't built at all: a phone can freeze on the DOM alone. */
export const CODE_MAX_BYTES = 2 * 1024 * 1024;
/** How much of the start is checked for binary (NUL bytes, invalid UTF-8). */
const SNIFF_BYTES = 8 * 1024;

export type CodeText =
  | { ok: true; text: string }
  | { ok: false; reason: "binary" | "too_large" };

/**
 * A code entry's bytes as text, or why it can't be shown: over
 * CODE_MAX_BYTES, or binary (a NUL byte, or invalid UTF-8, in the first 8 KB).
 * An image published as code must never reach the highlighter.
 */
export function textOf(bytes: Uint8Array): CodeText {
  if (bytes.byteLength > CODE_MAX_BYTES)
    return { ok: false, reason: "too_large" };
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return { ok: false, reason: "binary" };
  try {
    // stream: a character cut at the 8 KB boundary isn't an error.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return { ok: false, reason: "binary" };
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

/** In place of the code view: why the file isn't shown, and a Download link. */
export function unpreviewableHtml(
  reason: "binary" | "too_large",
  url: string,
  name: string,
): string {
  const why =
    reason === "too_large"
      ? "This file is too large to preview."
      : "This file can't be shown.";
  return `<div class="oa-unpreviewable" role="status">
<p>${why}</p>
<a href="${escapeHtml(url)}" download="${escapeHtml(name)}">Download</a>
</div>`;
}

const COPY =
  '<button class="oa-copy" type="button" aria-label="Copy code">Copy</button>';

/** The .oa-code view (D5 contract): header with name, language, wrap and copy; shiki body. */
export async function renderCode(
  src: string,
  language: string,
  name = "",
): Promise<string> {
  let body: string;
  if (src.length > HIGHLIGHT_MAX_CHARS) body = plainHtml(src);
  else {
    await loadLanguages([language]);
    body = highlightSync(src, language);
  }
  return `<div class="oa-code" data-wrap="false">
<header class="oa-code-header">
<span class="oa-code-name">${escapeHtml(name)}</span>
<span class="oa-code-lang">${escapeHtml(displayLang(language))}</span>
<div class="oa-code-actions">
<button class="oa-wrap" type="button" aria-pressed="false">Wrap</button>
${COPY}
</div>
</header>
${body}
</div>`;
}

export const COPY_BUTTON = COPY;

// Server-side rendering of Design's HTML templates. Pure (no imports): the build
// script loads it in plain Node.

/** Drops the leading `<!-- … -->` documentation comment after the doctype. */
export function stripTemplateComment(html: string): string {
  return html.replace(/^(<!doctype html>\s*)<!--[\s\S]*?-->\s*/i, "$1");
}

/** A row snippet without its leading documentation comment or trailing newline. */
export function busSnippetOf(html: string): string {
  return html.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimEnd();
}

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/**
 * Fills every `{{name}}` with the HTML-escaped value. Throws on a placeholder
 * without a value, so a template change can't ship an unfilled page.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined)
      throw new Error(`template placeholder {{${k}}} has no value`);
    return escapeHtml(v);
  });
}

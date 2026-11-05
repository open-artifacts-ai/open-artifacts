import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...out, cur];
}

function rule(selector: string): string {
  const i = flat.indexOf(`${selector} {`);
  if (i < 0) return "";
  return flat.slice(i, flat.indexOf("}", i));
}

describe("adversarial: theme.css", () => {
  // B11 (02-backend.md) emits ```mermaid as <pre class="mermaid">; theme.css
  // only styles .oa-mermaid, so diagrams get the mono code-block chrome.
  it("styles the Mermaid container B11 actually emits (pre.mermaid)", () => {
    expect(flat).toMatch(/\.oa-doc[^{]*\.mermaid\b/);
  });

  // markdown-it-task-lists puts the input inside <p> in loose lists:
  // <li class="task-list-item"><p><input ...> text</p></li>. `li > input`
  // misses it, so the native checkbox and a bullet show.
  it("styles task-list checkboxes in loose lists (li > p > input)", () => {
    expect(flat).toMatch(
      /li > p > input\[type="checkbox"\]|\.task-list-item(-checkbox)?\b/,
    );
  });

  // .oa-copy and the data-lang label are position:absolute inside a pre that
  // is itself the overflow-x scroller, so they scroll away with the code
  // (measured in Chrome: button right edge moves from -7px to -407px).
  it("keeps the copy button in place when a code block scrolls sideways", () => {
    const preScrolls = /overflow-x:\s*auto/.test(rule(".oa-doc pre"));
    const copyAbsolute = /position:\s*absolute/.test(
      rule(".oa-doc pre .oa-copy"),
    );
    expect(preScrolls && copyAbsolute).toBe(false);
  });

  // Copy is opacity:0 until :hover/:focus-within; touch devices never hover.
  it("shows the copy button on devices without hover", () => {
    expect(flat).toMatch(/@media \(hover: none\)/);
  });

  // No print rules: in dark mode the browser drops backgrounds and prints
  // #e9ebee text on white paper (1.19:1); pre overflow clips long lines.
  it("has print styles", () => {
    expect(flat).toContain("@media print");
  });

  // <html data-theme=dark><div data-theme=light><article class=oa-doc>
  // renders dark: the explicit dark rule ignores a nearer light ancestor.
  it("lets a nearer data-theme=light win over a dark ancestor", () => {
    expect(flat).toMatch(
      /\[data-theme="dark"\] :is\(\.oa-doc, \.oa-code, \.oa-pdf\):not\(\s*\[data-theme="light"\],\s*\[data-theme="light"\] \*\s*\)/,
    );
  });

  // ::selection sets only a background, so muted text keeps its color on it.
  // Selection colors are read from theme.css (light first, then dark).
  const selection = [...css.matchAll(/--oa-selection:\s*(#[0-9a-f]{6})/gi)].map(
    (m) => m[1] as string,
  );
  it.each([
    ["light text-muted / comment", "#5f6670", selection[0] as string],
    ["light number", "#8a5a00", selection[0] as string],
    ["dark text-muted / comment", "#9097a1", selection.at(-1) as string],
  ])("%s on the selection color reaches 4.5:1", (_, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  // pdf.js >= 4 sets --font-height/--scale-x on text-layer spans and relies on
  // viewer CSS to turn them into font-size and transform; without it the
  // selectable text layer is misaligned with the canvas.
  it("sizes pdf.js text-layer spans from --font-height", () => {
    expect(flat).toMatch(/\.textLayer[^{]*\{[^}]*--font-height/);
  });

  // Chrome classes are top-level; outside their container they get no tokens.
  // .oa-image is its own view; .oa-error (fail()) and .oa-unpreviewable (a
  // binary or oversized code entry) are the renderer's own notes. Each
  // carries its own tokens.
  it("scopes every selector under .oa-doc, .oa-code or .oa-pdf", () => {
    const selectors = [...flat.matchAll(/(?:^|[};])\s*([^@{};][^{};]*)\{/g)]
      .flatMap((m) => splitTop(m[1] as string))
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("@") && !/^(from|to|\d+%)$/.test(s));
    const leaks = selectors.filter(
      (s) =>
        !/^(:root|\.oa-(doc|code|pdf|image|error|unpreviewable)(?![\w-])|:is\(\.oa-|\[data-theme)/.test(
          s,
        ),
    );
    expect(leaks).toEqual([]);
  });

  // Re-verify of 3205c4f: in print, .oa-doc table keeps display:block and
  // overflow-x:auto, so a wide table is clipped on paper (Chrome, print
  // media: scrollWidth - clientWidth = 500px, columns lost).
  it("lets wide tables print without clipping columns", () => {
    const print = flat.slice(flat.indexOf("@media print"));
    expect(print).toMatch(/\.oa-doc table[^{]*\{[^}]*overflow(-x)?: visible/);
  });
});

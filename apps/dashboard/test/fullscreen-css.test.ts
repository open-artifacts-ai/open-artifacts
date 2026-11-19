// #2189: the full-screen controls' CSS contract, read from the stylesheet (no
// browser): a 32px fixed group 8px from the top right, icons muted at rest,
// colour-only motion, 44px on touch, hidden in print.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/viewer/viewer.css", import.meta.url),
  "utf8",
);
/** The body of the first rule whose selector list is exactly `selector`. */
const rule = (source: string, selector: string): string => {
  const at = source.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return source.slice(source.indexOf("{", at) + 1, source.indexOf("}", at));
};
/** The text inside the first `@media <query> { ... }` block. */
const media = (query: string): string => {
  const at = css.indexOf(`@media ${query} {`);
  if (at < 0) throw new Error(`no @media ${query}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced");
};

describe("full-screen controls: CSS", () => {
  it("a fixed 32px group, 8px in from the top right", () => {
    const bar = rule(css, ".oa-fsbar");
    expect(bar).toMatch(/position:\s*fixed/);
    expect(bar).toMatch(/height:\s*32px/);
    expect(bar).toMatch(/right:\s*max\(8px,/);
    expect(bar).toMatch(/top:\s*max\(8px,/);
  });

  it("icons are muted at rest and full contrast on hover, focus within or the pill", () => {
    expect(css).toMatch(/color:\s*var\(--oa-text-muted\)/);
    expect(css).toMatch(
      /\.oa-fsbar:hover :is\(\.oa-fsx, \.oa-fscomments, \.oa-opencomment\),[\s\S]*?\.oa-fsbar:focus-within[\s\S]*?\{\s*color:\s*var\(--oa-text\)/,
    );
  });

  it("motion: colour only, 150ms, the house curve; none under reduced motion", () => {
    expect(css).toMatch(
      /transition:\s*color 150ms cubic-bezier\(0\.2, 0, 0, 1\)/,
    );
    expect(media("(prefers-reduced-motion: reduce)")).toMatch(
      /transition:\s*none/,
    );
  });

  it("touch: 44px tap targets", () => {
    const touch = media("(pointer: coarse)");
    expect(touch).toMatch(/\.oa-fsbar \{\s*height:\s*44px/);
    expect(touch).toMatch(/min-width:\s*44px/);
  });

  it("hidden when printed", () => {
    expect(media("print")).toMatch(/\.oa-fsbar \{\s*display:\s*none/);
  });
});

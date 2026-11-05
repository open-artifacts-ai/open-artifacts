// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeRegistration } from "shiki";
import { describe, expect, it } from "vitest";
import { shikiThemes } from "../src/shiki-themes";

const css = readFileSync(join(import.meta.dirname, "../src/theme.css"), "utf8");

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

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match?.[1]) throw new Error(`no rule for ${selector}`);
  return match[1];
}

function cssValues(): { codeBg: string[]; selection: string[] } {
  const all = (name: string) =>
    [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "gi"))].map((m) =>
      (m[1] as string).toLowerCase(),
    );
  return { codeBg: all("--oa-code-bg"), selection: all("--oa-selection") };
}

// The forced-dark token rule: the one that starts with :root[data-theme="dark"].
function darkSelectors(): string[] {
  const start = css.indexOf(':root[data-theme="dark"]:has(');
  const list = css.slice(start, css.indexOf("{", start));
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  return [...out, cur.trim()].filter((sel) => !sel.startsWith(":root"));
}

describe("theme.css", () => {
  it("text tokens keep 4.5:1 on the selection color", () => {
    const { selection } = cssValues();
    expect(selection).toHaveLength(3);
    const [light, darkMedia, dark] = selection as [string, string, string];
    expect(darkMedia).toBe(dark);
    for (const fg of ["#15181c", "#454c56", "#5f6670", "#1d45b8"]) {
      expect(contrast(fg, light)).toBeGreaterThanOrEqual(4.5);
    }
    for (const fg of ["#e9ebee", "#b7bdc6", "#9097a1", "#a3b8ff"]) {
      expect(contrast(fg, dark)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["dark root", '<div data-theme="dark"><div><X></div></div>', true],
    [
      "light inside dark",
      '<div data-theme="dark"><div data-theme="light"><X></div></div>',
      false,
    ],
    [
      "dark inside light",
      '<div data-theme="light"><div data-theme="dark"><X></div></div>',
      true,
    ],
    [
      "light on the container",
      '<div data-theme="dark"><X data-theme="light"></div>',
      false,
    ],
    [
      "dark on the container",
      '<div data-theme="light"><X data-theme="dark"></div>',
      true,
    ],
    ["no data-theme", "<div><X></div>", false],
  ])("nearest data-theme wins: %s", (_, html, dark) => {
    document.body.innerHTML = html
      .replace("<X", '<article class="oa-doc"')
      .replace("</div>", "</article></div>");
    const el = document.querySelector(".oa-doc") as Element;
    const selectors = darkSelectors();
    expect(selectors.length).toBeGreaterThan(1);
    expect(selectors.some((sel) => el.matches(sel))).toBe(dark);
  });

  it("defines every --oa-* custom property it uses", () => {
    const defined = new Set(
      [...css.matchAll(/(--oa-[\w-]+)\s*:/g)].map((m) => m[1]),
    );
    const used = new Set(
      [...css.matchAll(/var\(\s*(--oa-[\w-]+)/g)].map((m) => m[1]),
    );
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("loads nothing from a third party: no url(), no remote @import", () => {
    expect([...css.matchAll(/url\(\s*["']?([^"')]+)/g)]).toEqual([]);
    const imports = [
      ...css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)/g),
    ].map((m) => m[1]);
    // Only the self-hosted font faces, resolved and bundled by Vite.
    expect(imports).toEqual(["@oa/ui/fonts.css"]);
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("sets a base font size of at least 16px", () => {
    const size = ruleBody(".oa-doc").match(/font-size:\s*([\d.]+)px/);
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(16);
  });

  it("caps the reading width at 72ch", () => {
    const width = ruleBody(".oa-doc").match(/max-width:\s*([\d.]+)ch/);
    expect(Number(width?.[1])).toBeGreaterThan(0);
    expect(Number(width?.[1])).toBeLessThanOrEqual(72);
  });
});

describe("shikiThemes", () => {
  const cases: [string, ThemeRegistration][] = Object.entries(shikiThemes);

  it.each(cases)("%s: every foreground reaches 4.5:1", (_, theme) => {
    const bg = theme.colors?.["editor.background"];
    const selection = theme.colors?.["editor.selectionBackground"];
    expect(bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(selection).toMatch(/^#[0-9a-f]{6}$/i);
    const fgs = [
      theme.colors?.["editor.foreground"],
      ...(theme.tokenColors ?? []).map((t) => t.settings.foreground),
    ].filter((c): c is string => Boolean(c));
    expect(fgs.length).toBeGreaterThan(5);
    for (const fg of fgs) {
      expect(fg).toMatch(/^#[0-9a-f]{6}$/i);
      for (const back of [bg, selection] as string[]) {
        expect({ fg, back, ok: contrast(fg, back) >= 4.5 }).toEqual({
          fg,
          back,
          ok: true,
        });
      }
    }
  });

  it.each(cases)("%s: background and selection match theme.css", (_, theme) => {
    const values = cssValues();
    expect(values.codeBg).toContain(
      String(theme.colors?.["editor.background"]).toLowerCase(),
    );
    expect(values.selection).toContain(
      String(theme.colors?.["editor.selectionBackground"]).toLowerCase(),
    );
  });
});

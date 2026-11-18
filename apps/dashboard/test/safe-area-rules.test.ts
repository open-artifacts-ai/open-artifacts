// #2753: headless Chrome has no notch, so computed env() values can't be
// tested; assert the rules exist where fixed or full-bleed things need them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const css = (p: string) => read(`../src/${p}`);

describe("safe-area insets (viewport-fit=cover)", () => {
  it("the viewport meta asks for cover", () => {
    expect(read("../index.html")).toMatch(/viewport-fit=cover/);
  });
  it("every screen: sides on body, top on the main region", () => {
    const s = css("styles.css");
    expect(s).toMatch(/body\s*{[^}]*padding-left:\s*env\(safe-area-inset-left/);
    expect(s).toMatch(
      /body\s*{[^}]*padding-right:\s*env\(safe-area-inset-right/,
    );
    expect(s).toMatch(
      /#oa-main:not\(\.oa-bare\)\s*{[^}]*padding-top:\s*env\(safe-area-inset-top/,
    );
  });
  it("the viewer: top inset and a cap under the status bar", () => {
    const v = css("viewer/viewer.css");
    expect(v).toMatch(
      /\.oa-bare\s*{[^}]*padding-top:\s*env\(safe-area-inset-top/,
    );
    expect(v).toMatch(/\.oa-bare::before/);
  });
  it("fixed things keep off the notch: toolbar, sheets, toasts", () => {
    expect(css("viewer/viewer.css")).toMatch(
      /\.oa-doc-toolbar\s*{[^}]*left:\s*env\(safe-area-inset-left[^}]*right:\s*env\(safe-area-inset-right/,
    );
    const sheets = css("viewer/comments/surfaces.tsx");
    expect(sheets).toMatch(/env\(safe-area-inset-left\)/);
    expect(sheets).toMatch(/env\(safe-area-inset-right\)/);
    expect(css("layout/toast.tsx")).toMatch(/safe-area-inset-right/);
  });
});

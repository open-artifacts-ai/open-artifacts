import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");
const fonts = read("../src/tokens/fonts.css");
const tokens = read("../src/tokens/tokens.css");
const require = createRequire(import.meta.url);

describe("self-hosted Geist", () => {
  it("tokens.css pulls in fonts.css and nothing remote", () => {
    expect(tokens).toMatch(/@import "\.\/fonts\.css";/);
    expect(tokens).not.toMatch(/https?:\/\//);
  });

  it("fonts.css is local woff2 only, with swap, and names no host", () => {
    expect(fonts).not.toMatch(/https?:\/\//);
    const urls = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map(
      (m) => m[1] ?? "",
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls)
      expect(u).toMatch(/^@fontsource\/geist(-mono)?\/files\/.+\.woff2$/);
    expect(fonts).not.toMatch(/format\("woff"\)/);
    const faces = fonts.match(/@font-face/g)?.length ?? 0;
    expect(fonts.match(/font-display: swap/g)?.length).toBe(faces);
  });

  it("covers Geist 400/500/600 and Geist Mono 400/500, no more", () => {
    const seen = new Set(
      [
        ...fonts.matchAll(
          /font-family: "([^"]+)";[\s\S]*?font-weight: (\d+);/g,
        ),
      ].map((m) => `${m[1]} ${m[2]}`),
    );
    expect([...seen].sort()).toEqual([
      "Geist 400",
      "Geist 500",
      "Geist 600",
      "Geist Mono 400",
      "Geist Mono 500",
    ]);
  });

  it("every file the faces name exists in the installed packages", () => {
    for (const m of fonts.matchAll(
      /url\("(@fontsource\/[^/]+)\/(files\/[^"]+)"\)/g,
    )) {
      const dir = dirname(require.resolve(`${m[1]}/package.json`));
      expect(() => readFileSync(join(dir, m[2] ?? ""))).not.toThrow();
    }
  });
});

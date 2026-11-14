import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The landing uses › ✓, which turn into mojibake if a page is served
// or parsed as anything but UTF-8. Runs against the built site.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const htmlFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return htmlFiles(p);
    return p.endsWith(".html") ? [p] : [];
  });

describe("charset and glyphs", () => {
  it("every page declares utf-8 as the first element in head", () => {
    const pages = htmlFiles(dist);
    expect(pages.length).toBeGreaterThan(1);
    for (const f of pages)
      expect(readFileSync(f, "utf8"), f).toMatch(
        /<head[^>]*>\s*<meta charset="utf-8"\s*\/?>/i,
      );
  });

  it("the demo glyphs are written as UTF-8 bytes", () => {
    const index = readFileSync(join(dist, "index.html"));
    for (const bytes of [
      [0xe2, 0x80, 0xba], // › U+203A
      [0xe2, 0x9c, 0x93], // ✓ U+2713
    ])
      expect(index.includes(Buffer.from(bytes)), bytes.join(" ")).toBe(true);
  });

  it("no entity or mojibake stand-ins for the glyphs", () => {
    const index = readFileSync(join(dist, "index.html"), "utf8");
    expect(index).not.toMatch(
      /&rsaquo;|&check;|&middot;|&#x?(8250|203a|10003|2713|183|b7);/i,
    );
    // UTF-8 bytes of the glyphs decoded as Windows-1252.
    expect(index).not.toMatch(/â€º|âœ“|Â·/);
  });

  it("no em dashes in the built index", () => {
    const index = readFileSync(join(dist, "index.html"), "utf8");
    const hits =
      index.match(/.{0,30}(\u2014|&mdash;|&#8212;|&#x2014;).{0,30}/gi) ?? [];
    expect(hits).toEqual([]);
  });
});

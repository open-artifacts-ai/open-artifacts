// scrollIntoView scrolls every ancestor that can scroll, including the phone
// sheet's own box (it holds the header) and, on iOS, the visual viewport. The
// comments code moves its own scroller instead (scrollWithin in keepScroll.tsx),
// and focus() always passes preventScroll.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../src/viewer/comments");
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f));
// Strip comments so prose may mention the names.
const code = (f: string) =>
  readFileSync(join(DIR, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("comments scroll only their own scroller", () => {
  it("never calls scrollIntoView", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/scrollIntoView/);
  });
  it("never calls focus() without preventScroll", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/\.focus\(\s*\)/);
  });
});

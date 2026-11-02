import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const files = ["src", "test", "e2e"]
  .flatMap((d) => walk(join(__dirname, "..", d)))
  .filter((f) => /\.(tsx?|css)$/.test(f));

it("has no em dash and no raw control characters in source", () => {
  const bad: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // Built from escapes so this file is clean too.
    if (text.includes(String.fromCharCode(0x2014))) bad.push(`${f}: em dash`);
    for (const ch of text)
      if (ch.charCodeAt(0) < 0x20 && ch !== "\n" && ch !== "\t" && ch !== "\r")
        bad.push(`${f}: control ${ch.charCodeAt(0)}`);
  }
  expect(bad).toEqual([]);
});

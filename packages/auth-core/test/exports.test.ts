import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// "./domains" is the one built entry: provision's dist imports it at runtime
// under plain node (no type stripping), so import/default are JS in dist.
// Workers bundle the source.
describe("package exports", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  it("./domains: workerd -> src, import/default -> dist", () => {
    expect(pkg.exports["./domains"]).toEqual({
      types: "./src/domains.ts",
      workerd: "./src/domains.ts",
      import: "./dist/domains.js",
      default: "./dist/domains.js",
    });
    expect(pkg.scripts.build).toBeTruthy();
  });

  it("src/domains.ts imports nothing, so its build is standalone", () => {
    const src = readFileSync(
      new URL("../src/domains.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("@oa/broker-core", () => {
  it("resolves to the source under workerd, so a deploy never bundles a stale dist", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(app, "../../packages/broker-core/package.json"),
        "utf8",
      ),
    );
    expect(pkg.exports["."].workerd).toBe("./src/index.ts");
    expect(Object.keys(pkg.exports["."])[1]).toBe("workerd");
    expect(pkg).not.toHaveProperty("main");
  });
});

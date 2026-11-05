import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("the tier store's migration", () => {
  it("packages/billing-core's test copy of 0001_init.sql is byte-identical to the app's (L2)", () => {
    const real = readFileSync(join(app, "migrations/0001_init.sql"));
    const copy = readFileSync(
      join(app, "../../packages/billing-core/test/migrations/0001_init.sql"),
    );
    expect(copy.equals(real)).toBe(true);
  });
});

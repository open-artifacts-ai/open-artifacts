import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROBOTS, CONTENT_ROBOTS } from "../src/robots.ts";

const ROOT = join(import.meta.dirname, "../../..");

// The live case can't import the Worker's text (a server test can't import
// this package either, scripts/ci/workspace-imports.ts), so each side keeps
// its own copy. skeleton.test.ts pins the Worker's output to its copy; this
// pins the two copies together, as source text, so neither can drift alone.
describe("robots.txt: the live case's text and the server test's", () => {
  const server = readFileSync(
    join(ROOT, "apps/server/test/skeleton.test.ts"),
    "utf8",
  );

  it.each([
    ["app", APP_ROBOTS],
    ["content", CONTENT_ROBOTS],
  ])("%s: skeleton.test.ts pins the same text", (_host, text) => {
    expect(server).toContain(JSON.stringify(text));
  });
});

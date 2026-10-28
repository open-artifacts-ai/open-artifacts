import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// mcp-tools.md must name exactly the tools the server's manifest lists.
const manifest: { name: string }[] = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../server/src/mcp/tool-manifest.json", import.meta.url),
    ),
    "utf8",
  ),
);
const doc = readFileSync(
  fileURLToPath(new URL("../src/content/docs/mcp-tools.md", import.meta.url)),
  "utf8",
);

describe("mcp-tools docs match the tool manifest", () => {
  it("names every tool, and only those", () => {
    const named = new Set(
      [...doc.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(([, n]) => n),
    );
    expect(named).toEqual(new Set(manifest.map((t) => t.name)));
    expect(manifest).toHaveLength(19);
  });
});

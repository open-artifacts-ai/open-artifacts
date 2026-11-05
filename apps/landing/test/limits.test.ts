import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatSeconds,
  LIMIT_PLACEHOLDERS,
} from "../src/lib/limits";

// Limits come from @oa/shared's LIMITS via {LIMIT_*} placeholders, so the
// docs can't drift when Backend changes one.
const src = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const docs = readdirSync(src).filter((f) => f.endsWith(".md"));
const read = (dir: string, f: string) => readFileSync(`${dir}${f}`, "utf8");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("limits in the docs", () => {
  it("formats values like the docs write them", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(1024 * 1024 + 64 * 1024)).toBe("1,088 KB");
    expect(formatSeconds(600)).toBe("10 minutes");
    expect(formatSeconds(3600)).toBe("1 hour");
    expect(formatSeconds(45)).toBe("45 seconds");
  });

  it("never hardcodes a value LIMITS owns", () => {
    for (const f of docs) {
      const text = read(src, f);
      for (const value of Object.values(LIMIT_PLACEHOLDERS))
        expect(text, `${f}: ${value}`).not.toMatch(
          new RegExp(`(?<![\\d.])${escapeRe(value)}`),
        );
    }
  });

  // Plan-aware sizes come only from placeholders; {LIMIT_DOC} is retired.
  it("uses the plan-aware placeholders and no size literals", () => {
    for (const key of [
      "{LIMIT_DATA_DOC_FREE}",
      "{LIMIT_DATA_DOC_PAID}",
      "{LIMIT_MCP_BODY_FREE}",
      "{LIMIT_MCP_BODY_PAID}",
    ])
      expect(LIMIT_PLACEHOLDERS[key], key).toBeDefined();
    expect(LIMIT_PLACEHOLDERS["{LIMIT_DOC}"]).toBeUndefined();
    for (const f of docs) {
      const text = read(src, f);
      expect(text, f).not.toContain("{LIMIT_DOC}");
      for (const literal of ["256 KB", "320 KB", "128 KB"])
        expect(text, `${f}: ${literal}`).not.toContain(literal);
    }
  });

  it("renders the current LIMITS values", () => {
    const page = (f: string) => read(dist, `docs/${f}`);
    expect(page("mcp-tools.md")).toContain(
      `capped at ${formatBytes(LIMITS.inlineBytes)} in total`,
    );
    expect(page("mcp-tools.md")).toContain(
      `A file can be up to ${formatBytes(LIMITS.fileBytes)}, and one publish up to ${formatBytes(LIMITS.publishBytes)}.`,
    );
    expect(page("mcp-tools.md")).toContain(
      `within about ${formatSeconds(LIMITS.indexDebounceMs / 1000)} of being published`,
    );
    expect(page("mcp-tools.md")).toContain(
      `Only the first ${formatBytes(LIMITS.indexTextBytes)} of an artifact's entry file is indexed`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Document size (Workers Free) | ${formatBytes(LIMITS.dataDocBytesFree)} |`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Document size (Workers Paid) | ${formatBytes(LIMITS.dataDocBytesPaid)} |`,
    );
    expect(page("self-hosting-costs.md")).toContain(
      `| Live-page data document size | ${formatBytes(LIMITS.dataDocBytesFree)} | ${formatBytes(LIMITS.dataDocBytesPaid)} |`,
    );
    expect(page("self-hosting-costs.md")).toContain(
      `| MCP request size | ${formatBytes(LIMITS.mcpBodyBytesFree)} | ${formatBytes(LIMITS.mcpBodyBytesPaid)} |`,
    );
    expect(page("mcp-tools.md")).toContain(
      `an MCP request larger than ${formatBytes(LIMITS.mcpBodyBytesFree)} is refused`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Writes per viewer | ${LIMITS.viewerWritesPerMin} per minute |`,
    );
    expect(page("runtime-api.md")).toContain(
      `| Collection size for \`query()\` with \`where\` or \`orderBy\` | ${formatBytes(LIMITS.queryCollectionBytes)} |`,
    );
    expect(page("security.md")).toContain(
      `expires after ${formatSeconds(LIMITS.signedUrlTtlSec)}`,
    );
    for (const f of [...docs, "../llms.txt", "../llms-full.txt"])
      expect(read(`${dist}docs/`, f), f).not.toContain("{LIMIT_");
    for (const f of ["mcp-tools/index.html", "runtime-api/index.html"])
      expect(read(`${dist}docs/`, f), f).not.toContain("{LIMIT_");
  });
});

describe("upload flow in llms.txt", () => {
  it("carries the large-file steps with the current limits", () => {
    const llms = read(dist, "llms.txt");
    expect(llms).toContain(
      `capped at ${formatBytes(LIMITS.inlineBytes)} in total`,
    );
    expect(llms).toContain("`create_upload`");
    expect(llms).toContain('{ "uploadId": "<uploadId>" }');
    expect(llms).toContain(
      `searchable with \`search_artifacts\` within about ${formatSeconds(LIMITS.indexDebounceMs / 1000)} of being published`,
    );
    expect(llms).toContain(
      `Only the first ${formatBytes(LIMITS.indexTextBytes)} of an artifact's entry file is indexed`,
    );
  });
});

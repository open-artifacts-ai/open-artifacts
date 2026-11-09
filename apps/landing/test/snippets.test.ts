import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snippets } from "../../../scripts/setup/src/steps/agent-config.ts";

// Agents and people paste these snippets verbatim, so they must be valid as-is.
const docs = fileURLToPath(new URL("../src/content/docs/", import.meta.url));
const pages = readdirSync(docs)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ f, text: readFileSync(`${docs}${f}`, "utf8") }));

const blocks = (lang: string) =>
  pages.flatMap(({ f, text }) =>
    [
      ...text.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, "g")),
    ].map((m) => ({ f, body: m[1] ?? "" })),
  );

describe("doc snippets", () => {
  it("every json block parses (no comments; put file paths above the block)", () => {
    const json = blocks("json");
    expect(json.length).toBeGreaterThan(0);
    for (const { f, body } of json) {
      expect(() => JSON.parse(body), f).not.toThrow();
    }
  });

  // A literal token in a command or config leaks through shell history or
  // git: a double-quoted header may only carry $OA_TOKEN, and no snippet
  // holds an oa_pat_ value.
  it("never puts a literal token in a snippet", () => {
    for (const { f, text } of pages) {
      for (const [h] of text.matchAll(/--header\s+"[^"]*"/g))
        expect(h, f).toContain("$OA_TOKEN");
      for (const [, body] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g))
        expect(body, f).not.toContain("oa_pat_");
    }
  });
});

// connect-agents must show exactly what setup's agent-config step prints.
describe("connect-agents matches scripts/setup agent-config", () => {
  const s = snippets("open-artifacts", "https://artifacts.example.com/mcp");
  const doc = pages.find((p) => p.f === "connect-agents.md")?.text ?? "";
  const section = (title: string) =>
    doc.split(`## ${title}\n`)[1]?.split("\n## ")[0] ?? "";
  const block = (title: string, lang: string) =>
    section(title).match(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``))?.[1];

  it("Claude Code", () => {
    expect(block("Claude Code", "sh")?.trim()).toBe(s.claudeCode);
  });
  it("Codex CLI OAuth commands configure setup's URL-only server", () => {
    const commands = (block("Codex CLI", "sh") ?? "")
      .trim()
      .match(/^codex mcp add ([\w-]+) --url (\S+)\ncodex mcp login \1$/);
    expect(commands).not.toBeNull();
    const [, name, url] = commands ?? [];
    // `mcp add --url` writes the same URL-only TOML that setup emits.
    expect(s.codex).toBe(`[mcp_servers.${name}]\nurl = "${url}"`);
  });
  it("Codex CLI token fallback", () => {
    expect(block("Codex CLI", "toml")?.trim()).toBe(s.codexToken);
  });
  it("Cursor, OpenCode (OAuth and token file) and generic JSON", () => {
    for (const [title, want] of [
      ["Cursor", s.cursor],
      ["OpenCode", s.opencode],
      ["Without OAuth", s.opencodeToken],
      ["Other clients", s.json],
    ] as const)
      expect(JSON.parse(block(title, "json") ?? "null"), title).toEqual(
        JSON.parse(want ?? "null"),
      );
  });
});

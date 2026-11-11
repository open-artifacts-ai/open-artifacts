import { describe, expect, it } from "vitest";
import { fileSnippets, snippets } from "../src/steps/agent-config.ts";

const URL = "https://app.example.com/mcp";
const FILE = "/home/u/.open-artifacts/app-example-com-pat-token";

describe("agent-config snippets", () => {
  const s = snippets("open-artifacts", URL, FILE);
  it("every JSON snippet parses with JSON.parse", () => {
    for (const k of ["cursor", "opencode", "opencodeToken", "json"])
      expect(() => JSON.parse(s[k] as string), k).not.toThrow();
  });
  it("OAuth clients get only the URL: no header, token or env", () => {
    expect(s.claudeCode).toBe(
      `claude mcp add --transport http -s user open-artifacts ${URL}`,
    );
    expect(JSON.parse(s.cursor as string).mcpServers["open-artifacts"]).toEqual(
      {
        url: URL,
      },
    );
    expect(JSON.parse(s.opencode as string).mcp["open-artifacts"]).toEqual({
      type: "remote",
      url: URL,
      enabled: true,
    });
    for (const k of ["claudeCode", "cursor", "opencode", "codex"])
      expect(s[k], k).not.toMatch(/OA_TOKEN|\$\(cat|--header|oa_pat_|Bearer/);
  });
  it("the token fallbacks read the absolute file; none embeds a token", () => {
    expect(
      JSON.parse(s.opencodeToken as string).mcp["open-artifacts"],
    ).toMatchObject({
      oauth: false,
      headers: { Authorization: `Bearer {file:${FILE}}` },
    });
    expect(s.codexToken).toContain(`http_headers_helper = "T=$(cat ${FILE})`);
    expect(s.codexToken).not.toContain("OA_TOKEN");
    expect(s.codexToken).toContain("[mcp_servers.open-artifacts]");
    expect(
      JSON.parse(s.json as string).mcpServers["open-artifacts"].headers,
    ).toEqual({
      Authorization: "Bearer <YOUR_TOKEN>",
    });
    for (const v of Object.values(s)) expect(v).not.toMatch(/oa_pat_/);
  });
  it("Codex defaults to URL-only config and browser OAuth", () => {
    const c = fileSnippets("open-artifacts", URL, FILE).codex;
    expect(c?.text).toBe(`[mcp_servers.open-artifacts]\nurl = "${URL}"`);
    expect(c?.note).toContain("codex mcp login open-artifacts");
    expect(c?.note).not.toContain(FILE);
  });
  it("Codex's token fallback reads the file through a helper and needs no env var", () => {
    const note = fileSnippets("open-artifacts", URL, FILE).codexToken?.note;
    expect(note).toContain("Codex 0.163 or later");
    expect(note).toContain(FILE);
    expect(note).not.toContain("OA_TOKEN");
  });
  it("without a token file there are no file-based fallbacks", () => {
    const n = fileSnippets("open-artifacts", URL);
    expect(n.opencodeToken).toBeUndefined();
    expect(n.codexToken).toBeUndefined();
    expect(n.codex?.note).toContain("codex mcp login open-artifacts");
    expect(JSON.stringify(n)).not.toContain("pat-token");
  });
});

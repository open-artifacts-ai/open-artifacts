import { createScanner, type ParseError, parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  JSONC_TOKENS,
  parseJsonc,
  removeIfEmpty,
  removeOpencodeMcp,
  removePlugin,
  upsertOpencodeMcp,
  upsertPlugin,
} from "../src/index.ts";

const valid = (text: string) => {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0;
};

const server = { type: "local", command: ["oa-bus", "mcp", "opencode"] };

// The shape of a real OpenCode 2.0.32 opencode.json: comments, trailing commas.
const CONFIG = `{
  // global config
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "plugins": ["./server-plugin",],
  "mcp": {
    "servers": {
      // keep me
      "other": { "type": "local", "command": ["x"], },
    },
  },
}
`;

const CLI = `{
  // TUI plugins
  "plugins": [
    "./herdr", // trailing note
  ],
}
`;

describe("parseJsonc", () => {
  it("reads comments and trailing commas", () => {
    expect(parseJsonc(CONFIG, "f")).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugins: ["./server-plugin"],
      mcp: { servers: { other: { type: "local", command: ["x"] } } },
    });
  });

  it("refuses text it cannot parse, or that is not an object", () => {
    expect(() => parseJsonc("{ not json", "f.json")).toThrow(/f\.json/);
    expect(() => parseJsonc("[]", "f.json")).toThrow(/f\.json/);
    expect(() => parseJsonc('{"a": 1} x', "f.json")).toThrow(/f\.json/);
  });

  it("treats empty text as an empty object", () => {
    expect(parseJsonc("", "f")).toEqual({});
  });
});

describe("opencode v2 mcp.servers (jsonc)", () => {
  it("adds under mcp.servers keeping every comment, and removal restores the text", () => {
    const added = upsertOpencodeMcp(CONFIG, "oa_bus", server);
    for (const c of ["// global config", "/* block comment */", "// keep me"])
      expect(added).toContain(c);
    expect(parseJsonc(added, "f").mcp).toEqual({
      servers: { other: { type: "local", command: ["x"] }, oa_bus: server },
    });
    expect(removeOpencodeMcp(added, "oa_bus")).toBe(CONFIG);
  });

  it("returns the same text when nothing changes", () => {
    const added = upsertOpencodeMcp(CONFIG, "oa_bus", server);
    expect(upsertOpencodeMcp(added, "oa_bus", server)).toBe(added);
    expect(removeOpencodeMcp(CONFIG, "oa_bus")).toBe(CONFIG);
    expect(removeOpencodeMcp("", "oa_bus")).toBe("");
  });

  it("replaces a changed entry in place", () => {
    const a = upsertOpencodeMcp(CONFIG, "oa_bus", server);
    const b = upsertOpencodeMcp(a, "oa_bus", { ...server, command: ["y"] });
    expect(parseJsonc(b, "f").mcp).toMatchObject({
      servers: { oa_bus: { command: ["y"] } },
    });
    expect(b).toContain("// keep me");
  });

  it("creates mcp.servers in an empty or missing file", () => {
    expect(parseJsonc(upsertOpencodeMcp("", "oa_bus", server), "f")).toEqual({
      mcp: { servers: { oa_bus: server } },
    });
    expect(
      parseJsonc(upsertOpencodeMcp("{}\n", "oa_bus", server), "f"),
    ).toEqual({ mcp: { servers: { oa_bus: server } } });
  });

  it("round-trips an empty servers object, keeping a comment inside it", () => {
    for (const text of [
      '{\n  "mcp": { "servers": {} }\n}\n',
      '{\n  "mcp": {\n    "servers": {\n      // none yet\n    }\n  }\n}\n',
      '{\r\n  "mcp": {\r\n    "servers": {}\r\n  }\r\n}\r\n',
    ]) {
      const added = upsertOpencodeMcp(text, "oa_bus", server);
      expect(parseJsonc(added, "f").mcp).toEqual({
        servers: { oa_bus: server },
      });
      if (text.includes("\r\n")) expect(added).not.toMatch(/[^\r]\n/);
      if (text.includes("// none yet")) expect(added).toContain("// none yet");
      expect(removeOpencodeMcp(added, "oa_bus")).toBe(text);
    }
  });

  it("drops a legacy top-level mcp.oa_bus entry", () => {
    const legacy = '{\n  "mcp": { "oa_bus": { "enabled": true } }\n}\n';
    const after = upsertOpencodeMcp(legacy, "oa_bus", server);
    expect(parseJsonc(after, "f").mcp).toEqual({
      servers: { oa_bus: server },
    });
    expect(parseJsonc(removeOpencodeMcp(after, "oa_bus"), "f")).toEqual({
      mcp: { servers: {} },
    });
  });

  it("refuses a non-object mcp or mcp.servers instead of clobbering it", () => {
    expect(() => upsertOpencodeMcp('{"mcp": "x"}', "oa_bus", server)).toThrow(
      /mcp/,
    );
    expect(() =>
      upsertOpencodeMcp('{"mcp": {"servers": []}}', "oa_bus", server),
    ).toThrow(/mcp\.servers/);
  });
});

describe("opencode cli.json plugins (jsonc)", () => {
  it("appends once keeping comments, and removal restores the text", () => {
    const added = upsertPlugin(CLI, "/p");
    expect(added).toContain("// TUI plugins");
    expect(added).toContain("// trailing note");
    expect(parseJsonc(added, "f").plugins).toEqual(["./herdr", "/p"]);
    expect(upsertPlugin(added, "/p")).toBe(added);
    expect(removePlugin(added, "/p")).toBe(CLI);
  });

  it("keeps object entries and matches ours by package", () => {
    const text =
      '{\n  "plugins": ["./x", { "package": "y", "options": { "a": 1 } }, { "package": "/p" }]\n}\n';
    expect(upsertPlugin(text, "/p")).toBe(text);
    expect(parseJsonc(removePlugin(text, "/p"), "f").plugins).toEqual([
      "./x",
      { package: "y", options: { a: 1 } },
    ]);
  });

  it("creates plugins when absent and leaves a doc without ours alone", () => {
    expect(parseJsonc(upsertPlugin("", "/p"), "f")).toEqual({
      plugins: ["/p"],
    });
    expect(removePlugin('{ "a": 1 }', "/p")).toBe('{ "a": 1 }');
    expect(() => upsertPlugin('{"plugins": {}}', "/p")).toThrow(/plugins/);
  });
});

describe("never corrupts or strips", () => {
  it("refuses a null plugins or servers instead of splicing into it", () => {
    expect(() => upsertPlugin('{\n  "plugins": null\n}\n', "/p")).toThrow(
      /plugins/,
    );
    expect(() =>
      upsertOpencodeMcp('{ "mcp": { "servers": null } }', "oa_bus", server),
    ).toThrow(/mcp\.servers/);
    expect(() =>
      upsertOpencodeMcp('{ "mcp": null }', "oa_bus", server),
    ).toThrow(/mcp/);
  });

  it("dropping a v1 mcp.oa_bus that is first keeps the next entry's comment", () => {
    const text =
      '{\n  "mcp": {\n    "oa_bus": { "type": "local", "command": ["x"] },\n    // GitHub server, keep\n    "github": { "type": "remote", "url": "u" }\n  }\n}\n';
    const out = upsertOpencodeMcp(text, "oa_bus", server);
    expect(out).toContain(
      '"mcp": {\n    // GitHub server, keep\n    "github": { "type": "remote", "url": "u" },',
    );
  });

  it("keeps a user comment after our first-placed entry", () => {
    const installed = upsertOpencodeMcp(
      '{\n  "mcp": {\n    "servers": { // add servers below\n    }\n  }\n}\n',
      "oa_bus",
      server,
    );
    const edited = installed.replace(
      /\n(\s*)\}\n {2}\}/,
      '\n$1  "mine": { "type": "local", "command": ["m"] }\n$1}\n  }',
    );
    expect(parseJsonc(edited, "f").mcp).toMatchObject({
      servers: { mine: {} },
    });
    const out = removeOpencodeMcp(edited, "oa_bus");
    expect(out).toContain("// add servers below");
    expect(parseJsonc(out, "f").mcp).toEqual({
      servers: { mine: { type: "local", command: ["m"] } },
    });
  });

  it("keeps an earlier sibling's trailing comment", () => {
    const text =
      '{\n  "mcp": {\n    "servers": {\n      "a": {}, // note\n      "oa_bus": {}\n    }\n  }\n}\n';
    const out = removeOpencodeMcp(text, "oa_bus");
    expect(out).toBe(
      '{\n  "mcp": {\n    "servers": {\n      "a": {} // note\n    }\n  }\n}\n',
    );
  });

  it("keeps comments between ours and a following comma", () => {
    const text = '{ "plugins": ["/p" /* mine */, "./x"] }';
    const out = removePlugin(text, "/p");
    expect(valid(out)).toBe(true);
    expect(out).toContain("/* mine */");
    expect(parseJsonc(out, "f").plugins).toEqual(["./x"]);
  });

  it("removing our sole entry after a line comment keeps the file valid", () => {
    const text =
      '{\n  "mcp": {\n    "servers": { // ours\n      "oa_bus": {"type":"local","command":["x"]} }\n  }\n}\n';
    const out = removeOpencodeMcp(text, "oa_bus");
    expect(valid(out)).toBe(true);
    expect(out).toContain("// ours");
    expect(parseJsonc(out, "f").mcp).toEqual({ servers: {} });
  });

  it("pruning the containers install created restores a config that had no mcp key", () => {
    const text = '{\n  "theme": "x"\n}\n';
    let out = removeOpencodeMcp(
      upsertOpencodeMcp(text, "oa_bus", server),
      "oa_bus",
    );
    out = removeIfEmpty(removeIfEmpty(out, ["mcp", "servers"]), ["mcp"]);
    expect(out).toBe(text);
    const cli = '{\n  // c\n  "theme": "x",\n}\n';
    expect(
      removeIfEmpty(removePlugin(upsertPlugin(cli, "/p"), "/p"), ["plugins"]),
    ).toBe(cli);
  });

  it("removeIfEmpty keeps a container holding only comments", () => {
    for (const text of [
      '{ "plugins": [ // mine\n  ] }',
      '{ "mcp": { "servers": { /* later */ } } }',
    ])
      expect(
        removeIfEmpty(removeIfEmpty(text, ["plugins"]), ["mcp", "servers"]),
      ).toBe(text);
  });

  it("removeIfEmpty leaves a non-empty or missing container", () => {
    const text = '{ "mcp": { "servers": { "a": {} } } }';
    expect(removeIfEmpty(text, ["mcp", "servers"])).toBe(text);
    expect(removeIfEmpty(text, ["plugins"])).toBe(text);
  });
});

describe("JSONC_TOKENS", () => {
  // Copied from jsonc-parser's const enum; a bump that renumbers fails here.
  const first = (text: string) => createScanner(text, false).scan();
  it.each([
    ["CommaToken", ","],
    ["LineCommentTrivia", "// c"],
    ["BlockCommentTrivia", "/* c */"],
    ["LineBreakTrivia", "\n"],
    ["Trivia", " "],
    ["EOF", ""],
  ] as const)("%s matches jsonc-parser's scanner", (name, text) => {
    expect(JSONC_TOKENS[name]).toBe(first(text));
  });
});

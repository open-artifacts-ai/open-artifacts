import { type ParseError, parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { removeOpencodeMcp, removePlugin, upsertPlugin } from "../src/index.ts";

const valid = (text: string) => {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0;
};
const commentsOf = (t: string) =>
  (t.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g) ?? []).filter(
    (c) => !c.includes("OURS"),
  );

// Our entry at every position, with comments of both kinds on every side.
describe("removeAt fuzz", () => {
  const C = ["", " /* b1 */", " // l1\n", "\n  // l2\n", " /* b2 */\n"];
  const cases: string[] = [];
  for (const nl of ["\n", "\r\n"])
    for (const pos of ["only", "first", "middle", "last"])
      for (const a of C)
        for (const b of C)
          for (const tc of ["", ","]) {
            const ours = `${a}"oa_bus": {"OURS": 1}${b}`;
            const u1 = `"a": 1 /* ca */`;
            const u2 = `// cb\n  "b": 2`;
            const members =
              pos === "only"
                ? [ours]
                : pos === "first"
                  ? [ours, u1]
                  : pos === "middle"
                    ? [u1, ours, u2]
                    : [u1, ours];
            let body = `{\n  ${members.join(",\n  ")}${tc}\n}`;
            body = `{\n "mcp": {\n "servers": ${body}\n }\n}\n`;
            if (nl === "\r\n") body = body.replace(/\n/g, "\r\n");
            if (valid(body)) cases.push(body);
          }
  it.each(cases.map((c) => [JSON.stringify(c), c]))("%s", (_n, text) => {
    const out = removeOpencodeMcp(text as string, "oa_bus");
    expect(valid(out)).toBe(true);
    expect(commentsOf(out)).toEqual(commentsOf(text as string));
    const want = parse(text as string);
    delete want.mcp.servers.oa-bus;
    expect(parse(out)).toEqual(want);
  });
});

describe("plugins arrays", () => {
  it("removes ours from the middle of a commented array, keeping comments", () => {
    const text =
      '{\n  "plugins": [\n    "a", // A\n    "/p/oa_bus", /* ours */\n    // C\n    "c"\n  ]\n}\n';
    const out = removePlugin(text, "/p/oa_bus");
    expect(parse(out).plugins).toEqual(["a", "c"]);
    for (const c of ["// A", "// C"]) expect(out).toContain(c);
  });
  it("duplicate registrations are all removed", () => {
    const t = upsertPlugin(
      '{"plugins": ["/p/oa_bus", "x", {"package": "/p/oa_bus"}]}',
      "/q",
    );
    expect(parse(removePlugin(t, "/p/oa_bus")).plugins).toEqual(["x", "/q"]);
  });
});

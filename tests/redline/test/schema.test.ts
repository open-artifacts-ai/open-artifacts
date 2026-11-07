import { describe, expect, it } from "vitest";
import { parseSchema, schemaAhead } from "../src/schema.ts";

const TEMPLATE = `{
  "d1_databases": [{ "migrations_dir": "migrations" }],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["A"] },
    { "tag": "v2", "new_sqlite_classes": ["B"] }
  ]
}`;

describe("parseSchema", () => {
  it("reads migration files from paths and the DO tags of the template", () => {
    expect(
      parseSchema(
        [
          "apps/server/migrations/0002_b.sql",
          "apps/server/migrations/0001_a.sql",
          "apps/server/migrations/README.md",
        ],
        TEMPLATE,
      ),
    ).toEqual({ d1: ["0001_a.sql", "0002_b.sql"], doTags: ["v1", "v2"] });
  });

  it("a template without migrations has no tags", () => {
    expect(parseSchema([], "{}").doTags).toEqual([]);
  });
});

describe("schemaAhead", () => {
  const base = { d1: ["0001_a.sql"], doTags: ["v1"] };
  it("is empty when the tag adds nothing", () => {
    expect(schemaAhead(base, base)).toEqual([]);
  });
  it("names a D1 file and a DO tag the target lacks", () => {
    expect(
      schemaAhead(
        { d1: ["0001_a.sql", "0002_b.sql"], doTags: ["v1", "v2"] },
        base,
      ),
    ).toEqual(["D1 0002_b.sql", "DO v2"]);
  });
  it("ignores what only the target has", () => {
    expect(
      schemaAhead(base, {
        d1: ["0001_a.sql", "0002_b.sql"],
        doTags: ["v1", "v2"],
      }),
    ).toEqual([]);
  });
});

describe("gitSchemaOf", () => {
  it("refuses a version that isn't a release number", async () => {
    const { gitSchemaOf } = await import("../src/schema.ts");
    await expect(gitSchemaOf("0.1.0 --upload-pack=x")).rejects.toThrow(
      /not a release version/,
    );
  });

  // vitest runs from tests/redline, the directory CI runs the suite from.
  it("lists a tag's migrations when run from tests/redline", async () => {
    const { gitSchemaOf } = await import("../src/schema.ts");
    const schema = await gitSchemaOf("0.133.0");
    expect(schema.d1.length).toBeGreaterThan(0);
    expect(schema.d1).toContain("0026_comments_setting.sql");
  });

  it("reports a migration a newer tag has over an older one", async () => {
    const { gitSchemaOf } = await import("../src/schema.ts");
    // Sequential: concurrent fetches in a shallow clone collide on shallow.lock.
    const older = await gitSchemaOf("0.132.1");
    const newer = await gitSchemaOf("0.133.0");
    expect(schemaAhead(newer, older)).toContain("D1 0026_comments_setting.sql");
  });
});

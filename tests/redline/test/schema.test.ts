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
});

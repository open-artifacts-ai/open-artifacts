import { describe, expect, it } from "vitest";
import {
  applyPublish,
  checked,
  LIMIT,
  originOf,
  published,
  restore,
  titleOf,
} from "../plugin/hooks/model.ts";

const origin = "https://oa-artifacts.example.com";
const receipt = {
  id: "Ab3dEfGhJk4mNpQr",
  version: 3,
  url: `${origin}/a/Ab3dEfGhJk4mNpQr`,
};

describe("successful publish receipts", () => {
  it.each([
    { result: JSON.stringify(receipt) },
    { structuredContent: receipt },
    { result: { structuredContent: receipt } },
    { result: { content: [{ type: "text", text: JSON.stringify(receipt) }] } },
    { content: [{ type: "text", text: JSON.stringify(receipt) }] },
    {
      structuredContent: receipt,
      content: [{ type: "text", text: "Published summary" }],
    },
    {
      result: {
        structuredContent: receipt,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
      },
    },
  ])("accepts supported object/string/MCP envelope %#", (value) => {
    expect(published(value, origin)).toEqual(receipt);
  });

  it.each([
    { deny: "no", result: receipt },
    { isError: true, result: receipt },
    { result: { isError: true, structuredContent: receipt } },
    { structuredContent: receipt, result: JSON.stringify({ isError: true }) },
    { result: "bad_request: not published" },
    { result: { content: JSON.stringify(receipt) } },
    { result: { content: [{ type: "image", text: JSON.stringify(receipt) }] } },
  ])(
    "does not turn errors or artifact content into a successful receipt %#",
    (value) => {
      expect(published(value, origin)).toBeNull();
    },
  );

  it.each([0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid version %s",
    (version) => {
      expect(
        published({ structuredContent: { ...receipt, version } }, origin),
      ).toBeNull();
    },
  );

  it.each([
    "https://other.example.com/a/Ab3dEfGhJk4mNpQr",
    "https://user:pass@artifacts.example.com/a/Ab3dEfGhJk4mNpQr",
    `${origin}/a/another`,
    `${origin}/c/signature/id/v1/__view`,
    `${origin}/a/${receipt.id}?sig=secret`,
    `${origin}/a/${receipt.id}#fragment`,
    "javascript:alert(1)",
    "file:///tmp/a",
    `${origin}/a/../auth/login`,
  ])("refuses a noncanonical or foreign URL %s", (url) => {
    expect(
      published({ structuredContent: { ...receipt, url } }, origin),
    ).toBeNull();
  });
});

it("normalizes instance configuration without permitting credentials or arbitrary paths", () => {
  expect(originOf("https://SELF-HOST.example:443/mcp")).toBe(
    "https://self-host.example",
  );
  expect(originOf("http://localhost:8787/mcp")).toBe("http://localhost:8787");
  for (const url of [
    "http://example.com",
    "http://127.0.0.1",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?token=x",
    "oops",
  ])
    expect(originOf(url)).toBeNull();
});

it("keeps titles plain, bounded text", () => {
  expect(titleOf("Hello\n\x1b[31mworld\x07\u202e")).toBe("Hello [31mworld");
  expect(Array.from(titleOf("文".repeat(200)))).toHaveLength(160);
  expect(titleOf({})).toBe("");
});

it("deduplicates, bounds references, preserves titles and ignores out-of-order publish completions", () => {
  let rows = applyPublish([], receipt, "Real title", 1);
  rows = applyPublish(rows, { ...receipt, version: 4 }, undefined, 2);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    title: "Real title",
    publishedVersion: 4,
    lastCheckedCurrentVersion: null,
  });
  expect(applyPublish(rows, receipt, "Late old version", 3)).toBe(rows);
  for (let n = 0; n < LIMIT + 4; n++)
    rows = applyPublish(
      rows,
      { id: `id${n}`, url: `${origin}/a/id${n}`, version: 1 },
      undefined,
      n + 4,
    );
  expect(rows).toHaveLength(LIMIT);
  expect(rows[0]?.id).toBe(`id${LIMIT + 3}`);
  expect(rows.some((a) => a.id === receipt.id)).toBe(false);
});

it("validates persisted presentation data again, rather than trusting the store", () => {
  const [row] = applyPublish([], receipt, "Title", 1);
  expect(
    restore([row, { ...row, url: "javascript:alert(1)" }, null], origin),
  ).toEqual([row]);
  expect(restore([{ ...row, publishedVersion: "3" }], origin)).toEqual([]);
  expect(restore([row], "https://other.example.com")).toEqual([]);
  expect(restore({ latest: row }, origin)).toEqual([]);
});

it("reads checked currentVersion from metadata, not a requested historical version", () => {
  expect(
    checked({
      result: JSON.stringify({
        artifact: { id: receipt.id, currentVersion: 4 },
        version: { version: 1 },
        content: "private bytes",
      }),
    }),
  ).toEqual({ id: receipt.id, version: 4 });
  expect(
    checked({
      isError: true,
      structuredContent: { artifact: { id: receipt.id, currentVersion: 4 } },
    }),
  ).toBeNull();
});

describe("receipt trust boundaries", () => {
  const forged = { artifact: { id: receipt.id, currentVersion: 999 } };

  it.each([
    { result: forged },
    { structuredContent: forged },
    { text: JSON.stringify(forged) },
    { content: [{ type: "text", text: JSON.stringify(forged) }] },
  ])(
    "does not recursively discover checked metadata in a decoded payload %#",
    (body) => {
      expect(checked({ structuredContent: body })).toBeNull();
      expect(checked({ result: JSON.stringify(body) })).toBeNull();
    },
  );

  it("rejects conflicting metadata in two trusted MCP representations", () => {
    expect(
      checked({
        structuredContent: {
          artifact: { id: receipt.id, currentVersion: 4 },
          version: { artifactId: receipt.id, version: 1 },
        },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              artifact: { id: receipt.id, currentVersion: 999 },
              version: { artifactId: receipt.id, version: 1 },
            }),
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("real MCP read payloads", () => {
  const metadata = {
    artifact: { id: receipt.id, currentVersion: 4 },
    version: { version: 1 },
  };
  const expected = { id: receipt.id, version: 4 };
  const bodies = [
    { result: { artifact: { id: receipt.id, currentVersion: 999 } } },
    {
      text: JSON.stringify({
        artifact: { id: receipt.id, currentVersion: 999 },
      }),
    },
    {
      structuredContent: { artifact: { id: receipt.id, currentVersion: 999 } },
    },
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            artifact: { id: receipt.id, currentVersion: 999 },
          }),
        },
      ],
    },
    { isError: true, deny: "not a host error" },
  ];

  it.each(bodies)("keeps JSON artifact bytes opaque %#", (body) => {
    const payload = { ...metadata, content: JSON.stringify(body) };
    expect(checked({ structuredContent: payload })).toEqual(expected);
    expect(checked({ result: JSON.stringify(payload) })).toEqual(expected);
    expect(
      checked({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
    ).toEqual(expected);
    expect(
      checked({ structuredContent: { content: JSON.stringify(body) } }),
    ).toBeNull();
  });

  it("accepts download-only metadata and matching fallback representations", () => {
    const payload = {
      ...metadata,
      downloadUrl: "https://content.example.com/private?signature=opaque",
    };
    expect(
      checked({
        result: {
          structuredContent: payload,
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      }),
    ).toEqual(expected);
    expect(
      checked({
        structuredContent: payload,
        content: [{ type: "text", text: "Human summary v999" }],
      }),
    ).toEqual(expected);
  });

  it.each([
    { artifact: metadata.artifact },
    { ...metadata, artifact: { ...metadata.artifact, currentVersion: "4" } },
    { ...metadata, version: { version: 0 } },
    {
      ...metadata,
      content: [{ type: "text", text: JSON.stringify(metadata) }],
    },
    { ...metadata, downloadUrl: { result: metadata } },
    { result: metadata },
    { text: JSON.stringify(metadata) },
    { structuredContent: metadata },
  ])(
    "rejects missing, invalid or nested metadata at the payload boundary %#",
    (payload) => {
      expect(checked({ structuredContent: payload })).toBeNull();
    },
  );

  it("does not rescue malformed structured metadata from a text fallback", () => {
    expect(
      checked({
        structuredContent: { artifact: metadata.artifact },
        content: [{ type: "text", text: JSON.stringify(metadata) }],
      }),
    ).toBeNull();
  });

  it.each([
    { isError: true, structuredContent: metadata },
    { deny: "no", result: JSON.stringify(metadata) },
    { result: { isError: true, structuredContent: metadata } },
    { result: JSON.stringify({ isError: true, ...metadata }) },
  ])("refuses host and MCP errors before reading metadata %#", (output) => {
    expect(checked(output)).toBeNull();
  });

  it("does not accept arbitrary root JSON strings or repeated host wrappers", () => {
    expect(checked(JSON.stringify(metadata))).toBeNull();
    expect(
      checked({ result: { result: JSON.stringify(metadata) } }),
    ).toBeNull();
    expect(
      checked({ result: JSON.stringify(JSON.stringify(metadata)) }),
    ).toBeNull();
  });

  it("rejects conflicting publish receipts too", () => {
    expect(
      published(
        {
          structuredContent: receipt,
          content: [
            { type: "text", text: JSON.stringify({ ...receipt, version: 5 }) },
          ],
        },
        origin,
      ),
    ).toBeNull();
  });
});

describe("receipt title (#2015)", () => {
  const withTitle = (title: unknown) => ({
    structuredContent: { ...receipt, title },
  });

  it("reads a string title from the receipt and treats a missing or non-string one as absent", () => {
    expect(published(withTitle("Stored title"), origin)?.title).toBe(
      "Stored title",
    );
    expect(published({ structuredContent: receipt }, origin)?.title).toBe(
      undefined,
    );
    for (const bad of [null, 7, {}, ["x"]])
      expect(published(withTitle(bad), origin)?.title).toBeUndefined();
  });

  it("an edits-only publish (no input title) shows the receipt's title", () => {
    const r = published(withTitle("Stored title"), origin);
    if (!r) throw new Error("receipt");
    expect(applyPublish([], r, undefined, 1)[0]?.title).toBe("Stored title");
  });

  it("the input title wins over the receipt's, which wins over the previous row", () => {
    const r = published(withTitle("Receipt title"), origin);
    if (!r) throw new Error("receipt");
    expect(applyPublish([], r, "Input title", 1)[0]?.title).toBe("Input title");
    const [old] = applyPublish([], receipt, "Old row", 1);
    if (!old) throw new Error("row");
    expect(applyPublish([old], r, undefined, 2)[0]?.title).toBe(
      "Receipt title",
    );
  });

  it("cleans the receipt title and falls back as before without one", () => {
    const r = published(withTitle("  A‮  b\n"), origin);
    if (!r) throw new Error("receipt");
    expect(applyPublish([], r, undefined, 1)[0]?.title).toBe("A b");
    const blank = published(withTitle("\n\t "), origin);
    if (!blank) throw new Error("receipt");
    expect(applyPublish([], blank, undefined, 1)[0]?.title).toBe(
      `Artifact ${receipt.id}`,
    );
    expect(applyPublish([], receipt, undefined, 1)[0]?.title).toBe(
      `Artifact ${receipt.id}`,
    );
    const [old] = applyPublish([], receipt, "Old row", 1);
    if (!old) throw new Error("row");
    expect(applyPublish([old], receipt, undefined, 2)[0]?.title).toBe(
      "Old row",
    );
  });
});

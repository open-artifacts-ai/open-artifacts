import { describe, expect, it } from "vitest";
import {
  DIFF_MAX_BYTES,
  FIND_MAX_BYTES,
  findInText,
  htmlToText,
  unifiedDiff,
} from "../src/services/page-text.js";

// #3165: unit tests for HTML text view, block search, and unified line diff.

describe("htmlToText", () => {
  it("keeps headings, list items, table rows, and links while dropping head, style, script, and comments", () => {
    const html = `<!doctype html>
<html>
<head>
  <title>Hidden Title</title>
  <style>
    body { color: #111; background: #fff; }
    .badge { display: inline-block; }
  </style>
</head>
<body>
  <!-- internal build comment -->
  <h1>Release Status</h1>
  <p>Updated at <strong>04:00 UTC</strong>. See <a href="https://example.com/ops?a=1&amp;b=2">Ops <b>Runbook</b></a>.</p>
  <h2>Open Items</h2>
  <table>
    <thead><tr><th>Service</th><th>Owner</th><th>Link</th></tr></thead>
    <tbody>
      <tr><td>API</td><td>Alice</td><td><a href="https://status.example.com/api">Logs</a></td></tr>
      <tr><td>Billing</td><td>Bob</td><td><a href="#local">Local</a></td></tr>
    </tbody>
  </table>
  <h3>Notes</h3>
  <ul>
    <li>  First   item   with   extra   spaces  </li>
    <li>Second item &amp; follow-up</li>
  </ul>
  <noscript>Enable JS</noscript>
  <template><p>Template text</p></template>
  <script>const secret = "do-not-show";</script>
</body>
</html>`;

    const out = htmlToText(html);
    expect(out).toBe(
      [
        "# Release Status",
        "Updated at 04:00 UTC. See Ops Runbook (https://example.com/ops?a=1&b=2).",
        "## Open Items",
        "Service | Owner | Link",
        "API | Alice | Logs (https://status.example.com/api)",
        "Billing | Bob | Local",
        "### Notes",
        "- First item with extra spaces",
        "- Second item & follow-up",
      ].join("\n"),
    );
  });

  it("handles quoted > in attributes, javascript links, and identical link text/href", () => {
    const html = `<p title="a > b"><a href="javascript:alert(1)">Click</a> and <a href="https://oa.test">https://oa.test</a></p>`;
    expect(htmlToText(html)).toBe("Click and https://oa.test");
  });
});

describe("findInText", () => {
  const sample = [
    "# Overview",
    "Line one",
    "Line two with Alpha",
    "Line three",
    "Line four",
    "Line five",
    "Line six with alpha again",
    "Line seven",
  ].join("\n");

  it("returns matching blocks with 1 block of context and ... separators", () => {
    const res = findInText(sample, "ALPHA");
    expect(res.matches).toBe(2);
    expect(res.content).toBe(
      [
        "Line one",
        "Line two with Alpha",
        "Line three",
        "...",
        "Line five",
        "Line six with alpha again",
        "Line seven",
      ].join("\n"),
    );
  });

  it("merges overlapping or adjacent context windows without ...", () => {
    const text = ["a", "hit1", "mid", "hit2", "b"].join("\n");
    const res = findInText(text, "hit");
    expect(res.matches).toBe(2);
    expect(res.content).toBe(text);
    expect(res.content).not.toContain("...");
  });

  it("returns empty string and 0 matches when nothing matches", () => {
    expect(findInText(sample, "missing")).toEqual({ content: "", matches: 0 });
  });

  it("caps output at 4 KB with a truncation note", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `row-${i}: needle ${"x".repeat(60)}`,
    ).join("\n");
    const res = findInText(lines, "needle");
    expect(res.matches).toBe(200);
    expect(
      new TextEncoder().encode(res.content).byteLength,
    ).toBeLessThanOrEqual(FIND_MAX_BYTES);
    expect(res.content).toContain("truncated at 4 KB");
  });
});

describe("unifiedDiff", () => {
  it("returns empty string when identical", () => {
    expect(unifiedDiff("a\nb\nc", "a\nb\nc", 1, 2)).toBe("");
  });

  it("produces unified diff hunks for edits", () => {
    const oldText = ["line 1", "line 2", "old line 3", "line 4", "line 5"].join(
      "\n",
    );
    const newText = ["line 1", "line 2", "new line 3", "line 4", "line 5"].join(
      "\n",
    );
    const diff = unifiedDiff(oldText, newText, 1, 2);
    expect(diff).toContain("--- v1");
    expect(diff).toContain("+++ v2");
    expect(diff).toContain("@@ -1,5 +1,5 @@");
    expect(diff).toContain("-old line 3");
    expect(diff).toContain("+new line 3");
  });

  it("caps output at 8 KB with a truncation note", () => {
    const oldText = Array.from(
      { length: 300 },
      (_, i) => `old-line-${i} ${"a".repeat(50)}`,
    ).join("\n");
    const newText = Array.from(
      { length: 300 },
      (_, i) => `new-line-${i} ${"b".repeat(50)}`,
    ).join("\n");
    const diff = unifiedDiff(oldText, newText, 1, 2);
    expect(new TextEncoder().encode(diff).byteLength).toBeLessThanOrEqual(
      DIFF_MAX_BYTES,
    );
    expect(diff).toContain("truncated at 8 KB");
  });
});

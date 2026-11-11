import { describe, expect, it } from "vitest";
import {
  docToMarkdown,
  type ImportChangeKind,
  markdownToDoc,
} from "../src/index.ts";

// Markdown outside the content set: what it becomes, and what the report says.
const CASES: {
  name: string;
  md: string;
  out: string;
  kinds: ImportChangeKind[];
  lines?: (number | null)[];
}[] = [
  {
    name: "html block",
    md: "<div>\n  <b>x</b>\n</div>\n",
    out: "\\<div>\n\n\\<b>x\\</b>\n\n\\</div>\n",
    kinds: ["html"],
    lines: [1],
  },
  {
    name: "inline html",
    md: "a <span>b</span> c\n",
    out: "a \\<span>b\\</span> c\n",
    kinds: ["html", "html"],
  },
  {
    name: "image",
    md: 'See ![a cat](cat.png "Cat")\n',
    out: 'See !\\[a cat\\](cat.png "Cat")\n',
    kinds: ["image"],
  },
  {
    name: "table",
    md: "Before\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n",
    out: "Before\n\n| a | b |\n\n| :--- | ---: |\n\n| 1 | 2 |\n",
    kinds: ["table"],
    lines: [3],
  },
  {
    name: "footnote",
    md: "Note[^1]\n\n[^1]: The note\n    continues\n",
    out: "Note\\[^1\\]\n\n\\[^1\\]: The note\n\ncontinues\n",
    kinds: ["footnote"],
    lines: [3],
  },
  {
    name: "heading 4 to 6",
    md: "#### Four\n\n###### Six\n",
    out: "Four\n\nSix\n",
    kinds: ["heading_level", "heading_level"],
  },
  {
    name: "hard break",
    md: "line one  \nline two\\\nline three\n",
    out: "line one line two line three\n",
    kinds: ["hard_break", "hard_break"],
    lines: [1, 1],
  },
  {
    name: "mixed task list",
    md: "- [ ] task\n- plain\n",
    out: "- \\[ \\] task\n- plain\n",
    kinds: ["mixed_task_list"],
  },
  {
    name: "html inside a quote and a list",
    md: "> <div>q</div>\n\n- <br>\n",
    out: "> \\<div>q\\</div>\n\n- \\<br>\n",
    kinds: ["html", "html"],
    lines: [1, 3],
  },
];

// Markdown the content set holds, written differently: no report, one form.
const NORMALIZED: { name: string; md: string; out: string }[] = [
  {
    name: "setext headings",
    md: "One\n===\n\nTwo\n---\n",
    out: "# One\n\n## Two\n",
  },
  { name: "star bullets", md: "* a\n* b\n", out: "- a\n- b\n" },
  { name: "plus bullets", md: "+ a\n", out: "- a\n" },
  { name: "paren ordered", md: "1) a\n2) b\n", out: "1. a\n2. b\n" },
  { name: "indented code", md: "    code\n", out: "```\ncode\n```\n" },
  { name: "tilde fence", md: "~~~py\nx\n~~~\n", out: "```py\nx\n```\n" },
  { name: "soft breaks", md: "one\ntwo\n", out: "one two\n" },
  { name: "underscores", md: "_it_ __bold__\n", out: "*it* **bold**\n" },
  { name: "star rule", md: "a\n\n***\n", out: "a\n\n---\n" },
  { name: "loose list", md: "- a\n\n- b\n", out: "- a\n- b\n" },
  {
    name: "reference link",
    md: "[x][r]\n\n[r]: https://e.example\n",
    out: "[x](https://e.example)\n",
  },
  { name: "entity", md: "&copy; &amp;\n", out: "© &\n" },
  { name: "uppercase task", md: "- [X] done\n", out: "- [x] done\n" },
  { name: "CRLF", md: "a\r\n\r\nb\r\n", out: "a\n\nb\n" },
];

describe("import of unsupported Markdown", () => {
  for (const c of CASES) {
    it(`${c.name}: becomes plain text and is reported`, () => {
      const { doc, changes } = markdownToDoc(c.md);
      expect(changes.map((x) => x.kind)).toEqual(c.kinds);
      if (c.lines) expect(changes.map((x) => x.line)).toEqual(c.lines);
      const out = docToMarkdown(doc);
      expect(out).toBe(c.out);
      // The result is stable and imports with nothing left to report.
      const again = markdownToDoc(out);
      expect(again.changes).toEqual([]);
      expect(docToMarkdown(again.doc)).toBe(out);
    });
  }

  it("keeps each change's source text, shortened", () => {
    const long = `<p>${"x".repeat(200)}</p>`;
    const [change] = markdownToDoc(`${long}\n`).changes;
    expect(change.kind).toBe("html");
    expect(change.text.length).toBe(80);
    expect(change.text.startsWith("<p>xxx")).toBe(true);
  });
});

describe("normalized Markdown", () => {
  for (const c of NORMALIZED) {
    it(`${c.name}: no report, canonical output`, () => {
      const { doc, changes } = markdownToDoc(c.md);
      expect(changes).toEqual([]);
      expect(docToMarkdown(doc)).toBe(c.out);
    });
  }
});

describe("any input", () => {
  const ODD = [
    "[",
    "```",
    "> ",
    "- ",
    "- [ ]",
    "1.",
    "| a |\n|---|",
    "<!-- c -->",
    "[^x]:",
    "***bold italic***",
    "**unclosed",
    "\u0000\uFFFD",
    "#".repeat(10),
    "  \n\t\n",
    "- a\n  > b\n    ```\n    c",
  ];
  for (const md of ODD) {
    it(`imports ${JSON.stringify(md)} and settles after one pass`, () => {
      const first = docToMarkdown(markdownToDoc(md).doc);
      const second = markdownToDoc(first);
      expect(second.changes).toEqual([]);
      expect(docToMarkdown(second.doc)).toBe(first);
    });
  }
});

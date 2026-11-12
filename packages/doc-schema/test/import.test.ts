import { Schema } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  docFromJSON,
  docSchema,
  docToMarkdown,
  docToYXmlFragment,
  type ImportChangeKind,
  isAllowedHref,
  isAllowedTitle,
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
    name: "relative link",
    md: "[x](docs/a.md)\n",
    out: "x\n",
    kinds: ["link"],
  },
  { name: "fragment link", md: "[x](#top)\n", out: "x\n", kinds: ["link"] },
  { name: "empty link", md: "[x]()\n", out: "x\n", kinds: ["link"] },
  {
    name: "ftp link",
    md: "[x](ftp://e.example/f)\n",
    out: "x\n",
    kinds: ["link"],
  },
  {
    name: "javascript link",
    md: "[x](javascript:alert(1))\n",
    out: "x\n",
    kinds: ["link"],
  },
  {
    name: "data link",
    md: "[x](data:text/html,hi)\n",
    out: "x\n",
    kinds: ["link"],
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
  {
    name: "mailto link",
    md: "[x](mailto:a@e.example)\n",
    out: "[x](mailto:a@e.example)\n",
  },
  {
    name: "https link",
    md: "[x](https://e.example)\n",
    out: "[x](https://e.example)\n",
  },
  {
    name: "uppercase scheme",
    md: "[x](HTTPS://e.example)\n",
    out: "[x](HTTPS://e.example)\n",
  },
  {
    name: "autolink",
    md: "<https://e.example>\n",
    out: "<https://e.example>\n",
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

describe("link hrefs", () => {
  it("allows only http, https and mailto, case-insensitively", () => {
    for (const ok of ["http://a", "https://a", "HTTPS://a", "mailto:a@b"])
      expect(isAllowedHref(ok)).toBe(true);
    for (const bad of [
      "javascript:x",
      "JavaScript:x",
      "data:x",
      "#x",
      "a/b",
      "",
      " https://a",
    ])
      expect(isAllowedHref(bad)).toBe(false);
    expect(isAllowedHref(undefined)).toBe(false);
  });

  it("refuses to create a link mark with a disallowed href", () => {
    expect(() =>
      docSchema.marks.link.create({ href: "javascript:alert(1)" }),
    ).toThrow();
    expect(() =>
      docSchema.marks.link.create({ href: "https://e.example" }),
    ).not.toThrow();
  });

  it("rejects a doc JSON with a javascript: link", () => {
    expect(() =>
      docFromJSON({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", attrs: { href: "javascript:x" } }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps the text of a link it drops, between other marks", () => {
    const r = markdownToDoc("a [**b**](docs/x) c\n");
    expect(r.changes.map((c) => c.kind)).toEqual(["link"]);
    expect(docToMarkdown(r.doc)).toBe("a **b** c\n");
  });
});

describe("hostile link attributes", () => {
  const badHrefs = [
    "https://a\n\n<script>alert(1)</script>",
    "https://a b",
    "https://a<b",
    'https://a"b',
    "https://a`b",
    "mailto:a@b\u0000",
  ];
  const badTitles: unknown[] = [
    'x"\n\n<img src=x onerror=alert(1)>',
    { x: 1 },
    "a\nb",
    5,
  ];
  const json = (attrs: object) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "x", marks: [{ type: "link", attrs }] },
        ],
      },
    ],
  });
  for (const href of badHrefs) {
    it(`refuses href ${JSON.stringify(href)}`, () => {
      expect(() => docFromJSON(json({ href }) as never)).toThrow();
      expect(() => docSchema.marks.link.create({ href })).toThrow();
    });
  }
  for (const title of badTitles) {
    it(`refuses title ${JSON.stringify(title)}`, () => {
      expect(() =>
        docFromJSON(json({ href: "https://a", title }) as never),
      ).toThrow();
      expect(() =>
        docSchema.marks.link.create({ href: "https://a", title }),
      ).toThrow();
    });
  }
  it("refuses a trailing backslash in an href", () => {
    expect(isAllowedHref("https://a\\")).toBe(false);
    expect(() =>
      docSchema.marks.link.create({ href: "https://a\\" }),
    ).toThrow();
  });

  it("round-trips a Markdown href with a backslash", () => {
    const r = markdownToDoc("[click](<https://a\\>)\n");
    const out = docToMarkdown(r.doc);
    const again = markdownToDoc(out);
    expect(again.changes).toEqual([]);
    expect(docToMarkdown(again.doc)).toBe(out);
  });

  it("keeps a link with a quote in its title as plain text", () => {
    const r = markdownToDoc('[x](https://a "t\\"q")\n');
    expect(r.changes.map((c) => c.kind)).toEqual(["link"]);
    expect(docToMarkdown(r.doc)).toBe("x\n");
  });

  it("percent-encodes odd characters, so no raw HTML comes out", () => {
    for (const md of [
      "[x](<https://a b>)\n",
      "[x](https://a`b)\n",
      "[x](https://a<b)\n",
    ]) {
      const out = docToMarkdown(markdownToDoc(md).doc);
      expect(out).not.toMatch(/[ `<]\S*\)/);
      expect(markdownToDoc(out).changes).toEqual([]);
    }
  });
});

describe("foreign schemas and code languages", () => {
  const permissive = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "text*" },
      text: {},
    },
    marks: { link: { attrs: { href: {}, title: { default: null } } } },
  });
  const bad = permissive.node("doc", null, [
    permissive.node("paragraph", null, [
      permissive.text("x", [
        permissive.marks.link.create({ href: "javascript:alert(1)" }),
      ]),
    ]),
  ]);
  const good = permissive.node("doc", null, [
    permissive.node("paragraph", null, [
      permissive.text("x", [
        permissive.marks.link.create({ href: "https://e.example" }),
      ]),
    ]),
  ]);

  it("re-validates a node from another schema", () => {
    expect(() => docToMarkdown(bad)).toThrow();
    expect(() =>
      docToYXmlFragment(bad, new Y.Doc().getXmlFragment("d")),
    ).toThrow();
    expect(docToMarkdown(good)).toBe("[x](https://e.example)\n");
    expect(() =>
      docToYXmlFragment(good, new Y.Doc().getXmlFragment("d")),
    ).not.toThrow();
  });

  it("re-validates a foreign mark on a docSchema node, and refuses a non-doc root", () => {
    // ProseMirror lets a docSchema paragraph carry another schema's mark.
    const mixed = docSchema.node("doc", null, [
      docSchema.node("paragraph", null, [
        docSchema.text("x", [
          permissive.marks.link.create({ href: "javascript:x" }),
        ]),
      ]),
    ]);
    expect(() => docToMarkdown(mixed)).toThrow();
    expect(() =>
      docToYXmlFragment(mixed, new Y.Doc().getXmlFragment("d")),
    ).toThrow();
    const para = docSchema.node("paragraph", null, [docSchema.text("x")]);
    expect(() => docToMarkdown(para)).toThrow();
    expect(() =>
      docToYXmlFragment(para, new Y.Doc().getXmlFragment("d")),
    ).toThrow();
  });

  const codeJSON = (language: unknown, text = "a") => ({
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language },
        content: [{ type: "text", text }],
      },
    ],
  });

  it("refuses an injecting code language", () => {
    for (const language of [
      "js\n```\n<img src=x onerror=alert(1)>\n\n```js",
      "a b",
      "`x",
      5,
      "x".repeat(33),
    ])
      expect(() => docFromJSON(codeJSON(language) as never)).toThrow();
    expect(() => docFromJSON(codeJSON("c++") as never)).not.toThrow();
    expect(() => docFromJSON(codeJSON(null) as never)).not.toThrow();
  });

  it("round-trips code containing fences", () => {
    for (const text of ["```", "a\n```\nb\n````\nc", "~~~\nx"]) {
      const out = docToMarkdown(docFromJSON(codeJSON("ts", text) as never));
      const again = markdownToDoc(out);
      expect(again.changes).toEqual([]);
      expect(again.doc.firstChild?.textContent).toBe(text);
      expect(docToMarkdown(again.doc)).toBe(out);
    }
  });

  it("drops a fence info string that isn't a plain name", () => {
    for (const md of ["~~~a`b\ncode\n~~~\n", "```js onerror=x\ncode\n```\n"]) {
      const r = markdownToDoc(md);
      expect(r.changes.map((c) => c.kind)).toEqual(["code_language"]);
      expect(r.doc.firstChild?.textContent).toBe("code");
      const out = docToMarkdown(r.doc);
      expect(markdownToDoc(out).changes).toEqual([]);
    }
  });

  it("refuses a title ending in a backslash", () => {
    expect(isAllowedTitle("t\\")).toBe(false);
    expect(() =>
      docSchema.marks.link.create({ href: "https://a", title: "t\\" }),
    ).toThrow();
    const r = markdownToDoc('[x](https://a "t\\\\")\n');
    expect(r.changes.map((c) => c.kind)).toEqual(["link"]);
  });

  it("numbers alternating lists in one pass", () => {
    const small = "- a\n\n* b\n\n- c\n";
    expect(docToMarkdown(markdownToDoc(small).doc).match(/^[-*]/gm)).toEqual([
      "-",
      "*",
      "-",
    ]);
    const n = 5000;
    const md = Array.from(
      { length: n },
      (_, i) => `${i % 2 ? "*" : "-"} x`,
    ).join("\n\n");
    const doc = markdownToDoc(md).doc;
    const t = performance.now();
    const out = docToMarkdown(doc);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(out.match(/^[-*] x$/gm)?.length).toBe(n);
  });
});

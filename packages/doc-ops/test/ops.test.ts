import { docToMarkdown, isAllowedHref, markdownToDoc } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import { applyOpsToDoc, MAX_OPS } from "../src/index.ts";
import { edit, failure } from "./helpers.ts";

describe("replace", () => {
  it("replaces text inside a sentence", () => {
    expect(
      edit("The quick brown fox.\n", [
        { op: "replace", quote: "quick brown", with: "slow red" },
      ]),
    ).toBe("The slow red fox.\n");
  });

  it("matches visible text, not Markdown symbols", () => {
    expect(
      edit("Ship **collaborative** docs.\n", [
        { op: "replace", quote: "Ship collaborative docs", with: "Ship docs" },
      ]),
    ).toBe("Ship docs.\n");
  });

  it("keeps the marks the whole quote shared", () => {
    expect(
      edit("**The quick fox**\n", [
        { op: "replace", quote: "quick", with: "slow" },
      ]),
    ).toBe("**The slow fox**\n");
    expect(
      edit("[read the docs](https://x.test) now\n", [
        { op: "replace", quote: "the docs", with: "the guide" },
      ]),
    ).toBe("[read the guide](https://x.test) now\n");
  });

  it("applies inline Markdown in the replacement", () => {
    expect(
      edit("A plain word.\n", [
        { op: "replace", quote: "plain", with: "*fancy* `code`" },
      ]),
    ).toBe("A *fancy* `code` word.\n");
  });

  it("an empty replacement deletes", () => {
    expect(
      edit("Keep this. Drop this.\n", [
        { op: "replace", quote: " Drop this.", with: "" },
      ]),
    ).toBe("Keep this.\n");
  });

  it("a quote spans blocks with a line break between them", () => {
    expect(
      edit("First para ends here.\n\nSecond para starts here.\n", [
        { op: "replace", quote: "ends here.\nSecond", with: "joins the" },
      ]),
    ).toBe("First para joins the para starts here.\n");
  });

  it("a blank line in the quote matches one block break", () => {
    expect(
      edit("# Goals\n\nShip it.\n", [
        { op: "replace", quote: "Goals\n\nShip", with: "Goals: ship" },
      ]),
    ).toBe("# Goals: ship it.\n");
  });

  it("block Markdown inside a sentence splits the block", () => {
    expect(
      edit("Before the break. After the break.\n", [
        {
          op: "replace",
          quote: " ",
          with: "x",
          prefix: "break.",
          suffix: "After",
        },
      ]),
    ).toBe("Before the break.xAfter the break.\n");
    expect(
      edit("Before the break. Middle. After the break.\n", [
        { op: "replace", quote: "Middle.", with: "## Middle" },
      ]),
    ).toBe("Before the break.\n\n## Middle\n\nAfter the break.\n");
  });

  it("block Markdown over a whole block replaces it, leaving no empty lines", () => {
    expect(
      edit("Intro\n\nOld paragraph\n\nOutro\n", [
        { op: "replace", quote: "Old paragraph", with: "## New\n\nBody" },
      ]),
    ).toBe("Intro\n\n## New\n\nBody\n\nOutro\n");
  });

  it("text in a code block is literal", () => {
    expect(
      edit("```js\nlet a = 1;\n```\n", [
        { op: "replace", quote: "a = 1", with: "**b** = 2" },
      ]),
    ).toBe("```js\nlet **b** = 2;\n```\n");
  });

  it("works inside list items and quotes", () => {
    expect(
      edit("- one\n- two\n\n> quoted text\n", [
        { op: "replace", quote: "two", with: "2" },
        { op: "replace", quote: "quoted", with: "cited" },
      ]),
    ).toBe("- one\n- 2\n\n> cited text\n");
  });
});

describe("insert", () => {
  it("inline Markdown after a quote inside a sentence", () => {
    expect(
      edit("The quick fox.\n", [
        { op: "insert", after: "quick", markdown: " **brown**" },
      ]),
    ).toBe("The quick **brown** fox.\n");
  });

  it("inline Markdown before a quote inside a sentence", () => {
    expect(
      edit("The fox.\n", [{ op: "insert", before: "fox", markdown: "red " }]),
    ).toBe("The red fox.\n");
  });

  it("a paragraph after a heading", () => {
    expect(
      edit("# Goals\n\n## Risks\n", [
        { op: "insert", after: "Goals", markdown: "Ship docs." },
      ]),
    ).toBe("# Goals\n\nShip docs.\n\n## Risks\n");
  });

  it("blocks before a block", () => {
    expect(
      edit("Body\n", [
        { op: "insert", before: "Body", markdown: "# Title\n\n---" },
      ]),
    ).toBe("# Title\n\n---\n\nBody\n");
  });

  it("block Markdown after a quote inside a sentence splits the block", () => {
    expect(
      edit("One. Two.\n", [
        { op: "insert", after: "One.", markdown: "> aside" },
      ]),
    ).toBe("One.\n\n> aside\n\nTwo.\n");
  });

  it("at the start and end of the doc", () => {
    expect(
      edit("Middle\n", [
        { op: "insert", at: "start", markdown: "# Top" },
        { op: "insert", at: "end", markdown: "Bottom" },
      ]),
    ).toBe("# Top\n\nMiddle\n\nBottom\n");
  });

  it("into an empty doc replaces its one empty paragraph", () => {
    expect(
      edit("", [{ op: "insert", at: "end", markdown: "# Hello\n\nWorld" }]),
    ).toBe("# Hello\n\nWorld\n");
  });

  it("a list beside a list item adds items to that list", () => {
    expect(
      edit("- one\n- three\n", [
        { op: "insert", after: "one", markdown: "- two" },
      ]),
    ).toBe("- one\n- two\n- three\n");
    expect(
      edit("1. b\n", [{ op: "insert", before: "b", markdown: "1. a" }]),
    ).toBe("1. a\n2. b\n");
    expect(
      edit("- [ ] todo\n", [
        { op: "insert", after: "todo", markdown: "- [x] done" },
      ]),
    ).toBe("- [ ] todo\n- [x] done\n");
  });

  it("a paragraph before a list item's first line goes before the list", () => {
    expect(
      edit("- one\n- two\n", [
        { op: "insert", before: "one", markdown: "Intro" },
      ]),
    ).toBe("Intro\n\n- one\n- two\n");
  });

  it("text inside a code block is literal", () => {
    expect(
      edit("```\nab\n```\n", [{ op: "insert", after: "a", markdown: "*x*" }]),
    ).toBe("```\na*x*b\n```\n");
  });
});

describe("delete", () => {
  it("deletes text inside a sentence", () => {
    expect(
      edit("Keep this, not this.\n", [{ op: "delete", quote: ", not this" }]),
    ).toBe("Keep this.\n");
  });

  it("deletes whole blocks without leaving empty ones", () => {
    expect(edit("A\n\nB\n\nC\n", [{ op: "delete", quote: "B" }])).toBe(
      "A\n\nC\n",
    );
    expect(edit("A\n\nB\n\nC\n", [{ op: "delete", quote: "A\nB" }])).toBe(
      "C\n",
    );
  });

  it("joins the blocks a partial cross-block quote leaves", () => {
    expect(
      edit("Alpha one\n\nBeta two\n", [{ op: "delete", quote: "one\nBeta " }]),
    ).toBe("Alpha two\n");
  });

  it("deleting everything leaves an empty doc", () => {
    expect(
      edit("Only\n\nText\n", [{ op: "delete", quote: "Only\nText" }]),
    ).toBe("");
  });

  it("deleting a quote's only block removes the quote too", () => {
    expect(edit("A\n\n> B\n\nC\n", [{ op: "delete", quote: "B" }])).toBe(
      "A\n\nC\n",
    );
  });

  it("a quote from inside an item to the block after it", () => {
    expect(
      edit("- one\n\n  two\n\nthree\n", [
        { op: "delete", quote: "two\nthree" },
      ]),
    ).toBe("- one\n");
  });

  it("deletes a list item", () => {
    expect(
      edit("- one\n- two\n- three\n", [{ op: "delete", quote: "two" }]),
    ).toBe("- one\n- three\n");
  });
});

describe("format", () => {
  it("inline marks apply to the quoted range", () => {
    expect(
      edit("Make this bold.\n", [
        { op: "format", quote: "this", mark: "bold" },
      ]),
    ).toBe("Make **this** bold.\n");
    expect(
      edit("a b\n", [
        { op: "format", quote: "a", mark: "italic" },
        { op: "format", quote: "b", mark: "strike" },
      ]),
    ).toBe("*a* ~~b~~\n");
    expect(
      edit("see docs\n", [
        { op: "format", quote: "docs", mark: "link", href: "https://x.test" },
      ]),
    ).toBe("see [docs](https://x.test)\n");
    expect(
      edit("run npm i\n", [{ op: "format", quote: "npm i", mark: "code" }]),
    ).toBe("run `npm i`\n");
  });

  it("inline marks across blocks", () => {
    expect(
      edit("one two\n\nthree four\n", [
        { op: "format", quote: "two\nthree", mark: "bold" },
      ]),
    ).toBe("one **two**\n\n**three** four\n");
  });

  it("removes a mark", () => {
    expect(
      edit("**all bold**\n", [
        { op: "format", quote: "bold", mark: "bold", remove: true },
      ]),
    ).toBe("**all** bold\n");
  });

  it("block formats apply to every touched block", () => {
    expect(
      edit("One\n\nTwo\n\nThree\n", [
        { op: "format", quote: "ne\nTw", mark: "heading2" },
      ]),
    ).toBe("## One\n\n## Two\n\nThree\n");
    expect(
      edit("# Title\n", [{ op: "format", quote: "Tit", mark: "paragraph" }]),
    ).toBe("Title\n");
    expect(
      edit("let a\n", [{ op: "format", quote: "a", mark: "codeBlock" }]),
    ).toBe("```\nlet a\n```\n");
  });

  it("wraps blocks in a quote or a list", () => {
    expect(
      edit("A\n\nB\n\nC\n", [
        { op: "format", quote: "A\nB", mark: "blockquote" },
      ]),
    ).toBe("> A\n>\n> B\n\nC\n");
    expect(
      edit("A\n\nB\n", [{ op: "format", quote: "A\nB", mark: "bulletList" }]),
    ).toBe("- A\n- B\n");
    expect(edit("A\n", [{ op: "format", quote: "A", mark: "taskList" }])).toBe(
      "- [ ] A\n",
    );
  });

  it("changes a list's kind", () => {
    expect(
      edit("- a\n- b\n", [{ op: "format", quote: "a", mark: "orderedList" }]),
    ).toBe("1. a\n2. b\n");
    expect(
      edit("- a\n- b\n", [{ op: "format", quote: "b", mark: "taskList" }]),
    ).toBe("- [ ] a\n- [ ] b\n");
    expect(
      edit("- [x] a\n", [{ op: "format", quote: "a", mark: "bulletList" }]),
    ).toBe("- a\n");
  });

  it("a heading in the touched blocks gives its text to a list item", () => {
    expect(
      edit("# H\n\nP\n", [
        { op: "format", quote: "H\nP", mark: "orderedList" },
      ]),
    ).toBe("1. H\n2. P\n");
  });

  it("refuses a heading as a list item's first line", () => {
    expect(
      failure("- a\n", [{ op: "format", quote: "a", mark: "heading1" }]).code,
    ).toBe("invalid_op");
  });
});

describe("quotes", () => {
  it("quote_ambiguous gives the count and asks for a prefix or suffix", () => {
    const error = failure("one fish, two fish\n", [
      { op: "replace", quote: "fish", with: "cat" },
    ]);
    expect(error).toMatchObject({
      code: "quote_ambiguous",
      matches: 2,
      opIndex: 0,
    });
    expect(error.message).toMatch(/prefix/);
    expect(error.message).toMatch(/suffix/);
  });

  it("prefix and suffix pick one match", () => {
    const md = "one fish, two fish, red fish\n";
    expect(
      edit(md, [{ op: "replace", quote: "fish", with: "cat", prefix: "two " }]),
    ).toBe("one fish, two cat, red fish\n");
    expect(
      edit(md, [
        { op: "replace", quote: "fish", with: "cat", suffix: ", two" },
      ]),
    ).toBe("one cat, two fish, red fish\n");
  });

  it("a prefix may reach into the block before", () => {
    expect(
      edit("Note\n\nNote\n", [
        { op: "replace", quote: "Note", with: "Later", prefix: "Note\n" },
      ]),
    ).toBe("Note\n\nLater\n");
  });

  it("quote_not_found returns the closest current text", () => {
    const error = failure(
      "We will ship collaborative docs before shared memory.\n",
      [{ op: "delete", quote: "ship colaborative doc" }],
    );
    expect(error.code).toBe("quote_not_found");
    expect(error.closest).toBe("ship collaborative docs");
    expect(error.message).toMatch(/retry/);
  });

  it("a prefix that does not match points at the quote's real place", () => {
    const error = failure("alpha beta gamma\n", [
      { op: "delete", quote: "beta", prefix: "zeta " },
    ]);
    expect(error.code).toBe("quote_not_found");
    expect(error.closest).toBe("alpha beta gamma");
    expect(error.message).toMatch(/prefix or suffix/);
  });

  it("closest is null for an empty doc", () => {
    expect(failure("", [{ op: "delete", quote: "x" }]).closest).toBeNull();
  });

  it("regex characters in a quote are literal", () => {
    expect(
      edit("Costs $5 (approx.) [1]\n", [
        { op: "replace", quote: "$5 (approx.) [1]", with: "five" },
      ]),
    ).toBe("Costs five\n");
  });
});

describe("a call", () => {
  it("applies ops in order, each seeing the ones before", () => {
    expect(
      edit("alpha\n", [
        { op: "replace", quote: "alpha", with: "beta" },
        { op: "insert", after: "beta", markdown: "gamma" },
        { op: "format", quote: "gamma", mark: "heading1" },
      ]),
    ).toBe("beta\n\n# gamma\n");
  });

  it("all apply or none: a failing op leaves no partial result", () => {
    const doc = markdownToDoc("one two\n").doc;
    const result = applyOpsToDoc(doc, [
      { op: "replace", quote: "one", with: "1" },
      { op: "replace", quote: "three", with: "3" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.opIndex).toBe(1);
    expect(doc.textContent).toBe("one two");
  });

  it(`takes at most ${MAX_OPS} ops`, () => {
    const ops = Array.from({ length: MAX_OPS + 1 }, () => ({
      op: "insert",
      at: "end",
      markdown: "x",
    }));
    expect(failure("a\n", ops)).toMatchObject({
      code: "too_many_ops",
      maxOps: MAX_OPS,
    });
    expect(() => edit("a\n", ops.slice(0, MAX_OPS))).not.toThrow();
  });

  it("refuses malformed ops with the next step", () => {
    const cases: [unknown, RegExp][] = [
      [[], /non-empty list/],
      ["nope", /non-empty list/],
      [[null], /op field/],
      [[{ op: "move" }], /replace, insert, delete or format/],
      [[{ op: "replace", quote: "a" }], /with must be/],
      [[{ op: "delete", quote: "\n" }], /quote must be a quote/],
      [[{ op: "insert", markdown: "x" }], /exactly one of/],
      [[{ op: "insert", at: "middle", markdown: "x" }], /"start" or "end"/],
      [[{ op: "insert", after: "a", at: "end", markdown: "x" }], /exactly one/],
      [[{ op: "format", quote: "a", mark: "underline" }], /mark must be/],
      [[{ op: "format", quote: "a", mark: "link" }], /href/],
      [
        [{ op: "format", quote: "a", mark: "heading1", remove: true }],
        /inline/,
      ],
    ];
    for (const [ops, message] of cases) {
      const error = failure("a\n", ops);
      expect(error.code).toBe("invalid_op");
      expect(error.message).toMatch(message);
    }
  });

  it("reports what a Markdown import changed, by op", () => {
    const result = applyOpsToDoc(markdownToDoc("a\n").doc, [
      { op: "insert", at: "end", markdown: "#### deep" },
    ]);
    expect(result.ok && result.changes).toEqual([
      expect.objectContaining({ kind: "heading_level", opIndex: 0 }),
    ]);
  });
});

describe("link schemes", () => {
  const bad = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "java​script:alert(1)",
    "data:text/html,<b>x</b>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative",
    "//host/x",
    "#frag",
    "docs/a.md",
    "",
  ];
  it("refuses a format link with a bad href", () => {
    expect(
      failure("see docs\n", [
        { op: "format", quote: "docs", mark: "link", href: "" },
      ]).message,
    ).toBe("Op 0: href must be a non-empty string.");
    for (const href of bad.filter(Boolean)) {
      const error = failure("see docs\n", [
        { op: "format", quote: "docs", mark: "link", href },
      ]);
      expect(error.code).toBe("invalid_op");
      expect(error.message).toMatch(
        /^Op 0: A link must start with http:, https: or mailto:\./,
      );
    }
  });
  it("never leaves a bad link mark from Markdown", () => {
    for (const href of bad.filter(
      (h) =>
        h &&
        h === h.trim() &&
        !/\s/.test(h) &&
        !h.includes("\u0001") &&
        !h.includes("\u200b"),
    )) {
      for (const op of [
        { op: "replace", quote: "docs", with: `[x](<${href}>)` },
        { op: "insert", at: "end", markdown: `[x](<${href}>)` },
        { op: "insert", after: "docs", markdown: `<${href}>` },
      ]) {
        const result = applyOpsToDoc(markdownToDoc("see docs\n").doc, [op]);
        if (!result.ok) continue;
        result.doc.descendants((n) => {
          for (const m of n.marks)
            if (m.type.name === "link")
              expect(isAllowedHref(m.attrs.href)).toBe(true);
          return true;
        });
      }
    }
  });
  it("drops a Markdown link with a bad target and keeps the text", () => {
    for (const href of [
      "/relative",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      const result = applyOpsToDoc(markdownToDoc("see docs\n").doc, [
        { op: "replace", quote: "docs", with: `[x](<${href}>)` },
      ]);
      expect(result.ok && docToMarkdown(result.doc)).toBe("see x\n");
    }
  });
  it("allows http, https and mailto, any case", () => {
    for (const href of ["https://x.test", "HTTP://x.test", "mailto:a@b.test"]) {
      expect(
        edit("see docs\n", [
          { op: "format", quote: "docs", mark: "link", href },
        ]),
      ).toContain("[docs]");
    }
  });
  it("still removes a link", () => {
    expect(
      edit("see [docs](https://x.test)\n", [
        { op: "format", quote: "docs", mark: "link", remove: true },
      ]),
    ).toBe("see docs\n");
  });
});

describe("link titles and code languages", () => {
  const run = (md: string) => {
    const r = applyOpsToDoc(markdownToDoc("see docs\n").doc, [
      { op: "replace", quote: "docs", with: md },
    ]);
    return r.ok ? docToMarkdown(r.doc) : r.error.message;
  };
  it("keeps a plain title and drops a link whose title is unsafe", () => {
    expect(run('[x](https://a.test "Plain title")')).toContain("Plain title");
    expect(run('[x](https://a.test "bad\\\\title")')).toBe("see x\n");
    expect(run("[x](https://a.test 'say \"hi\"')")).toBe("see x\n");
  });
  it("keeps a plain code language and drops an unsafe one", () => {
    expect(run("```c++\nx\n```")).toContain("```c++");
    const bad = run(`\`\`\`${"a".repeat(40)}\nx\n\`\`\``);
    expect(bad).not.toContain("a".repeat(40));
    expect(bad).toContain("x");
  });
});

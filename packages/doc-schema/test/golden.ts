// Golden Markdown: each is already in the serializer's canonical form, so
// Markdown -> doc -> Markdown must return it byte for byte, with no import
// changes, and the same through a Yjs XmlFragment.
export const GOLDEN: Record<string, string> = {
  empty: "",
  paragraphs: "First paragraph.\n\nSecond paragraph, with a comma.\n",
  headings: "# Heading 1\n\n## Heading 2\n\n### Heading 3\n\nBody.\n",
  headingWithMarks: "## A **bold** and `code` heading\n",
  marks: "**bold** *italic* ~~strike~~ `code`\n",
  nestedMarks:
    "**bold *both*** and *~~struck italic~~* and *`code` in italic*\n",
  codeWithBackticks: "Use `` a`b `` here.\n",
  links:
    '[a link](https://example.com) and [titled](https://example.com/a "Title") and <https://auto.example>\n',
  linkWithMarks:
    "[`api`](https://example.com/api) and [**bold link**](https://example.com)\n",
  bulletList: "- one\n- two\n  - nested\n  - nested two\n- three\n",
  orderedList: "1. one\n2. two\n3. three\n",
  orderedListStart: " 9. nine\n10. ten\n",
  taskList: "- [ ] todo\n- [x] done\n  - [ ] nested task\n",
  taskItemWithMarks:
    "- [ ] ship **slice 1**\n- [x] read [the design](https://example.com)\n",
  listItemParagraphs: "- First\n\n  continued\n- Second\n",
  adjacentLists: "- a\n\n\n* b\n\n1. c\n\n\n1) d\n",
  quote: "> A quote.\n>\n> Second paragraph.\n",
  quoteWithBlocks: "> ## In a quote\n>\n> - item\n>\n> ```js\n> x()\n> ```\n",
  codeBlock: "```ts\nconst a = 1;\n\nconsole.log(a);\n```\n",
  codeBlockNoLanguage: "```\nplain text\n```\n",
  codeBlockWithFence: "````md\n```js\nx\n```\n````\n",
  horizontalRule: "Above\n\n---\n\nBelow\n",
  escapes:
    "Literal \\*stars\\* and \\_under\\_ and \\[brackets\\] and \\~tilde\\~ and \\<tag> and \\&amp; done\n",
  startOfLineEscapes:
    "\\# not a heading\n\n\\- not a list\n\n1\\. not a list\n\n2\\) not a list\n\n\\> not a quote\n",
  bangBeforeLink: "Wow\\![link](https://example.com)\n",
  everything:
    "# Plan\n\nIntro with **bold**, *italic*, ~~strike~~, `code` and [a link](https://example.com).\n\n## Lists\n\n- bullet\n  1. numbered\n     - [x] task\n\n> quoted\n\n---\n\n```sh\necho done\n```\n",
};

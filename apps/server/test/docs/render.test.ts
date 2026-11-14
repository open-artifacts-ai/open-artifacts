import type { DocJSON } from "@oa/doc-schema";
import { describe, expect, it } from "vitest";
import { docToHtml } from "../../src/docs/render.js";

const link = (href: unknown): DocJSON => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "click",
          marks: [{ type: "link", attrs: { href } }],
        },
      ],
    },
  ],
});
const html = (href: unknown) => docToHtml(link(href), "T");

describe("doc render links", () => {
  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    " javascript:alert(1)",
    "\tjavascript:alert(1)",
    "java\nscript:alert(1)",
    "&#106;avascript:alert(1)",
    "javascript&colon;alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:x",
    "//evil.example",
    "",
    undefined,
    42,
  ])("renders %j as plain text, no anchor", (href) => {
    const out = html(href);
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("href=");
    expect(out).toContain("<p>click</p>");
  });

  it("keeps an allowed link", () => {
    expect(html("https://example.com/a?b=1")).toContain(
      '<a href="https://example.com/a?b=1" rel="noopener noreferrer">click</a>',
    );
    expect(html("mailto:a@example.com")).toContain(
      'href="mailto:a@example.com"',
    );
  });
});

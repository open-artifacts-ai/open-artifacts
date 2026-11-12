import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MentionedText } from "../src/viewer/comments/asks";
import { Markdown } from "../src/viewer/comments/Markdown";
import {
  type Block,
  type Inline,
  parseInlineOnly,
  parseMarkdown,
} from "../src/viewer/comments/mdparse";

const ALLOWED = new Set([
  "DIV",
  "P",
  "STRONG",
  "EM",
  "CODE",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "A",
]);

function html(body: string) {
  const { container } = render(<Markdown body={body} />);
  return container;
}
const tags = (c: HTMLElement) =>
  [...c.querySelectorAll("*")].map((e) => e.tagName);
const hrefs = (c: HTMLElement) =>
  [...c.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("inline", () => {
  it("bold, italic and code", () => {
    const c = html("**b** __b2__ *i* _i2_ `c`");
    expect([...c.querySelectorAll("strong")].map((e) => e.textContent)).toEqual(
      ["b", "b2"],
    );
    expect([...c.querySelectorAll("em")].map((e) => e.textContent)).toEqual([
      "i",
      "i2",
    ]);
    expect(c.querySelector("code")?.textContent).toBe("c");
  });
  it("never italicises inside words", () => {
    const c = html("snake_case_name and foo_bar_ and 2*3*4 ok");
    expect(c.querySelector("em")).toBeTruthy(); // 2*3*4 is star emphasis
    expect(c.textContent).toContain("snake_case_name");
    expect(c.textContent).toContain("foo_bar_");
  });
  it("nests bold in italic and vice versa", () => {
    const c = html("***both*** and *a **b** c*");
    expect(c.querySelector("strong em, em strong")).toBeTruthy();
    expect(c.querySelectorAll("strong").length).toBe(2);
  });
  it("code spans are not parsed further", () => {
    const c = html("`**x** https://a.com [a](https://b.com)`");
    expect(c.querySelector("code")?.textContent).toBe(
      "**x** https://a.com [a](https://b.com)",
    );
    expect(c.querySelector("a, strong")).toBeNull();
  });
  it("leaves unclosed markers literal", () => {
    for (const s of [
      "**x",
      "*x",
      "_x",
      "`x",
      "[x](",
      "[x](https://a.com",
      "**",
    ])
      expect(html(s).textContent).toBe(s);
  });
  it("escapes", () => {
    expect(html("\\*not\\*").textContent).toBe("*not*");
  });
  it("shows entities and html literally", () => {
    const c = html("&lt;b&gt; <b>x</b> &amp;");
    expect(c.textContent).toBe("&lt;b&gt; <b>x</b> &amp;");
    expect(c.querySelector("b")).toBeNull();
  });
  it("keeps urls with underscores whole", () => {
    const c = html("see https://a.com/foo_bar_baz/x*y*z now");
    expect(hrefs(c)).toEqual(["https://a.com/foo_bar_baz/x*y*z"]);
  });
});

describe("blocks", () => {
  it("bulleted and numbered lists", () => {
    const c = html("- a\n- **b**\n\n1. x\n2. y");
    expect(c.querySelectorAll("ul > li").length).toBe(2);
    expect(c.querySelectorAll("ol > li").length).toBe(2);
    expect(c.querySelector("ul li strong")?.textContent).toBe("b");
  });
  it("a list interrupts a paragraph, a stray number does not", () => {
    expect(html("intro\n- a").querySelector("ul")).toBeTruthy();
    expect(html("in 2024\n2024. fine").querySelector("ol")).toBeNull();
  });
  it("block quotes", () => {
    const c = html("> quoted **b**\n> more");
    expect(c.querySelector("blockquote strong")?.textContent).toBe("b");
  });
  it("caps quote nesting", () => {
    const c = html(`${">".repeat(50)} deep`);
    expect(c.textContent).toContain("deep");
    expect(c.querySelectorAll("blockquote").length).toBeLessThanOrEqual(4);
  });
  it("fenced code is verbatim", () => {
    const c = html("```ts\nconst a = **x**; <b>\n```\nafter");
    expect(c.querySelector("pre code")?.textContent).toBe(
      "const a = **x**; <b>",
    );
    expect(c.querySelector("pre strong")).toBeNull();
  });
  it("an unclosed fence stays literal text", () => {
    const c = html("```\n<script>alert(1)</script>");
    expect(c.querySelector("pre")).toBeNull();
    expect(c.textContent).toBe("```\n<script>alert(1)</script>");
  });
  it("headings are a bold line", () => {
    const c = html("## Title\ntext");
    expect(c.querySelector("strong")?.textContent).toBe("Title");
    expect(c.querySelector("h1,h2,h3")).toBeNull();
  });
  it("images and tables stay literal", () => {
    const c = html(
      "![alt](https://a.com/i.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    );
    expect(c.querySelector("img, table")).toBeNull();
    expect(c.textContent).toContain("![alt](");
    expect(c.textContent).toContain("| a | b |");
  });
});

describe("links", () => {
  it("autolinks and [text](url) with safe rel and target", () => {
    const c = html("see https://a.com/x. and [docs](http://b.com/y)");
    const a = [...c.querySelectorAll("a")];
    expect(a.map((x) => x.getAttribute("href"))).toEqual([
      "https://a.com/x",
      "http://b.com/y",
    ]);
    for (const x of a) {
      expect(x.getAttribute("target")).toBe("_blank");
      expect(x.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(a[1]?.textContent).toBe("docs");
  });
  it("accepts balanced parens in the url", () => {
    expect(hrefs(html("[w](https://en.wikipedia.org/wiki/Foo_(bar))"))).toEqual(
      ["https://en.wikipedia.org/wiki/Foo_(bar)"],
    );
  });
  it.each([
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](vbscript:msgbox(1))",
    "[x](//evil.com)",
    "[x](/relative)",
    "[x](mailto:a@b.com)",
    "[x](java\tscript:alert(1))",
    "[x](ja\nvascript:alert(1))",
    "[x](https://a.com/\u0001x)",
    "[x](https://a.com/‮x)",
    "[x](https://a.com/​x)",
    "[x](https:/\u0000/a.com)",
    "[x](htt​ps://a.com)",
    "[x](https://)",
  ])("does not link %j", (s) => {
    const c = html(s);
    expect(hrefs(c).filter((h) => !/^https?:\/\/[^/?#]/.test(h ?? ""))).toEqual(
      [],
    );
    expect(hrefs(c)).toEqual([]);
    expect(c.textContent).toContain("[x]");
  });
  it("a url with a space is not a link target, only the bare url links", () => {
    for (const s of ["[x](https://a.com/ b)", "[x]( https://a.com)"]) {
      const c = html(s);
      expect(c.textContent).toBe(s);
      expect(hrefs(c).length).toBe(1);
    }
  });
  it("strips bidi and zero-width characters from link text", () => {
    const c = html("[pay‮pal​ ok](https://a.com)");
    expect(c.querySelector("a")?.textContent).toBe("paypal ok");
  });
  it("shows the real address when the text imitates another", () => {
    const c = html("[https://good.com](https://evil.com/x)");
    expect(c.querySelector("a")?.textContent).toBe("https://evil.com/x");
    expect(
      html("[good.com](https://evil.com)").querySelector("a")?.textContent,
    ).toBe("https://evil.com");
  });
  it("an image url is not a [text](url) link", () => {
    const c = html("![x](https://a.com/i.png)");
    expect(c.querySelector("img")).toBeNull();
  });
});

describe("hostile bodies", () => {
  const BODY = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<iframe src=//evil></iframe>",
    "[a](javascript:alert(1)) [b](data:text/html;base64,AAAA) [c](vbscript:x)",
    "![i](javascript:alert(1)) ![j](https://a.com/p.png)",
    "**<img src=x onerror=alert(1)>** *<script>*",
    "- <svg onload=alert(1)>\n> <style>*{}</style>",
    "```\n<script>x</script>\n```",
    '&lt;script&gt; &#60;img&#62; <a href="javascript:1">x</a>',
    'https://a.com/"onmouseover="alert(1)',
    '[x](https://a.com" onclick="alert(1))',
  ].join("\n\n");
  it("renders only allow-listed elements, safe hrefs, and no handlers", () => {
    const c = html(BODY);
    expect(tags(c).filter((t) => !ALLOWED.has(t))).toEqual([]);
    for (const h of hrefs(c)) expect(h).toMatch(/^https?:\/\/[^/?#]/);
    for (const el of c.querySelectorAll("*"))
      for (const a of el.getAttributeNames())
        expect(["class", "href", "target", "rel", "start"]).toContain(a);
    expect(c.querySelector("img, script, iframe, svg, style")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
  });
  it("mention-aware rendering is also safe", () => {
    const { container } = render(
      <MentionedText body={BODY} mentions={[{ key: "k", name: "bot" }]} />,
    );
    expect(container.querySelector("img, script, iframe")).toBeNull();
    for (const h of hrefs(container)) expect(h).toMatch(/^https?:\/\//);
  });
});

function walk(bs: Block[]): number {
  let n = 0;
  const inl = (xs: Inline[]) => {
    for (const x of xs) {
      n++;
      if (x.t === "b" || x.t === "i") inl(x.c);
    }
  };
  for (const b of bs) {
    if (b.t === "p" || b.t === "h") inl(b.c);
    else if (b.t === "pre") n++;
    else if (b.t === "q") n += walk(b.c);
    else if (b.t === "list") for (const it of b.items) inl(it);
  }
  return n;
}

describe("performance", () => {
  const cases: Record<string, string> = {
    stars: "*a ".repeat(667),
    doubleStars: "**a_".repeat(500),
    underscores: "_a ".repeat(667),
    backticks: "`a".repeat(1000),
    backtickRuns: "`".repeat(1000) + "``".repeat(500),
    brackets: "[a](".repeat(500),
    brackets2: "[".repeat(2000),
    parens: `[a](https://a.com/${"(".repeat(1900)}`,
    urls: "http://a ".repeat(220),
    mixed: "*_`[".repeat(500),
    nested: `${"*a ".repeat(300)}${"_b ".repeat(300)}${"`".repeat(100)}`,
    quotes: "> ".repeat(1000),
    lists: "- a\n".repeat(500),
    fences: "```\n".repeat(400),
    headings: "# *a\n".repeat(400),
    escapes: "\\".repeat(2000),
    closers: `https://a.com/x${")".repeat(1900)}`,
  };
  for (const [name, s] of Object.entries(cases))
    it(`2,000 characters of ${name} parse in under 50ms`, () => {
      const body = s.slice(0, 2000);
      const t = performance.now();
      const n = walk(parseMarkdown(body));
      expect(performance.now() - t).toBeLessThan(50);
      expect(n).toBeGreaterThan(0);
    });
  it("caps oversized input and shows the rest as plain text", () => {
    const body = `${"a".repeat(6000)}**x**`;
    const blocks = parseMarkdown(body);
    expect(blocks.at(-1)).toEqual({
      t: "p",
      c: [{ t: "text", s: body.slice(5000) }],
    });
    expect(parseInlineOnly("**b**")).toEqual([
      { t: "b", c: [{ t: "text", s: "b" }] },
    ]);
  });
});

describe("mentions", () => {
  it("chips render inside paragraphs, lists and bold", () => {
    const { container } = render(
      <MentionedText
        body={"hi @bot\n\n- ask @bot\n- **@bot** too"}
        mentions={[{ key: "k", name: "bot" }]}
      />,
    );
    expect(container.querySelectorAll("p [data-mention-chip]").length).toBe(1);
    expect(container.querySelectorAll("li [data-mention-chip]").length).toBe(2);
  });
  it("copy text is the plain words", () => {
    const { container } = render(
      <MentionedText
        body="a **b** `c`"
        mentions={[{ key: "k", name: "bot" }]}
      />,
    );
    expect(container.textContent).toBe("a b c");
  });
});

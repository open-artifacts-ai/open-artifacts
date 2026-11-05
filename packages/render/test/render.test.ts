// @vitest-environment happy-dom
import { LIMITS } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_MAX_BYTES,
  renderCode,
  textOf,
  unpreviewableHtml,
} from "../src/code";
import { renderImage } from "../src/image";
import { prepareMarkdown, renderMarkdown } from "../src/markdown";
import { truncateUtf8, versionFromPath } from "../src/shell";
import { applyTheme, watchShellTheme } from "../src/theme";

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("renderMarkdown", () => {
  it("drops raw <script> and renders headings", () => {
    const out = renderMarkdown("<script>x</script>\n# T");
    expect(out).not.toContain("<script");
    expect(out).toContain("<h1");
  });

  it("escapes raw HTML", () => {
    const out = renderMarkdown('<div class="x">hi</div>');
    expect(out).toContain("&lt;div");
    expect(dom(out).querySelector("div.x")).toBeNull();
  });

  it("keeps an <img onerror> inert", () => {
    const el = dom(renderMarkdown("<img src=x onerror=alert(1)>\n\ntext"));
    expect(el.querySelector("img")).toBeNull();
    const handlers = [...el.querySelectorAll("*")].flatMap((n) =>
      [...n.attributes].filter((a) => a.name.startsWith("on")),
    );
    expect(handlers).toEqual([]);
  });

  it("strips javascript: and data: links", () => {
    const el = dom(
      renderMarkdown(
        "[a](javascript:alert(1)) [b](JaVaScRiPt:alert(1)) [c](data:text/html,x) ![d](data:image/png;base64,AAAA) <javascript:alert(1)>",
      ),
    );
    expect(el.querySelectorAll("a")).toHaveLength(0);
    expect(el.querySelectorAll("img")).toHaveLength(0);
    expect(el.innerHTML).not.toMatch(/href="(javascript|data):/i);
  });

  it("keeps http, https, mailto and relative links", () => {
    const el = dom(
      renderMarkdown(
        "[a](http://x.test) [b](https://x.test) [c](mailto:a@x.test) [d](./doc.md) [e](#frag) https://auto.test",
      ),
    );
    const hrefs = [...el.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "http://x.test",
      "https://x.test",
      "mailto:a@x.test",
      "./doc.md",
      "#frag",
      "https://auto.test",
    ]);
    const ext = el.querySelector('a[href="https://x.test"]');
    expect(ext?.getAttribute("rel")).toContain("noopener");
  });

  it("wraps output in .oa-doc", () => {
    expect(renderMarkdown("x")).toMatch(/^<article class="oa-doc">/);
  });

  it('renders a mermaid fence as <pre class="mermaid">', () => {
    const out = renderMarkdown("```mermaid\ngraph TD; A-->B\n```");
    expect(out).toContain('<pre class="mermaid">');
    expect(out).toContain("A--&gt;B");
  });

  it("renders GFM tables and task lists", () => {
    const el = dom(
      renderMarkdown(
        "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo",
      ),
    );
    expect(el.querySelector("table td")?.textContent).toBe("1");
    const boxes = el.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).hasAttribute("checked")).toBe(true);
    expect((boxes[0] as HTMLInputElement).hasAttribute("disabled")).toBe(true);
  });

  it("highlights fences with shiki once languages are prepared", async () => {
    const src = "```ts\nconst a = 1\n```";
    await prepareMarkdown(src);
    const el = dom(renderMarkdown(src));
    const block = el.querySelector(".oa-codeblock");
    expect(block?.getAttribute("data-lang")).toBe("ts");
    expect(block?.querySelector("pre.shiki")).not.toBeNull();
    expect(block?.querySelector(".oa-copy")).not.toBeNull();
  });

  it("falls back to an escaped block for unknown languages", () => {
    const el = dom(renderMarkdown("```nope\n<b>x</b>\n```"));
    expect(el.querySelector(".oa-codeblock pre")?.textContent).toContain(
      "<b>x</b>",
    );
    expect(el.querySelector(".oa-codeblock b")).toBeNull();
  });
});

describe("renderCode", () => {
  it("renders shiki markup with line numbers and a copy button", async () => {
    const out = await renderCode("const a=1", "ts");
    expect(out).toMatch(/class="shiki[ "]/);
    expect(out).toContain('class="line"');
    const el = dom(out);
    expect(
      el.querySelector(".oa-code .oa-code-header .oa-copy"),
    ).not.toBeNull();
    expect(el.querySelector(".oa-code")?.getAttribute("data-wrap")).toBe(
      "false",
    );
  });

  it("escapes source for unknown languages", async () => {
    const el = dom(await renderCode("<img src=x onerror=alert(1)>\nb", "nope"));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelectorAll(".line")).toHaveLength(2);
  });
});

describe("shell helpers", () => {
  it("caps text at a UTF-8 byte budget without splitting characters", () => {
    expect(truncateUtf8("héllo", 2)).toBe("h");
    expect(truncateUtf8("héllo", 3)).toBe("hé");
    const big = "é".repeat(LIMITS.extractedTextBytes);
    const cut = truncateUtf8(big, LIMITS.extractedTextBytes);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(
      LIMITS.extractedTextBytes,
    );
  });

  it("reads the version from /v{n}/", () => {
    expect(versionFromPath("/artifacts/abc/v12/__view")).toBe(12);
    expect(versionFromPath("/s/tok/abc/v3/doc.pdf")).toBe(3);
    expect(versionFromPath("/nothing")).toBeNull();
  });
});

describe("theme", () => {
  afterEach(() => document.documentElement.removeAttribute("data-theme"));

  it("applies data-theme on <html>", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows theme messages from the parent only", () => {
    const stop = watchShellTheme();
    applyTheme("light");
    const msg = { oa: 1, type: "theme", theme: "dark" };
    window.dispatchEvent(
      new MessageEvent("message", { data: msg, source: null }),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    window.dispatchEvent(
      new MessageEvent("message", { data: msg, source: window.parent }),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
  });
});

describe("entryUrl", () => {
  it("resolves the entry against the page, keeping the version prefix", async () => {
    const { entryUrl } = await import("../src/index");
    expect(
      entryUrl("docs/a b#1.md", "https://c.test/s/tok/abc/v3/__view"),
    ).toBe("https://c.test/s/tok/abc/v3/docs/a%20b%231.md");
  });
});

describe("boot readiness marker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.documentElement.removeAttribute("data-oa-rendered");
  });

  // Server-side thumbnails (apps/server services/thumbs.ts) wait for it.
  it("sets <html data-oa-rendered> only once the artifact is rendered", async () => {
    document.head.innerHTML =
      '<meta name="oa-format" content="code"><meta name="oa-entry" content="main.txt"><meta name="oa-language" content="text">';
    let release: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (release = r)));
    vi.resetModules();
    await import("../src/index");
    await new Promise((r) => setTimeout(r, 10));
    expect(document.documentElement.hasAttribute("data-oa-rendered")).toBe(
      false,
    );
    release(new Response("readybody"));
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-oa-rendered")).toBe(
        true,
      ),
    );
    expect(document.body.textContent).toContain("readybody");
  });
});

// A phone JPEG published as code froze the viewer (leo, 2026-10-28): binary
// and oversized entries never reach the highlighter.
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

describe("textOf", () => {
  it("refuses a JPEG (invalid UTF-8 and NUL bytes up front)", () => {
    expect(textOf(JPEG)).toEqual({ ok: false, reason: "binary" });
  });

  it("refuses a NUL byte in otherwise plain text", () => {
    expect(textOf(new TextEncoder().encode("abc\0def"))).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("refuses invalid UTF-8 with no NUL", () => {
    expect(textOf(new Uint8Array([0x61, 0xc3, 0x28, 0x62]))).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("refuses anything over the cap before decoding", () => {
    expect(textOf(new Uint8Array(CODE_MAX_BYTES + 1).fill(0x61))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("keeps UTF-8 text, even with a character cut at the 8 KB sniff boundary", () => {
    const text = `${"a".repeat(8 * 1024 - 1)}é and more`;
    expect(textOf(new TextEncoder().encode(text))).toEqual({ ok: true, text });
  });
});

describe("unpreviewableHtml", () => {
  it("says why and links the download, escaped", () => {
    const el = dom(
      unpreviewableHtml("binary", 'https://c.test/a"b', "x<y>.jpg"),
    );
    expect(el.textContent).toContain("This file can't be shown.");
    const a = el.querySelector("a");
    expect(a?.getAttribute("href")).toBe('https://c.test/a"b');
    expect(a?.getAttribute("download")).toBe("x<y>.jpg");
    expect(a?.textContent).toBe("Download");
    expect(dom(unpreviewableHtml("too_large", "u", "n")).textContent).toContain(
      "This file is too large to preview.",
    );
  });
});

describe("boot with a binary code entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-oa-rendered");
  });

  it("shows the note with Download, never the code view, and still marks itself rendered", async () => {
    document.head.innerHTML =
      '<meta name="oa-format" content="code"><meta name="oa-entry" content="IMG_0042.jpg"><meta name="oa-language" content="text">';
    vi.stubGlobal("fetch", async () => new Response(JPEG));
    vi.resetModules();
    await import("../src/index");
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-oa-rendered")).toBe(
        true,
      ),
    );
    expect(document.querySelector(".oa-code")).toBeNull();
    expect(document.body.textContent).toContain("This file can't be shown.");
    expect(
      document.querySelector(".oa-unpreviewable a")?.getAttribute("download"),
    ).toBe("IMG_0042.jpg");
  });
});

describe("renderImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-oa-rendered");
  });

  it("is one <img> of the entry, never an inlined or framed SVG", async () => {
    const root = document.createElement("div");
    const done = renderImage(
      "https://c.test/v1/logo%20a.svg",
      "logo a.svg",
      root,
    );
    const img = root.querySelector(".oa-image img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://c.test/v1/logo%20a.svg");
    expect(img.alt).toBe("logo a.svg");
    expect(root.querySelector("svg, object, embed, iframe")).toBeNull();
    img.dispatchEvent(new Event("load"));
    await done;
    expect(root.querySelector(".oa-image img")).not.toBeNull();
  });

  it("an image that can't decode shows the note with Download", async () => {
    const root = document.createElement("div");
    const done = renderImage("https://c.test/v1/x.png", "x.png", root);
    root.querySelector("img")?.dispatchEvent(new Event("error"));
    await done;
    expect(root.textContent).toContain("This file can't be shown.");
    expect(root.querySelector("a")?.getAttribute("download")).toBe("x.png");
  });

  it("boot renders an image entry and marks itself rendered once it loads", async () => {
    document.head.innerHTML =
      '<meta name="oa-format" content="image"><meta name="oa-entry" content="photos/IMG 1.jpg"><meta name="oa-content-type" content="image/jpeg">';
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.resetModules();
    await import("../src/index");
    const img = await vi.waitFor(() => {
      const el = document.querySelector<HTMLImageElement>(".oa-image img");
      if (!el) throw new Error("no img yet");
      return el;
    });
    expect(img.getAttribute("src")).toMatch(/photos\/IMG%201\.jpg$/);
    expect(document.documentElement.hasAttribute("data-oa-rendered")).toBe(
      false,
    );
    img.dispatchEvent(new Event("load"));
    await vi.waitFor(() =>
      expect(document.documentElement.hasAttribute("data-oa-rendered")).toBe(
        true,
      ),
    );
    // The bytes are never fetched as text.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

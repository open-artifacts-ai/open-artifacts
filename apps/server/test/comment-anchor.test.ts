import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../src/services/artifacts.js";
import {
  decodeEntities,
  findQuote,
  normalizeText,
  verifyQuote,
  visibleText,
} from "../src/services/comment-anchor.js";
import { checkAnchor } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

const PDF = "%PDF-1.4\n% pin hash test\n";
const sha256Hex = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

const text = async (html: string) => normalizeText(await visibleText(html));

describe("visible text", () => {
  it("skips script, style, template, noscript and title; decodes entities", async () => {
    const t = await text(
      `<title>T</title><style>.a{}</style><script>var x = "secret"</script>
       <template>tmpl</template><noscript>nojs</noscript>
       <p>Fish &amp; chips &#169; &#x41; &lt;b&gt; &nbsp;done</p>`,
    );
    expect(t).toBe("Fish & chips © A <b> done");
    expect(t).not.toMatch(/secret|tmpl|nojs|\.a/);
  });
  it("counts nested text once, and keeps inline text fused", async () => {
    expect(await text("<p>a <b>b</b>c</p><p>d</p>")).toBe("a bc d");
  });
  it("handles void and self-closed elements (#1718)", async () => {
    expect(await text("<p>a<br>b<hr>c<img src=x>d<div/>e<br/>f</p>")).toBe(
      "a b cd e f",
    );
  });
  it("a void or self-closed element in a hidden set never sticks the counter", async () => {
    expect(
      await text(
        "<template><br><hr><img src=x></template><p>one</p><noscript><br/></noscript><p>two</p><svg/><p>three</p>",
      ),
    ).toBe("one two three");
  });
  it("leaves an unknown name as written; invalid numbers become U+FFFD", () => {
    expect(decodeEntities("&nosuch; &#0; &#xD800; &#x110000;")).toBe(
      "&nosuch; \uFFFD \uFFFD \uFFFD",
    );
  });
  it("agrees with the browser on the edge cases (#1735)", () => {
    // Once only: &amp;lt; is the text "&lt;", never "<".
    expect(decodeEntities("&amp;lt; &amp;amp;")).toBe("&lt; &amp;");
    expect(decodeEntities("&#x2264; &#8804; &#X2264;")).toBe(
      "\u2264 \u2264 \u2264",
    );
    // A legacy name without a semicolon decodes where the HTML spec says so;
    // the rest of the word stays.
    expect(decodeEntities("&ampx &notit; &lt")).toBe("&x \u00acit; <");
    // Unknown names and a bare ampersand stay; an invalid number is U+FFFD.
    expect(decodeEntities("AT&T &unknown; & &#; &#xZ; &#x;")).toBe(
      "AT&T &unknown; & &#; &#xZ; &#x;",
    );
    expect(decodeEntities("&#1114112; &#xFFFFFFFFF;")).toBe("\uFFFD \uFFFD");
  });
  it("a selection with &le; matches its quote through visibleText", async () => {
    const t = await text("<p>if <code>a[j]</code> &le; <code>a[i]</code></p>");
    expect(t).toBe("if a[j] \u2264 a[i]");
  });
  it("decodes the full named set, legacy forms and windows-1252 numbers", () => {
    expect(
      decodeEntities(
        "&le; &ge; &ne; &rarr; &hellip; &nbsp;| &copy &amp &#128;",
      ),
    ).toBe("\u2264 \u2265 \u2260 \u2192 \u2026 \u00a0| \u00a9 & \u20ac");
  });
});

describe("findQuote", () => {
  const t = normalizeText(
    "The quick brown fox jumps over the lazy dog near the river bank today",
  );
  it("accepts prefix+exact+suffix with whitespace differences", () => {
    expect(
      findQuote(t, {
        exact: "brown\n  fox",
        prefix: "quick ",
        suffix: " jumps",
      }),
    ).toEqual({ prefix: "quick", suffix: "jumps" });
  });
  it("re-derives the context (32 chars) when only the context is off", () => {
    const r = findQuote(t, {
      exact: "lazy dog",
      prefix: "WRONG ",
      suffix: "WRONG",
    });
    expect(r).toEqual({
      prefix: t.slice(0, t.indexOf("lazy dog")).slice(-32),
      suffix: t.slice(
        t.indexOf("lazy dog") + 8,
        t.indexOf("lazy dog") + 8 + 32,
      ),
    });
  });
  it("is null when exact is absent or blank", () => {
    expect(findQuote(t, { exact: "purple cat" })).toBeNull();
    expect(findQuote(t, { exact: "   " })).toBeNull();
  });
});

describe("context snapping and size", () => {
  it("re-derived context never splits a surrogate pair", () => {
    const t = `😀${"a".repeat(31)}EXACT${"b".repeat(30)}😀tail`;
    const r = findQuote(t, { exact: "EXACT", prefix: "zz", suffix: "zz" });
    const lone =
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(r).not.toBeNull();
    expect(lone.test(r?.prefix ?? "")).toBe(false);
    expect(lone.test(r?.suffix ?? "")).toBe(false);
  });
  it("hidden text is not buffered into the result", async () => {
    const big = "x".repeat(300_000);
    expect(await text(`<script>${big}</script><p>seen</p>`)).toBe("seen");
  });
});

describe("verifyQuote and checkAnchor", () => {
  let id: string;
  let mdId: string;
  let big: string;
  let pdfId: string;
  let jsId: string;
  beforeAll(async () => {
    const l = await login(`ca-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const m = await getUser(env, l.userId);
    if (!m) throw new Error("no user");
    const mk = (format: string, content: string) =>
      publish(
        env,
        m,
        { title: "t", format, content } as never,
        null,
        undefined,
        "create",
      );
    id = (
      await mk(
        "html",
        "<p>Hello <b>big</b> world</p><script>hidden words</script>",
      )
    ).id;
    mdId = (await mk("markdown", "# Hi\n\nplain")).id;
    big = (await mk("html", "<p>Hello</p>")).id;
    pdfId = (await mk("pdf", PDF)).id;
    jsId = (
      await mk(
        "html",
        "<p id=\"lede\"></p><script>document.getElementById('lede').innerHTML='When <code>i</code> pops <code>j</code>'</script>",
      )
    ).id;
  });
  const art = (a: string, format: string) => ({
    id: a,
    format,
    currentVersion: 1,
  });

  it("keeps the context of a quote in the version; one only in a script is accepted with the given context", async () => {
    expect(
      await verifyQuote(env, id, "html", 1, {
        exact: "big world",
        prefix: "zz",
      }),
    ).toEqual({ prefix: "Hello ", suffix: "" });
    expect(
      await verifyQuote(env, id, "html", 1, {
        exact: "hidden words",
        prefix: "given",
        suffix: "ctx",
      }),
    ).toEqual({ prefix: "given", suffix: "ctx" });
    const long = "0123456789".repeat(7);
    expect(
      await verifyQuote(env, id, "html", 1, {
        exact: "hidden words",
        prefix: long,
        suffix: long,
      }),
    ).toEqual({ prefix: long.slice(-32), suffix: long.slice(0, 32) });
    // A cut never lands inside a surrogate pair.
    const e = "😀".repeat(40);
    const cut = await verifyQuote(env, id, "html", 1, {
      exact: "hidden words",
      prefix: e,
      suffix: e,
    });
    expect(cut).toEqual({ prefix: "😀".repeat(16), suffix: "😀".repeat(16) });
  });
  it("script-rendered text is not in the static text: the quote is accepted with its given context (#1482, #1735)", async () => {
    const html =
      "<p id=\"lede\"></p><script>document.getElementById('lede').innerHTML='When <code>i</code> pops <code>j</code>'</script>";
    expect(await visibleText(html)).not.toContain("pops");
    expect(
      await verifyQuote(env, jsId, "html", 1, {
        exact: "i pops j",
        prefix: "When ",
        suffix: " end",
      }),
    ).toEqual({ prefix: "When ", suffix: " end" });
  });
  it("a quote on text the page's script renders is accepted (#1735)", async () => {
    // The shape of the reported page: a static shell, the intro filled by script.
    const l = await login(`cb-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const { id: js } = await publish(
      env,
      (await getUser(env, l.userId)) as never,
      {
        title: "Stepper",
        format: "html",
        content: `<title>Monotonic Stack Stepper</title><h1>Monotonic Stack Stepper</h1>
<p class="lede" id="lede"></p>
<script>document.getElementById("lede").innerHTML = 'Finds the <b>previous strictly smaller</b> element; <code>j</code> pops.';</script>`,
      } as never,
      null,
      undefined,
      "create",
    );
    for (const exact of [
      "previous strictly smaller",
      "j",
      "Finds the previous",
    ])
      expect(
        await checkAnchor(env, art(js, "html"), {
          kind: "text",
          exact,
          prefix: "ab",
          suffix: "cd",
        }),
      ).toMatchObject({
        anchor: { kind: "text", exact, prefix: "ab", suffix: "cd" },
      });
    const r = await checkAnchor(env, art(js, "html"), {
      kind: "text",
      exact: "j",
      prefix: "forged",
      suffix: "forged",
      block: { path: "evil" },
    });
    expect(r.anchor).toMatchObject({ prefix: "forged", suffix: "forged" });
    expect(r.anchor).not.toHaveProperty("block");
  });
  it("an entry over 5 MB is not parsed: the quote is accepted with its given context", async () => {
    await env.DB.prepare(
      "update versions set manifest = json_set(manifest, '$[0].size', 6000000) where artifact_id = ?",
    )
      .bind(big)
      .run();
    expect(
      await verifyQuote(env, big, "html", 1, {
        exact: "Hello",
        prefix: "x",
        suffix: "y",
      }),
    ).toEqual({ prefix: "x", suffix: "y" });
    const r = await checkAnchor(env, art(big, "html"), {
      kind: "text",
      exact: "Hello",
      prefix: "x",
      suffix: "y",
      block: { path: "evil" },
    });
    expect(r.anchor).toMatchObject({ prefix: "x", suffix: "y" });
    expect(r.anchor).not.toHaveProperty("block");
  });
  it("422 for a version that does not exist", async () => {
    await expect(
      verifyQuote(env, id, "html", 9, { exact: "Hello" }),
    ).rejects.toMatchObject({ code: "anchor_not_in_version" });
  });
  it("other formats get schema validation only", async () => {
    const r = await checkAnchor(env, art(mdId, "markdown"), {
      kind: "text",
      exact: "not in the file",
      prefix: "",
      suffix: "",
    });
    expect(r.version).toBe(1);
  });
  it("checkAnchor re-derives context and fills the current version", async () => {
    const r = await checkAnchor(env, art(id, "html"), {
      kind: "text",
      exact: "Hello",
      prefix: "bogus",
      suffix: "bogus",
    });
    expect(r.anchor).toMatchObject({
      kind: "text",
      version: 1,
      exact: "Hello",
      prefix: "",
      suffix: " big world",
    });
  });
  it("a pin on a pdf is stamped with the entry's sha256; a client hash is overwritten", async () => {
    const want = await sha256Hex(PDF);
    const r = await checkAnchor(env, art(pdfId, "pdf"), {
      kind: "pin",
      x: 0.5,
      y: 0.5,
      contentHash: "f".repeat(64),
    });
    expect(r.anchor).toMatchObject({ kind: "pin", contentHash: want });
    // The list reports the same hash the pin was stamped with.
    const row = await env.DB.prepare(
      "select manifest from versions where artifact_id = ? and version = 1",
    )
      .bind(pdfId)
      .first<{ manifest: string }>();
    expect(JSON.parse(row?.manifest ?? "[]")[0].digest).toBe(want);
  });
  it("a pin hash is computed from the bytes when the manifest has no digest", async () => {
    await env.DB.prepare(
      "update versions set manifest = json_remove(manifest, '$[0].digest') where artifact_id = ?",
    )
      .bind(pdfId)
      .run();
    const r = await checkAnchor(
      { ...env, PLAN: "paid" } as never,
      art(pdfId, "pdf"),
      {
        kind: "pin",
        x: 0.1,
        y: 0.2,
        contentHash: "f".repeat(64),
      },
    );
    expect(r.anchor).toMatchObject({ contentHash: await sha256Hex(PDF) });
  });
  it("a pin on a missing version is 422", async () => {
    await expect(
      checkAnchor(env, art(pdfId, "pdf"), {
        kind: "pin",
        version: 9,
        x: 0.5,
        y: 0.5,
        contentHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "anchor_not_in_version" });
  });
  it("rejects bad shapes and bad pin hashes as invalid_anchor", async () => {
    await expect(
      checkAnchor(env, art(id, "html"), { kind: "nope" }),
    ).rejects.toMatchObject({
      code: "invalid_anchor",
    });
    await expect(
      checkAnchor(env, art(id, "html"), {
        kind: "pin",
        x: 0.5,
        y: 0.5,
        contentHash: "a b",
      }),
    ).rejects.toMatchObject({ code: "invalid_anchor" });
    await expect(
      checkAnchor(env, art(id, "html"), {
        kind: "pin",
        x: 2,
        y: 0.5,
        contentHash: "abc",
      }),
    ).rejects.toMatchObject({ code: "invalid_anchor" });
  });
});

describe("quotes on a page with named entities (#1735)", () => {
  const html =
    '<h1>Next smaller element</h1><p class="intro">For each index <code>i</code>, find the first <code>j &gt; i</code> with <code>arr[j]</code> &le; <code>arr[i]</code>. We track <b>both</b> the stack and <code>nxt[j]</code>; if none exists, <code>nxt = n</code>.</p>';
  const exact =
    "For each index i, find the first j > i with arr[j] \u2264 arr[i]. We track both the stack and nxt[j]; if none exists, nxt = n.";
  it("finds the paragraph quote with a non-ascii entity", async () => {
    const t = normalizeText(await visibleText(html));
    expect(findQuote(t, { exact })).not.toBeNull();
  });
  it("finds a quote that crosses two blocks", async () => {
    const t = normalizeText(await visibleText(html));
    const q = { exact: "smaller element For each index i, find the first" };
    expect(findQuote(t, q)).not.toBeNull();
  });
  it("finds ge, ne, rarr, hellip, nbsp and a legacy copy", async () => {
    const t = normalizeText(
      await visibleText(
        "<p>a &ge; b &ne; c &rarr; d&hellip; e&nbsp;f &copy 2026</p>",
      ),
    );
    expect(
      findQuote(t, {
        exact: "a \u2265 b \u2260 c \u2192 d\u2026 e f \u00a9 2026",
      }),
    ).not.toBeNull();
  });
});

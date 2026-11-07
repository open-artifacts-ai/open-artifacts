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
  it("leaves an unknown entity as written", () => {
    expect(decodeEntities("&nosuch; &#0; &#xD800;")).toBe(
      "&nosuch; &#0; &#xD800;",
    );
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
  });
  const art = (a: string, format: string) => ({
    id: a,
    format,
    currentVersion: 1,
  });

  it("passes a quote in the version and fails one only in a script", async () => {
    expect(
      await verifyQuote(env, id, "html", 1, { exact: "big world" }),
    ).not.toBeNull();
    await expect(
      verifyQuote(env, id, "html", 1, { exact: "hidden words" }),
    ).rejects.toMatchObject({ code: "anchor_not_in_version" });
  });
  it("an entry over 5 MB is not parsed: 422", async () => {
    await env.DB.prepare(
      "update versions set manifest = json_set(manifest, '$[0].size', 6000000) where artifact_id = ?",
    )
      .bind(big)
      .run();
    await expect(
      verifyQuote(env, big, "html", 1, { exact: "Hello" }),
    ).rejects.toMatchObject({ code: "anchor_not_in_version" });
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

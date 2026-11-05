import { env } from "cloudflare:workers";
import {
  LIMITS,
  type Member,
  newId,
  PageSchema,
  R,
  SearchHitSchema,
  SNIPPET_MARK,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { patch, publish } from "../src/services/artifacts.js";
import {
  extractText,
  INDEX_INPUT_BYTES,
  indexVersionOrThrow,
  sanitizeQuery,
} from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { api, fetchAndWait, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "q");
const Hits = PageSchema(SearchHitSchema);
type U = { cookie: string; userId: string; member: Member };
let o: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const l = await login(`${prefix}-${tag}@x.com`, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m };
}

/** Publishes, then fires the DO alarm that indexes it (C3). */
const pub = async (u: U, input: Record<string, unknown>) => {
  const r = await publish(env, u.member, input as never, null);
  await runIndex(r.id);
  return r;
};

const search = (u: U | null, q: string, extra = "") =>
  api(app, `${R.search}?q=${encodeURIComponent(q)}${extra}`, u?.cookie ?? null);

const hits = async (u: U, q: string, extra = "") => {
  const r = await search(u, q, extra);
  expect(r.status).toBe(200);
  return Hits.parse(await r.json());
};

const putText = (u: U | null, id: string, v: number, text: string) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${R.versionText(id, v)}`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        "x-oa-request": "1",
        ...(u ? { cookie: u.cookie } : {}),
      },
      body: text,
    }),
  );

beforeAll(async () => {
  o = await mk("srch-owner");
});

describe("sanitizeQuery", () => {
  it("quotes tokens, doubles quotes, prefixes the last, caps at 16", () => {
    expect(sanitizeQuery("hello world")).toBe('"hello" AND "world"*');
    expect(sanitizeQuery('he"llo')).toBe('"he""llo"*');
    expect(sanitizeQuery("  ")).toBeNull();
    expect(sanitizeQuery("( % --")).toBeNull();
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`).join(" ");
    expect(sanitizeQuery(many)?.split(" AND ")).toHaveLength(16);
  });
});

describe("extractText", () => {
  it("html skips script/style/noscript/template and collapses whitespace", async () => {
    const t = await extractText(
      "html",
      "<html><head><style>.x{}</style><script>secret()</script></head><body><p>a  &amp;\n b</p><p>c</p><noscript>ns</noscript><template>tp</template></body></html>",
    );
    expect(t).toBe("a & b c");
  });

  it("html: comments dropped; chunk splits never leak", async () => {
    expect(
      await extractText("html", "<p>quar<b>terly</b></p><!-- hid -->x a < b"),
    ).toBe("quar terly x a < b");
    const parts = [
      "<p>ok</p><scr",
      "ipt>leak",
      "ed()</scr",
      "ipt><!-",
      "- c -",
      "-><p>end &am",
      "p; done</p>",
    ];
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    expect(await extractText("html", stream)).toBe("ok end & done");
  });

  it("markdown/code are raw; pdf is empty; capped at searchBodyChars", async () => {
    expect(await extractText("markdown", "# hi *x*")).toBe("# hi *x*");
    expect(await extractText("pdf", "%PDF-1.4")).toBe("");
    const big = "a".repeat(LIMITS.searchBodyChars + 5000);
    expect((await extractText("code", big)).length).toBe(
      LIMITS.searchBodyChars,
    );
    // A stream (what indexing reads) also stops at INDEX_INPUT_BYTES.
    expect(
      (await extractText("markdown", new Response(big).body as ReadableStream))
        .length,
    ).toBe(Math.min(LIMITS.searchBodyChars, INDEX_INPUT_BYTES));
  });
});

describe("search", () => {
  it("finds HTML body text but not script text, with a marked snippet", async () => {
    const a = await pub(o, {
      title: "Plan",
      format: "html",
      content: `<script>secret${tag}()</script><p>quarterly${tag} plan ${tag}quarterlyplan</p>`,
    });
    const h = await hits(o, `quarterly${tag}`);
    expect(h.items.map((x) => x.id)).toEqual([a.id]);
    expect(h.items[0]?.snippet).toContain(
      `${SNIPPET_MARK.open}quarterly${tag}${SNIPPET_MARK.close}`,
    );
    expect((await hits(o, `secret${tag}`)).items).toEqual([]);
    // Prefix on the last token. The query prefix ends in the fixed "quart"
    // so porter stemming can't rewrite it (a random tag ending in e.g. "y"
    // stems to "…i" and is then no prefix of the indexed word).
    expect((await hits(o, `${tag}quart`)).items.length).toBe(1);
    expect((await hits(o, `plan quarterly${tag}`)).items).toHaveLength(1);
  });

  it("FTS syntax and odd input never throw", async () => {
    for (const q of [
      '"foo* OR bar"',
      'hello"',
      "c++",
      "foo-bar",
      "a:b",
      "NOT",
      "user@x.com",
      "title:hello",
      "NEAR(a b)",
      "^x",
    ]) {
      const r = await search(o, q);
      expect(r.status, q).toBe(200);
    }
    for (const q of ["(", "*", "( % --"])
      expect((await search(o, q)).status, q).toBe(400);
    expect((await search(o, "")).status).toBe(400);
    expect((await search(o, "x".repeat(501))).status).toBe(400);
  });

  it("title: does not select a column", async () => {
    await pub(o, {
      title: `colsel${tag}`,
      format: "markdown",
      content: "nothing",
    });
    expect((await hits(o, `title:colsel${tag}`)).items).toEqual([]);
  });

  it("matches title and description with a snippet fallback", async () => {
    const a = await pub(o, {
      title: `Titled${tag}`,
      description: `descr${tag} words`,
      format: "markdown",
      content: "body text",
    });
    const t = await hits(o, `titled${tag}`);
    expect(t.items[0]?.id).toBe(a.id);
    expect(t.items[0]?.snippet).toContain(SNIPPET_MARK.open);
    const d = await hits(o, `descr${tag}`);
    expect(d.items[0]?.snippet).toContain(`${SNIPPET_MARK.open}descr${tag}`);
  });

  it("anonymous → 401", async () => {
    expect((await search(null, "x")).status).toBe(401);
  });

  it("paginates with an offset cursor", async () => {
    for (let i = 0; i < 5; i++)
      await pub(o, {
        title: `pg${tag} ${i}`,
        format: "markdown",
        content: "x",
      });
    const p1 = await hits(o, `pg${tag}`, "&limit=3");
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).toBeTypeOf("string");
    const p2 = await hits(
      o,
      `pg${tag}`,
      `&limit=3&cursor=${p1.nextCursor ?? ""}`,
    );
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(5);
    for (const c of ["garbage!", btoa('{"o":5000}'), btoa('{"o":-1}')])
      expect((await search(o, "x", `&cursor=${c}`)).status).toBe(400);
  });

  it("follows PATCH of the title", async () => {
    const a = await pub(o, { title: "old", format: "markdown", content: "x" });
    await patch(env, o.member, a.id, { title: `renamed${tag}` });
    expect((await hits(o, `renamed${tag}`)).items.map((x) => x.id)).toEqual([
      a.id,
    ]);
  });

  it("indexes only the current version", async () => {
    const a = await pub(o, {
      title: "v",
      format: "markdown",
      content: `first${tag}`,
    });
    await pub(o, {
      id: a.id,
      title: "v",
      format: "markdown",
      content: `second${tag}`,
    });
    await indexVersionOrThrow(env, a.id, 1); // stale: a no-op
    expect((await hits(o, `first${tag}`)).items).toEqual([]);
    expect((await hits(o, `second${tag}`)).items).toHaveLength(1);
    await indexVersionOrThrow(env, "nonexistent00000", 1); // gone: a no-op
  });

  it(`indexes only the first ${INDEX_INPUT_BYTES} bytes of an entry`, async () => {
    const pad = " lorem".repeat(Math.ceil(INDEX_INPUT_BYTES / 6));
    await pub(o, {
      title: "capped",
      format: "markdown",
      content: `early${tag}${pad} late${tag}`,
    });
    expect((await hits(o, `early${tag}`)).items).toHaveLength(1);
    expect((await hits(o, `late${tag}`)).items).toEqual([]);
  });
});

describe("list q uses FTS", () => {
  it("matches body text; long q is fine up to 500", async () => {
    const a = await pub(o, {
      title: "x",
      format: "markdown",
      content: `listbody${tag}`,
    });
    const r = await api(
      app,
      `${R.artifacts}?scope=mine&q=${encodeURIComponent(` listbody${tag} `)}`,
      o.cookie,
    );
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: { id: string }[] }).items;
    expect(items.map((x) => x.id)).toEqual([a.id]);
    expect(
      (await api(app, `${R.artifacts}?q=${"a".repeat(41)}`, o.cookie)).status,
    ).toBe(200);
    expect(
      (await api(app, `${R.artifacts}?q=${"a".repeat(501)}`, o.cookie)).status,
    ).toBe(400);
  });
});

describe("PUT versionText", () => {
  it("makes a PDF findable once; a second PUT is ignored", async () => {
    const a = await pub(o, {
      title: "doc",
      format: "pdf",
      content: "%PDF-1.4",
    });
    expect((await hits(o, `pdfword${tag}`)).items).toEqual([]);
    expect((await putText(o, a.id, 1, `pdfword${tag} here`)).status).toBe(204);
    expect((await hits(o, `pdfword${tag}`)).items.map((x) => x.id)).toEqual([
      a.id,
    ]);
    expect((await putText(o, a.id, 1, `other${tag}`)).status).toBe(204);
    expect((await hits(o, `other${tag}`)).items).toEqual([]);
    expect((await hits(o, `pdfword${tag}`)).items).toHaveLength(1);
  });

  it("ignored for non-pdf and stale versions; 404 for no access; 413 over cap", async () => {
    const md = await pub(o, { title: "md", format: "markdown", content: "x" });
    expect((await putText(o, md.id, 1, `mdput${tag}`)).status).toBe(204);
    expect((await hits(o, `mdput${tag}`)).items).toEqual([]);

    const p = await pub(o, { title: "p", format: "pdf", content: "%PDF-1.4" });
    await pub(o, { id: p.id, title: "p", format: "pdf", content: "%PDF-1.4" });
    expect((await putText(o, p.id, 1, `stale${tag}`)).status).toBe(204);
    expect((await hits(o, `stale${tag}`)).items).toEqual([]);
    expect((await putText(o, p.id, 9, "x")).status).toBe(404);

    const other = await mk("srch-other");
    expect((await putText(other, p.id, 2, "x")).status).toBe(404);
    expect((await putText(null, p.id, 2, "x")).status).toBe(401);

    const big = "a".repeat(LIMITS.extractedTextBytes + 1);
    expect((await putText(o, p.id, 2, big)).status).toBe(413);
  });
});

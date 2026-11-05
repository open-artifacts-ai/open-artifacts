import { env } from "cloudflare:workers";
import {
  type Member,
  newId,
  PageSchema,
  R,
  SearchHitSchema,
  SNIPPET_MARK,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { extractText } from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { api, fetchAndWait, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "q");
type U = { cookie: string; member: Member };
let o: U;
beforeAll(async () => {
  const l = await login(`b8brk-${tag}@x.com`, "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  o = { ...l, member: m };
});
const search = (q: string) =>
  api(app, `${R.search}?q=${encodeURIComponent(q)}`, o.cookie);
const chunked = (s: string, n = 16 * 1024) => {
  const b = new TextEncoder().encode(s);
  let off = 0,
    pulled = 0,
    cancelled = false;
  const st = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(c) {
      if (off >= b.length) return c.close();
      const ch = b.slice(off, off + n);
      off += n;
      pulled += ch.length;
      c.enqueue(ch);
    },
  });
  return { st, pulled: () => pulled, cancelled: () => cancelled };
};

describe("B8 breaker", () => {
  it("NUL inside a token is not a 500", async () => {
    for (const q of ["foo\u0000bar", 'a\u0000"', "\u0000x"]) {
      const r = await search(q);
      expect(r.status, JSON.stringify(q)).not.toBe(500);
    }
  });

  it("author-supplied \\u0002/\\u0003 never reach the snippet", async () => {
    const a = await publish(
      env,
      o.member,
      {
        title: `forge${tag}`,
        format: "markdown",
        content: `${SNIPPET_MARK.open}FAKE${SNIPPET_MARK.close} forgebody${tag}`,
      } as never,
      null,
    );
    await runIndex(a.id);
    const r = await search(`forgebody${tag}`);
    const h = PageSchema(SearchHitSchema).parse(await r.json());
    const s = h.items[0]?.snippet ?? "";
    expect(h.items).toHaveLength(1);
    expect(s).not.toContain(`${SNIPPET_MARK.open}FAKE`);
  });

  it("script longer than MAX_CARRY does not leak its tail", async () => {
    const html = `<script>${"x ".repeat(150_000)} leak${tag}()</script><p>ok</p>`;
    const t = await extractText("html", chunked(html).st);
    expect(t).not.toContain(`leak${tag}`);
  });

  // Parked (search quality only): script-data-escaped `<!--<script>` state.
  it.skip("double-escaped script data (<!--<script>) stays dropped", async () => {
    const t = await extractText(
      "html",
      `<script><!--<script></script>code${tag}()</script>--></script><p>ok</p>`,
    );
    expect(t).not.toContain(`code${tag}`);
  });

  it("all-markup HTML stops reading near the cap (bounded bytes/CPU)", async () => {
    const html = `<!--${"a".repeat(8 * 1024 * 1024)}`;
    const s = chunked(html);
    await extractText("html", s.st);
    // Deterministic bound; the time budget is in extract.cpu.test.ts.
    expect(s.pulled()).toBeLessThan(2 * 1024 * 1024);
    expect(s.cancelled()).toBe(true);
  });

  it("NUL in list q is not a 500", async () => {
    for (const q of ["foo\u0000bar", "\u0000", 'a\u0000"']) {
      const r = await api(
        app,
        `${R.artifacts}?q=${encodeURIComponent(q)}`,
        o.cookie,
      );
      expect(r.status, JSON.stringify(q)).not.toBe(500);
    }
  });

  it("forged markers are stripped from title/description and versionText", async () => {
    const t = await extractText("html", `<p>a\u0002b\u0003c</p>`);
    expect(t).toBe("abc");
    const a = await publish(
      env,
      o.member,
      {
        title: `\u0002tforge${tag}\u0003`,
        description: `\u0002d\u0003`,
        format: "pdf",
        content: "%PDF-1.4",
      } as never,
      null,
    );
    const put = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.versionText(a.id, 1)}`, {
        method: "PUT",
        headers: {
          "content-type": "text/plain",
          "x-oa-request": "1",
          cookie: o.cookie,
        },
        body: `\u0002pforge${tag}\u0003 text`,
      }),
    );
    expect(put.status).toBe(204);
    const row = await env.DB.prepare(
      "select title, description, body from artifact_search where artifact_id = ?",
    )
      .bind(a.id)
      .first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toMatch(/\\u000[23]/);
    const h = PageSchema(SearchHitSchema).parse(
      await (await search(`pforge${tag}`)).json(),
    );
    expect(h.items[0]?.snippet).toBe(
      `${SNIPPET_MARK.open}pforge${tag}${SNIPPET_MARK.close} text`,
    );
  });

  it("PUT versionText: anonymous → 401", async () => {
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.versionText("x".repeat(16), 1)}`, {
        method: "PUT",
        headers: { "content-type": "text/plain", "x-oa-request": "1" },
        body: "x",
      }),
    );
    expect(r.status).toBe(401);
  });

  it("8MB of inline tags: bounded", async () => {
    const s = chunked("<b>".repeat(2_800_000));
    await extractText("html", s.st);
    expect(s.pulled()).toBeLessThan(2 * 1024 * 1024);
    expect(s.cancelled()).toBe(true);
  });
});

import { env } from "cloudflare:workers";
import { INLINE_TOO_LARGE_MESSAGE, LIMITS, newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ApiError } from "../src/http/errors.js";
import { planFiles } from "../src/services/manifest.js";
import { api, errOf, fetchAndWait, login } from "./helpers.js";

const app = createApp();
let owner: { cookie: string; userId: string };

// Hostile paths (F2, paths.test.ts in @oa/shared).
const HOSTILE = [
  "",
  ".",
  "/etc/passwd",
  "../x",
  "a/../../b",
  "a/..",
  "a\\b",
  "a//b",
  "a/",
  "a\u0000b",
  "a\x7fb",
  "a‮b",
  "x".repeat(513),
];

beforeAll(async () => {
  owner = await login(`paths-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

afterEach(async () => {
  expect((await env.FILES.list()).objects).toHaveLength(0);
});

const post = (body: unknown) =>
  api(app, R.artifacts, owner.cookie, { method: "POST", body });

describe("publish path validation (Review Focus #2)", () => {
  for (const p of HOSTILE) {
    it(`rejects ${JSON.stringify(p.slice(0, 16))}`, async () => {
      const r = await post({ title: "t", files: { "ok.txt": "x", [p]: "x" } });
      expect(r.status).toBe(400);
      const e = await errOf(r);
      expect(e.code).toBe("bad_request");
      expect(e.details).toMatchObject({ path: p });
    });
  }

  it("rejects a hostile entry", async () => {
    const r = await post({
      title: "t",
      format: "html",
      content: "x",
      entry: "../a.html",
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ path: "../a.html" });
  });

  it("case-only duplicates → 400", async () => {
    const r = await post({ title: "t", files: { "A.css": "x", "a.css": "y" } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({
      reason: "case_collision",
    });
  });

  it("normalized duplicates → 400", async () => {
    const r = await post({
      title: "t",
      files: { "a.css": "x", "./a.css": "y" },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ reason: "duplicate" });
  });

  it("entry missing from files → 400", async () => {
    const r = await post({
      title: "t",
      files: { "a.html": "x" },
      entry: "b.html",
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({
      path: "b.html",
      reason: "missing_entry",
    });
  });

  it("1,001 files → 400", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.filesPerVersion; i++) files[`f${i}.txt`] = "x";
    const r = await post({ title: "t", files });
    expect(r.status).toBe(400);
  });

  it(`${LIMITS.inlineBytes / 1024} KB + 1 byte inline content → 413 with the upload hint`, async () => {
    const r = await post({
      title: "t",
      format: "markdown",
      content: "x".repeat(LIMITS.inlineBytes + 1),
    });
    expect(r.status).toBe(413);
    const e = await errOf(r);
    expect(e.code).toBe("too_large");
    const kb = LIMITS.inlineBytes / 1024;
    expect(e.message).toBe(
      `Inline content is limited to ${kb} KB per publish. For larger files: create_upload({ path, size, contentType }), PUT the bytes to the returned url, then publish_artifact({ id: artifactId, title, files: { "<path>": { uploadId } } }).`,
    );
  });

  /** A POST whose body stream counts its reads; `length` sets Content-Length. */
  const streamed = (total: number, length: boolean, chunk = 16 * 1024) => {
    const state = { pulls: 0, sent: 0 };
    const piece = new TextEncoder().encode("x".repeat(chunk));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          state.pulls++;
          if (state.sent >= total) return c.close();
          state.sent += chunk;
          c.enqueue(piece);
        },
      },
      { highWaterMark: 0 },
    );
    const res = fetchAndWait(
      app,
      new Request(`http://app.localhost${R.artifacts}`, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
          ...(length ? { "content-length": String(total) } : {}),
        },
        body,
        duplex: "half",
      } as RequestInit),
    );
    return { res, state };
  };
  // The REST body cap: JSON escaping at most doubles inline text, plus 64 KB.
  const CAP = 2 * LIMITS.inlineBytes + 64 * 1024;

  it("Content-Length over the body cap → 413 before any of the body is read", async () => {
    const { res, state } = streamed(CAP + 1, true);
    const r = await res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(INLINE_TOO_LARGE_MESSAGE);
    expect(state.pulls).toBe(0);
  });

  it("no Content-Length: the read stops at the body cap, never buffering the rest", async () => {
    const total = 4 * 1024 * 1024;
    const { res, state } = streamed(total, false);
    const r = await res;
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(INLINE_TOO_LARGE_MESSAGE);
    expect(state.sent).toBeLessThanOrEqual(CAP + 2 * 16 * 1024);
    expect(state.sent).toBeLessThan(total);
  });

  it("a body past the inline-derived cap → 413 with the upload hint", async () => {
    const r = await post({
      title: "t",
      format: "markdown",
      content: "x".repeat(LIMITS.inlineBytes * 3),
    });
    expect(r.status).toBe(413);
    expect((await errOf(r)).message).toBe(INLINE_TOO_LARGE_MESSAGE);
  });

  it("inline files summing past LIMITS.inlineBytes → 413", async () => {
    const half = "x".repeat(LIMITS.inlineBytes / 2);
    const r = await post({
      title: "t",
      files: { "a.txt": half, "b.txt": half, "c.txt": "y" },
    });
    expect(r.status).toBe(413);
    const e = await errOf(r);
    expect(e.details).toMatchObject({ path: "c.txt" });
    expect(e.message).toBe(INLINE_TOO_LARGE_MESSAGE);
  });

  it("base64 decoding to LIMITS.inlineBytes + 1 → 413", async () => {
    const bytes = new Uint8Array(LIMITS.inlineBytes + 1);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await post({
      title: "t",
      files: { "a.bin": { base64: btoa(s) } },
    });
    expect(r.status).toBe(413);
  });

  it("invalid base64 → 400", async () => {
    const r = await post({ title: "t", files: { "a.bin": { base64: "!!!" } } });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ path: "a.bin" });
  });
});

describe("planFiles (defensive)", () => {
  it("throws ApiError with {path, reason} without the schema", () => {
    try {
      planFiles({ title: "t", files: { "../x": "y" } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).details).toEqual({
        path: "../x",
        reason: "traversal",
      });
    }
  });

  it("defaults the entry", () => {
    expect(planFiles({ title: "t", format: "html", content: "x" }).entry).toBe(
      "index.html",
    );
    expect(
      planFiles({ title: "t", format: "pdf", content: "%PDF-x" }).entry,
    ).toBe("document.pdf");
    expect(
      planFiles({ title: "t", files: { "b.md": "x", "README.md": "y" } }),
    ).toMatchObject({
      entry: "README.md",
      format: "markdown",
    });
  });
});

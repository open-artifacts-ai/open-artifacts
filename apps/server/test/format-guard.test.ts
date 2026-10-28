// Publishing a file no viewer can show (a phone JPEG became a `code`
// artifact and the viewer hung): inference, content checks, nothing written.
import { env } from "cloudflare:workers";
import { newId, R, UNSUPPORTED_FORMAT_MESSAGE } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
let owner: { cookie: string; userId: string };

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

beforeAll(async () => {
  owner = await login(`fmt-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

const post = (body: unknown) =>
  api(app, R.artifacts, owner.cookie, { method: "POST", body });

/** R2 holds no object and D1 no artifact titled `title`. */
async function nothingWritten(title: string) {
  const row = await env.DB.prepare("select 1 from artifacts where title = ?")
    .bind(title)
    .first();
  expect(row).toBeNull();
}

describe("inferred format", () => {
  it("a .jpg entry without format is refused, nothing written", async () => {
    const title = `jpg-${newId()}`;
    const before = (await env.FILES.list()).objects.length;
    const r = await post({
      title,
      files: { "IMG_0042.JPG": { base64: b64(JPEG) } },
    });
    expect(r.status).toBe(400);
    expect(await errOf(r)).toEqual({
      code: "unsupported_format",
      message: UNSUPPORTED_FORMAT_MESSAGE,
      details: { path: "IMG_0042.JPG", reason: "no_viewer" },
    });
    expect((await env.FILES.list()).objects.length).toBe(before);
    await nothingWritten(title);
  });

  it("inline content with an unknown entry that isn't text is refused", async () => {
    const r = await post({
      title: "t",
      entry: "data.bin",
      content: "a\u0000b",
    });
    expect(r.status).toBe(400);
    expect(await errOf(r)).toEqual({
      code: "unsupported_format",
      message: UNSUPPORTED_FORMAT_MESSAGE,
      details: { path: "data.bin", reason: "no_viewer" },
    });
  });

  it("an explicit format skips inference", async () => {
    const r = await post({
      title: "t",
      entry: "data.bin",
      format: "code",
      content: "plain text",
    });
    expect(r.status).toBe(201);
  });

  it("the message names what can be published, with no em dash", () => {
    expect(UNSUPPORTED_FORMAT_MESSAGE).toBe(
      "This file type can't be shown yet. Publish HTML, Markdown, code or PDF.",
    );
    expect(UNSUPPORTED_FORMAT_MESSAGE).not.toMatch(/—/);
  });

  it("known text still infers code", async () => {
    const r = await post({ title: "t", files: { "notes.txt": "hello" } });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "text" });
  });

  it("a text file with no extension (LICENSE) publishes as code, language text", async () => {
    const r = await post({ title: "t", files: { LICENSE: "MIT License\n" } });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "text" });
  });

  it("text under a name that implies no format (.gitignore, notes.foo) publishes as code", async () => {
    for (const name of [".gitignore", "notes.foo"]) {
      const r = await post({ title: "t", files: { [name]: "dist/\n" } });
      expect(r.status, name).toBe(201);
    }
  });

  it(".jsonl infers code", async () => {
    const r = await post({
      title: "t",
      files: { "rows.jsonl": '{"a":1}\n{"a":2}\n' },
    });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "text" });
  });

  it("svg as code publishes", async () => {
    const r = await post({
      title: "t",
      files: { "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "xml" });
  });

  it("a UTF-8 BOM and an empty file are text", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    for (const [name, bytes] of [
      ["bom.md", bom],
      ["NOTES", bom],
      ["empty.txt", new Uint8Array()],
      ["EMPTY", new Uint8Array()],
    ] as const) {
      const r = await post({
        title: "t",
        files: { [name]: { base64: b64(bytes) } },
      });
      expect(r.status, name).toBe(201);
    }
  });

  it("text that starts with GIF89a, %PDF or fLaC is text", async () => {
    for (const [name, content] of [
      ["gif.md", "GIF89a is a GIF header."],
      ["pdf.txt", "%PDF-1.7 is how a PDF starts."],
      ["flac.md", "fLaC is FLAC's magic."],
      ["README", "GIF89a notes"],
    ] as const) {
      const r = await post({ title: "t", files: { [name]: content } });
      expect(r.status, name).toBe(201);
    }
  });
});

/** The created artifact's format and its current version's language. */
async function formatOf(r: Response) {
  const { id } = (await r.json()) as { id: string };
  const a = (await (await api(app, R.artifact(id), owner.cookie)).json()) as {
    format: string;
  };
  const [v] = (await (await api(app, R.versions(id), owner.cookie)).json()) as {
    language: string | null;
  }[];
  return { format: a.format, language: v?.language ?? null };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** Reserves an upload, PUTs `bytes`, returns its ids. */
async function uploaded(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  contentType?: string,
) {
  const r = await api(app, R.uploads, owner.cookie, {
    method: "POST",
    body: { path, size: bytes.length, ...(contentType ? { contentType } : {}) },
  });
  expect(r.status).toBe(201);
  const up = (await r.json()) as {
    uploadId: string;
    artifactId: string;
    url: string;
  };
  const u = new URL(up.url);
  const p = await app.fetch(
    new Request(`http://app.localhost${u.pathname}${u.search}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-length": String(bytes.length) },
    }),
    env,
    ctx,
  );
  expect(p.status).toBe(204);
  return up;
}

const consumed = async (id: string) =>
  (
    await env.DB.prepare("select consumed from uploads where id = ?")
      .bind(id)
      .first<{ consumed: number }>()
  )?.consumed;

const text = (s: string) => new TextEncoder().encode(s);

/** Publishes `up` as the entry; expects 400 binary_entry with `reason`, nothing written or consumed. */
async function refusedUpload(
  path: string,
  up: { uploadId: string; artifactId: string },
  format: string | undefined,
  reason: string,
) {
  const before = (await env.FILES.list()).objects.length;
  const title = `up-${newId()}`;
  const r = await post({
    id: up.artifactId,
    title,
    ...(format ? { format } : {}),
    entry: path,
    files: { [path]: { uploadId: up.uploadId }, "extra.txt": "inline" },
  });
  expect(r.status).toBe(400);
  const e = await errOf(r);
  expect(e.code).toBe("binary_entry");
  expect(e.details).toEqual({ path, reason });
  expect(e.message).not.toMatch(/—/);
  expect((await env.FILES.list()).objects.length).toBe(before);
  expect(await consumed(up.uploadId)).toBe(0);
  await nothingWritten(title);
}

describe("entry content: inline", () => {
  it("a JPEG as explicit code is refused, nothing written", async () => {
    const title = `inl-${newId()}`;
    const before = (await env.FILES.list()).objects.length;
    const r = await post({
      title,
      format: "code",
      entry: "photo.txt",
      files: { "photo.txt": { base64: b64(JPEG) } },
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.code).toBe("binary_entry");
    expect(e.details).toEqual({ path: "photo.txt", reason: "binary" });
    expect(e.message).toContain("JPEG");
    expect((await env.FILES.list()).objects.length).toBe(before);
    await nothingWritten(title);
  });

  for (const format of ["code", "markdown", "html"] as const)
    it(`a NUL byte in ${format} content is refused`, async () => {
      const r = await post({ title: "t", format, content: "a\u0000b" });
      expect(r.status).toBe(400);
      expect((await errOf(r)).details).toMatchObject({ reason: "not_text" });
    });

  it("invalid UTF-8 bytes as markdown are refused", async () => {
    const r = await post({
      title: "t",
      entry: "a.md",
      files: { "a.md": { base64: b64(new Uint8Array([0x23, 0xc3, 0x28])) } },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual({
      path: "a.md",
      reason: "not_text",
    });
  });

  it("a pdf that doesn't start with %PDF is refused", async () => {
    const r = await post({ title: "t", format: "pdf", content: "hello" });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual({
      path: "document.pdf",
      reason: "not_pdf",
    });
  });

  it("text over 8 KB with a multi-byte character at the boundary is fine", async () => {
    const r = await post({
      title: "t",
      format: "code",
      content: `a${"€".repeat(4000)}`,
    });
    expect(r.status).toBe(201);
  });

  it("a binary non-entry file is not checked", async () => {
    const r = await post({
      title: "t",
      entry: "index.html",
      files: {
        "index.html": "<img src=a.jpg>",
        "a.jpg": { base64: b64(JPEG) },
      },
    });
    expect(r.status).toBe(201);
  });
});

describe("entry content: uploads", () => {
  it("an uploaded .jpg without format is unsupported_format, not consumed", async () => {
    const up = await uploaded("IMG_0042.jpg", new Uint8Array(JPEG));
    const r = await post({
      id: up.artifactId,
      title: "t",
      files: { "IMG_0042.jpg": { uploadId: up.uploadId } },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).code).toBe("unsupported_format");
    expect(await consumed(up.uploadId)).toBe(0);
  });

  it("an image/jpeg upload of JPEG bytes as explicit code is refused", async () => {
    const path = "photo.jpg";
    const up = await uploaded(path, new Uint8Array(JPEG), "image/jpeg");
    await refusedUpload(path, up, "code", "binary");
  });

  it("non-text bytes declared audio/* as code are refused by their content type", async () => {
    const path = "clip.txt";
    const bytes = new Uint8Array([0x61, 0x00, 0x62]);
    const up = await uploaded(path, bytes, "audio/mpeg");
    await refusedUpload(path, up, "code", "content_type");
  });

  it("an uploaded text file with no extension publishes as code; binary is unsupported_format", async () => {
    const ok = await uploaded("LICENSE", text("MIT License\n"));
    const r = await post({
      id: ok.artifactId,
      title: "t",
      files: { LICENSE: { uploadId: ok.uploadId } },
    });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "text" });

    const bin = await uploaded("blob", new Uint8Array(JPEG));
    const before = (await env.FILES.list()).objects.length;
    const b = await post({
      id: bin.artifactId,
      title: "t",
      files: { blob: { uploadId: bin.uploadId }, "x.txt": "inline" },
    });
    expect(b.status).toBe(400);
    expect(await errOf(b)).toEqual({
      code: "unsupported_format",
      message: UNSUPPORTED_FORMAT_MESSAGE,
      details: { path: "blob", reason: "no_viewer" },
    });
    expect(await consumed(bin.uploadId)).toBe(0);
    expect((await env.FILES.list()).objects.length).toBe(before);
  });

  it("an octet-stream upload as explicit code on notes.foo publishes (no claim)", async () => {
    const path = "notes.foo";
    const up = await uploaded(path, text("# hi"), "application/octet-stream");
    const r = await post({
      id: up.artifactId,
      title: "t",
      format: "code",
      files: { [path]: { uploadId: up.uploadId } },
    });
    expect(r.status).toBe(201);
  });

  it("a .ts upload declared video/mp2t publishes: the bytes decide", async () => {
    const path = "main.ts";
    const up = await uploaded(
      path,
      text("export const a = 1;\n"),
      "video/mp2t",
    );
    const r = await post({
      id: up.artifactId,
      title: "t",
      files: { [path]: { uploadId: up.uploadId } },
    });
    expect(r.status).toBe(201);
    expect(await formatOf(r)).toEqual({ format: "code", language: "ts" });
  });

  it("a GIF89a-prefixed text upload is text (uploads are never empty)", async () => {
    for (const [path, bytes] of [
      ["gif.md", text("GIF89a, the header, explained")],
    ] as const) {
      const up = await uploaded(path, bytes);
      const r = await post({
        id: up.artifactId,
        title: "t",
        files: { [path]: { uploadId: up.uploadId } },
      });
      expect(r.status, path).toBe(201);
    }
  });

  it("JPEG bytes uploaded as main.py (default type) are refused by the range read", async () => {
    const path = "main.py";
    const big = new Uint8Array(20_000);
    big.set(JPEG);
    const up = await uploaded(path, big);
    await refusedUpload(path, up, undefined, "binary");
  });

  it("a NUL byte in an uploaded html entry is refused", async () => {
    const path = "index.html";
    const up = await uploaded(path, text("<p>a\u0000</p>"));
    await refusedUpload(path, up, undefined, "not_text");
  });

  it("an uploaded pdf without %PDF is refused", async () => {
    const path = "doc.pdf";
    const up = await uploaded(path, text("not a pdf"));
    await refusedUpload(path, up, undefined, "not_pdf");
  });

  it("a large text upload cut mid-character at 8 KB publishes", async () => {
    const path = "big.txt";
    const up = await uploaded(path, text(`a${"€".repeat(10_000)}`));
    const r = await post({
      id: up.artifactId,
      title: "t",
      files: { [path]: { uploadId: up.uploadId } },
    });
    expect(r.status).toBe(201);
    expect(await consumed(up.uploadId)).toBe(1);
  });

  it("a real pdf upload publishes", async () => {
    const path = "doc.pdf";
    const up = await uploaded(path, text("%PDF-1.4\n%..."));
    const r = await post({
      id: up.artifactId,
      title: "t",
      files: { [path]: { uploadId: up.uploadId } },
    });
    expect(r.status).toBe(201);
  });
});

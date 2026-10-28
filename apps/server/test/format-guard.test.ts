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

  it("inline content with an unknown entry is refused", async () => {
    const r = await post({ title: "t", entry: "data.bin", content: "x" });
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
    const { id } = (await r.json()) as { id: string };
    const a = (await (await api(app, R.artifact(id), owner.cookie)).json()) as {
      format: string;
    };
    expect(a.format).toBe("code");
  });
});

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

  it("an image/jpeg upload as explicit code is refused by its content type", async () => {
    const path = "photo.jpg";
    const up = await uploaded(path, new Uint8Array(JPEG), "image/jpeg");
    await refusedUpload(path, up, "code", "content_type");
  });

  it("an octet-stream upload with an unknown name as markdown is refused", async () => {
    const path = "notes.dat";
    const up = await uploaded(path, text("# hi"), "application/octet-stream");
    await refusedUpload(path, up, "markdown", "content_type");
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

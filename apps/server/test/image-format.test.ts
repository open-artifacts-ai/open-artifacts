// The image format (PNG, JPEG, GIF, WebP, SVG): publish validation, serving
// on the content host, title-only search, the thumbnail from the image
// itself, and "image" in the API, list filter and search.
import { env } from "cloudflare:workers";
import { type Member, newId, PageSchema, R, SearchHitSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { IMAGE_CSP } from "../src/content/app.js";
import {
  publicPrefix,
  signContent,
  signDownload,
} from "../src/content/signing.js";
import { publish } from "../src/services/artifacts.js";
import { IMAGE_THUMB } from "../src/services/thumbs.js";
import { getUser } from "../src/services/users.js";
import { contentCall, fakeAssets } from "./assets-stub.js";
import { api, errOf, login, runIndex } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
let owner: { cookie: string; userId: string; member: Member };

const u8 = (...xs: number[]) => new Uint8Array(xs);
const s = (x: string) => new TextEncoder().encode(x);
const b64 = (b: Uint8Array) => {
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000)
    out += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(out);
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
/** A PNG header of `w` × `h` (IHDR), padded to `size` bytes. */
const png = (w: number, h: number, size = 64) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  b.set(s("IHDR"), 12);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const JPEG = u8(
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x04,
  0x00,
  0x00,
  0xff,
  0xc0,
  0x00,
  0x11,
  0x08,
  0x00,
  0x10,
  0x00,
  0x20,
  0x03,
);
const GIF = cat(s("GIF89a"), u8(4, 0, 3, 0, 0, 0, 0, 0x3b));
const WEBP = cat(
  s("RIFF"),
  u8(0, 0, 0, 0),
  s("WEBPVP8X"),
  u8(10, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 9, 0, 0),
);
const SVG = (word = "") =>
  `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>${word}</text></svg>`;

beforeAll(async () => {
  const l = await login(`img-${tag}@x.com`, "member");
  owner = { ...l, member: (await getUser(env, l.userId)) as Member };
});

const post = (body: unknown) =>
  api(app, R.artifacts, owner.cookie, { method: "POST", body });
const json = async <T = Record<string, unknown>>(r: Response) =>
  (await r.json()) as T;
const pubImage = async (files: Record<string, unknown>, title?: string) => {
  const r = await post({ title: title ?? `img ${newId()}`, files });
  expect(r.status, JSON.stringify(await r.clone().text())).toBe(201);
  return (await r.json()) as { id: string; version: number };
};

/** Reserves an upload, PUTs `bytes`, returns its ids. */
async function uploaded(path: string, bytes: Uint8Array, contentType?: string) {
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
      body: bytes as Uint8Array<ArrayBuffer>,
      headers: { "content-length": String(bytes.length) },
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
  expect(p.status).toBe(204);
  return up;
}

describe("image: publish", () => {
  it("png, jpg, jpeg, gif, webp and svg publish as image, one file, entry the image", async () => {
    for (const [name, bytes] of [
      ["a.png", png(2, 2)],
      ["b.jpg", JPEG],
      ["c.JPEG", JPEG],
      ["d.gif", GIF],
      ["e.webp", WEBP],
    ] as const) {
      const { id } = await pubImage({ [name]: { base64: b64(bytes) } });
      const a = await json(await api(app, R.artifact(id), owner.cookie));
      expect(a.format, name).toBe("image");
      const [v] = await json<
        {
          entry: string;
          format: string;
          language: string | null;
          files: unknown[];
        }[]
      >(await api(app, R.versions(id), owner.cookie));
      expect(v).toMatchObject({ entry: name, format: "image", language: null });
      expect(v?.files).toHaveLength(1);
    }
    const svg = await pubImage({ "logo.svg": SVG() });
    expect(
      (await json(await api(app, R.artifact(svg.id), owner.cookie))).format,
    ).toBe("image");
    // Inline content with format image is an SVG (content is text).
    const inline = await post({
      title: "inline",
      format: "image",
      content: SVG(),
    });
    expect(inline.status).toBe(201);
  });

  it("a mismatch between extension and bytes is 400 binary_entry with a reason", async () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ "a.png": { base64: b64(JPEG) } }, "a.png", "not_image"],
      [
        {
          "a.webp": { base64: b64(cat(s("RIFF"), u8(0, 0, 0, 0), s("WAVE"))) },
        },
        "a.webp",
        "not_image",
      ],
      [{ "a.svg": "<html><svg/></html>" }, "a.svg", "not_svg"],
      [{ "a.svg": { base64: b64(png(1, 1)) } }, "a.svg", "not_svg"],
    ];
    for (const [files, path, reason] of cases) {
      const r = await post({ title: "bad", files });
      expect(r.status, path).toBe(400);
      const e = await errOf(r);
      expect(e.code).toBe("binary_entry");
      expect(e.details).toEqual({ path, reason });
      expect(e.message).not.toMatch(/—/);
    }
    const named = await post({
      title: "bad",
      format: "image",
      entry: "a.bin",
      files: { "a.bin": { base64: b64(png(1, 1)) } },
    });
    expect((await errOf(named)).details).toEqual({
      path: "a.bin",
      reason: "not_image",
    });
  });

  it("a declared upload content type must agree; octet-stream claims nothing", async () => {
    const bad = await uploaded("p.png", png(2, 2), "image/jpeg");
    const r = await post({
      id: bad.artifactId,
      title: "t",
      files: { "p.png": { uploadId: bad.uploadId } },
    });
    expect(r.status).toBe(400);
    expect(await errOf(r)).toEqual({
      code: "binary_entry",
      message:
        '"p.png" was uploaded as image/jpeg, but a .png image is image/png.',
      details: { path: "p.png", reason: "content_type" },
    });
    for (const ct of ["image/png", "application/octet-stream", undefined]) {
      const ok = await uploaded("p.png", png(2, 2), ct);
      const o = await post({
        id: ok.artifactId,
        title: "t",
        files: { "p.png": { uploadId: ok.uploadId } },
      });
      expect(o.status, String(ct)).toBe(201);
    }
    const wrong = await uploaded("q.jpg", png(2, 2), "image/jpeg");
    const w = await post({
      id: wrong.artifactId,
      title: "t",
      files: { "q.jpg": { uploadId: wrong.uploadId } },
    });
    expect((await errOf(w)).details).toEqual({
      path: "q.jpg",
      reason: "not_image",
    });
  });

  it("an image artifact is one file", async () => {
    const r = await post({
      title: "two",
      entry: "a.png",
      files: {
        "a.png": { base64: b64(png(1, 1)) },
        "b.png": { base64: b64(png(1, 1)) },
      },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toEqual({
      path: "files",
      reason: "image_single_file",
    });
  });

  it("HEIC is unsupported_format (heic), by name or bytes, with or without format", async () => {
    const heic = cat(u8(0, 0, 0, 0x18), s("ftypheic"), u8(0, 0, 0, 0));
    const want = (path: string) => ({
      code: "unsupported_format",
      message: "HEIC photos can't be shown yet. Save as JPEG and upload again.",
      details: { path, reason: "heic" },
    });
    for (const body of [
      { files: { "IMG_1.HEIC": { base64: b64(heic) } } },
      { format: "image", files: { "IMG_1.heif": { base64: b64(JPEG) } } },
      { format: "image", files: { "IMG_1.jpg": { base64: b64(heic) } } },
      { format: "code", files: { "IMG_1.txt": { base64: b64(heic) } } },
      {
        files: {
          "IMG_1.jpg": { base64: b64(cat(u8(0, 0, 0, 0x18), s("ftypmif1"))) },
        },
      },
    ]) {
      const r = await post({ title: "heic", ...body });
      expect(r.status).toBe(400);
      expect(await errOf(r)).toEqual(
        want(Object.keys(body.files)[0] as string),
      );
    }
    // An upload: by name before any read, by bytes in the range read.
    const up = await uploaded("IMG_2.jpg", heic, "image/jpeg");
    const r = await post({
      id: up.artifactId,
      title: "heic",
      files: { "IMG_2.jpg": { uploadId: up.uploadId } },
    });
    expect(await errOf(r)).toEqual(want("IMG_2.jpg"));
  });

  it("existing upload size limits apply", async () => {
    const r = await api(app, R.uploads, owner.cookie, {
      method: "POST",
      body: { path: "huge.png", size: 26 * 1024 * 1024 },
    });
    expect(r.status).toBe(413);
  });
});

describe("image: content host", () => {
  const signed = async (id: string, v = 1) =>
    (await signContent(env, id, v, Date.now(), 600)).prefix;
  const get = (path: string, headers: Record<string, string> = {}) =>
    contentCall(path, { headers: { "sec-fetch-dest": "image", ...headers } });

  it("serves the real type, nosniff, inline and the image CSP", async () => {
    for (const [name, bytes, type] of [
      ["a.png", png(2, 2), "image/png"],
      ["b.jpg", JPEG, "image/jpeg"],
      ["c.gif", GIF, "image/gif"],
      ["d.webp", WEBP, "image/webp"],
    ] as const) {
      // Declared octet-stream at upload: served as its real type anyway.
      const up = await uploaded(name, bytes, "application/octet-stream");
      const { id } = (await (
        await post({
          id: up.artifactId,
          title: "t",
          files: { [name]: { uploadId: up.uploadId } },
        })
      ).json()) as { id: string };
      const r = await get(`${await signed(id)}${name}`);
      expect(r.status, name).toBe(200);
      expect(r.headers.get("content-type")).toBe(type);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-disposition")).toBe("inline");
      expect(r.headers.get("content-security-policy")).toMatch(
        new RegExp(
          `^${IMAGE_CSP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; frame-ancestors `,
        ),
      );
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    }
  });

  it("a raw SVG gets the same sandbox CSP and its exact type", async () => {
    const { id } = await pubImage({ "logo.svg": SVG() });
    const r = await get(`${await signed(id)}logo.svg`, {
      "sec-fetch-dest": "iframe",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith(IMAGE_CSP)).toBe(true);
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/; sandbox;/);
    expect(csp).not.toMatch(/allow-scripts/);
    // A top-level visit never renders it: it goes to the viewer.
    const top = await get(`${await signed(id)}logo.svg`, {
      "sec-fetch-dest": "document",
    });
    expect(top.status).toBe(303);
  });

  it("a download is still an attachment; other formats keep the artifact sandbox", async () => {
    const { id } = await pubImage({ "a.png": { base64: b64(png(2, 2)) } });
    const { path } = await signDownload(env, id, 1, "a.png");
    const dl = await get(path);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(dl.headers.get("content-type")).toBe("image/png");
    // A png inside an html site is not an image artifact: unchanged.
    const site = await publish(
      env,
      owner.member,
      {
        title: "site",
        entry: "index.html",
        files: {
          "index.html": "<img src=a.png>",
          "a.png": { base64: b64(png(1, 1)) },
        },
      } as never,
      null,
    );
    const r = await get(`${await signed(site.id)}a.png`);
    expect(
      r.headers.get("content-security-policy")?.startsWith(IMAGE_CSP),
    ).toBe(false);
    expect(r.headers.get("content-disposition")).toBeNull();
  });

  it("a public image on /p/ gets the same headers", async () => {
    const r0 = await post({
      title: "pub",
      visibility: "public",
      files: { "pub.svg": SVG() },
    });
    expect(r0.status).toBe(201);
    const { id } = (await r0.json()) as { id: string };
    const r = await get(`${publicPrefix(id, 1)}pub.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(
      r.headers.get("content-security-policy")?.startsWith(IMAGE_CSP),
    ).toBe(true);
    expect(r.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  it("a byte range is 206 with the image headers", async () => {
    const bytes = png(4, 4, 256);
    const { id } = await pubImage({ "r.png": { base64: b64(bytes) } });
    const r = await get(`${await signed(id)}r.png`, { range: "bytes=8-23" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 8-23/256");
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(
      r.headers.get("content-security-policy")?.startsWith(IMAGE_CSP),
    ).toBe(true);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(
      bytes.subarray(8, 24),
    );
    const bad = await get(`${await signed(id)}r.png`, { range: "bytes=999-" });
    expect(bad.status).toBe(416);
    expect(
      bad.headers.get("content-security-policy")?.startsWith(IMAGE_CSP),
    ).toBe(false);
  });

  it("__view is the renderer page with the entry and its content type", async () => {
    const { id } = await pubImage({ "pics/a.png": { base64: b64(png(2, 2)) } });
    const r = await contentCall(
      `${await signed(id)}__view`,
      { headers: { "sec-fetch-dest": "iframe" } },
      fakeAssets().fetcher,
    );
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<meta name="oa-entry" content="pics/a.png">');
    expect(html).toContain('<meta name="oa-format" content="image">');
    expect(html).toContain('<meta name="oa-content-type" content="image/png">');
  });
});

describe("image: search and thumbnails", () => {
  const Hits = PageSchema(SearchHitSchema);
  const hits = async (q: string, extra = "") => {
    const r = await api(
      app,
      `${R.search}?q=${encodeURIComponent(q)}${extra}`,
      owner.cookie,
    );
    expect(r.status).toBe(200);
    return Hits.parse(await r.json()).items;
  };
  const fts = async (id: string) =>
    await env.DB.prepare(
      "select s.title, s.body from artifact_search s join artifacts a on a.rowid = s.rowid where a.id = ?",
    )
      .bind(id)
      .first<{ title: string; body: string }>();

  it("indexes the title only, never the bytes, and appears as image", async () => {
    const word = `zimg${tag}`;
    const inSvg = `zsvgtext${tag}`;
    const { id } = await pubImage({ "w.svg": SVG(inSvg) }, `Chart ${word}`);
    const png1 = await pubImage(
      { "p.png": { base64: b64(cat(png(1, 1), s(` zpngbytes${tag} `))) } },
      `Photo ${word}`,
    );
    await runIndex(id);
    await runIndex(png1.id);
    expect(await fts(id)).toEqual({ title: `Chart ${word}`, body: "" });
    expect(await fts(png1.id)).toEqual({ title: `Photo ${word}`, body: "" });
    const v = await env.DB.prepare(
      "select text_indexed from versions where artifact_id = ?",
    )
      .bind(id)
      .first<{ text_indexed: number }>();
    expect(v?.text_indexed).toBe(1);
    expect(await hits(inSvg)).toEqual([]);
    expect(await hits(`zpngbytes${tag}`)).toEqual([]);
    const found = await hits(word);
    expect(found.map((h) => h.id).sort()).toEqual([id, png1.id].sort());
    expect(new Set(found.map((h) => h.format))).toEqual(new Set(["image"]));
  });

  it("the list filter returns images", async () => {
    const { id } = await pubImage({ "l.gif": { base64: b64(GIF) } });
    const r = await api(
      app,
      `${R.artifacts}?format=image&limit=100`,
      owner.cookie,
    );
    const items = (await json<{ items: { id: string; format: string }[] }>(r))
      .items;
    expect(items.map((i) => i.id)).toContain(id);
    expect(new Set(items.map((i) => i.format))).toEqual(new Set(["image"]));
  });

  const thumb = (id: string) => api(app, R.thumbnail(id), owner.cookie);

  it("a small raster is its own thumbnail, served with its type", async () => {
    for (const [name, bytes, type] of [
      ["t.png", png(64, 48, 512), "image/png"],
      ["t.jpg", JPEG, "image/jpeg"],
      ["t.gif", GIF, "image/gif"],
      ["t.webp", WEBP, "image/webp"],
    ] as const) {
      const { id } = await pubImage({ [name]: { base64: b64(bytes) } });
      await runIndex(id);
      const r = await thumb(id);
      expect(r.status, name).toBe(200);
      expect(r.headers.get("content-type")).toBe(type);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
      const a = await env.DB.prepare(
        "select has_thumbnail h, thumbnail_version t from artifacts where id = ?",
      )
        .bind(id)
        .first();
      expect(a).toEqual({ h: 1, t: 1 });
    }
  });

  it("SVG, an oversized raster and a huge-dimension raster get the placeholder", async () => {
    const svg = await pubImage({ "s.svg": SVG() });
    const side = await pubImage({
      "big.png": { base64: b64(png(IMAGE_THUMB.maxSide + 1, 10)) },
    });
    const heavy = await uploaded(
      "heavy.png",
      png(10, 10, IMAGE_THUMB.bytes + 1),
      "image/png",
    );
    const h = await post({
      id: heavy.artifactId,
      title: "heavy",
      files: { "heavy.png": { uploadId: heavy.uploadId } },
    });
    expect(h.status).toBe(201);
    for (const id of [svg.id, side.id, heavy.artifactId]) {
      await runIndex(id);
      expect((await thumb(id)).status, id).toBe(404);
    }
  });

  it("a new SVG version replaces an older raster thumbnail with the placeholder", async () => {
    const first = await pubImage({ "x.png": { base64: b64(png(8, 8)) } });
    await runIndex(first.id);
    expect((await thumb(first.id)).status).toBe(200);
    const r = await api(app, R.versions(first.id), owner.cookie, {
      method: "POST",
      body: { files: { "x.svg": SVG() } },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    await runIndex(first.id);
    expect((await thumb(first.id)).status).toBe(404);
  });
});

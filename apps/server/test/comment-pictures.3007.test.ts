// #3007: a comment picture is downscaled at upload, but only when it is
// beyond the store limits (longest side over 1568 px, or over 3 MB). Anything
// at or under them is stored exactly as uploaded. A failed resize never costs
// the upload. The images here are real PNGs (pixel-png.ts), so the Images
// binding in the test pool actually decodes them.
import { env } from "cloudflare:workers";
import {
  type CommentPicture,
  type CommentPictureReserved,
  imageSize,
  type Member,
  newId,
  R,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { publish } from "../src/services/artifacts.js";
import {
  beyondStoreLimits,
  fitForStorage,
  getPicture,
  PICTURE_STORE_MAX_BYTES,
  PICTURE_STORE_MAX_SIDE,
  previewForAgent,
} from "../src/services/comment-pictures.js";
import { readPicture } from "../src/services/picture-image.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, fetchAndWait, login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";
import { greyPng } from "./pixel-png.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const MB = 1024 * 1024;
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async () =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>hello</p>",
        comments: "everyone",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const reserve = (id: string, body: unknown) =>
  api(app, R.commentPictures(id), owner.cookie, { method: "POST", body });

const put = (url: string, bytes: Uint8Array, e: unknown = env) => {
  const u = new URL(url);
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${u.pathname}${u.search}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body: bytes as BodyInit,
    }),
    e,
  );
};

/** Reserves and uploads one PNG; the Picture as the server answered it. */
async function upload(
  id: string,
  bytes: Uint8Array,
  type = "image/png",
  e: unknown = env,
): Promise<CommentPicture> {
  const r = await reserve(id, { type, bytes: bytes.length });
  expect(r.status).toBe(201);
  const { url } = (await r.json()) as CommentPictureReserved;
  const p = await put(url, bytes, e);
  expect(p.status, await p.clone().text()).toBe(200);
  return (await p.json()) as CommentPicture;
}

const thread = (id: string, pictures: unknown, body = "look") =>
  api(app, R.comments(id), owner.cookie, {
    method: "POST",
    body: { anchor: { kind: "note" }, body, pictures },
  });

/** base64 of the whole array, in chunks: a 200 KB spread would overflow. */
const b64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
};

const r2 = async (pictureId: string): Promise<Uint8Array | null> => {
  const row = await env.DB.prepare(
    "select r2_key from comment_pictures where id = ?",
  )
    .bind(pictureId)
    .first<{ r2_key: string }>();
  const o = row ? await env.FILES.get(row.r2_key) : null;
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
};

const row = (pictureId: string) =>
  env.DB.prepare("select w, h, bytes, type from comment_pictures where id = ?")
    .bind(pictureId)
    .first<{ w: number; h: number; bytes: number; type: string }>();

/** A 4000 by 3000 picture of about 4.9 MB: past the limits on both counts. */
const big = () => greyPng(4000, 3000, { bits: 3 });
/** 4000 by 3000 and a few KB: past the limits on its longest side alone. */
const huge = () => greyPng(4000, 3000, { bits: 0 });
/** 800 by 600 of about 200 KB: far under both limits. */
const small = () => greyPng(800, 600, { bits: 3 });

beforeAll(async () => {
  owner = await mk("own");
});

describe("the store decision (#3007)", () => {
  it("is past the limits over 1568 px on the longest side, or over 3 MB", () => {
    const at = { w: 1568, h: 1568, bytes: PICTURE_STORE_MAX_BYTES };
    expect(beyondStoreLimits(at)).toBe(false);
    expect(beyondStoreLimits({ ...at, w: 1569 })).toBe(true);
    expect(beyondStoreLimits({ ...at, h: 1569 })).toBe(true);
    expect(
      beyondStoreLimits({ ...at, bytes: PICTURE_STORE_MAX_BYTES + 1 }),
    ).toBe(true);
    // A tall, narrow picture is judged on its longest side, not its area.
    expect(beyondStoreLimits({ w: 32, h: 3136, bytes: 2_000 })).toBe(true);
    expect(beyondStoreLimits({ w: 4000, h: 3000, bytes: 2000 })).toBe(true);
    expect(beyondStoreLimits({ w: 800, h: 600, bytes: 200 * 1024 })).toBe(
      false,
    );
  });

  it("has the limits the agent read path uses", () => {
    expect(PICTURE_STORE_MAX_SIDE).toBe(1568);
    expect(PICTURE_STORE_MAX_BYTES).toBe(3 * MB);
  });

  it("keeps the original bytes when Images is absent", async () => {
    const read = readPicture(big());
    if (typeof read === "string") throw new Error(read);
    const { IMAGES: _images, ...withoutImages } = env;
    const stored = await fitForStorage(withoutImages as never, read);
    expect(stored.downscaled).toBe(false);
    // The very array, not a copy: nothing re-encoded.
    expect(stored.bytes).toBe(read.bytes);
  });
});

describe("upload (#3007)", () => {
  it("downscales a 4000 by 3000, 5 MB picture to a 1568 px longest side", async () => {
    const id = await pub();
    const original = big();
    expect(original.length).toBeGreaterThan(4 * MB);
    const pic = await upload(id, original);
    // The upload went through, and the Picture describes what is stored.
    expect(pic.type).toBe("image/png");
    expect(Math.max(pic.w, pic.h)).toBe(PICTURE_STORE_MAX_SIDE);
    expect(pic.w).toBe(1568);
    expect([1175, 1176, 1177]).toContain(pic.h);
    expect(pic.bytes).toBeLessThan(original.length);
    expect(pic.bytes).toBeLessThanOrEqual(PICTURE_STORE_MAX_BYTES);
    // The row agrees, so list_comments gives the stored size.
    expect(await row(pic.id)).toMatchObject({
      w: 1568,
      h: pic.h,
      bytes: pic.bytes,
      type: "image/png",
    });
    // R2 holds a real PNG of those dimensions, not the 4000 by 3000 original.
    const kept = await r2(pic.id);
    expect(kept).not.toBeNull();
    const bytes = kept as Uint8Array;
    expect(bytes.length).toBe(pic.bytes);
    expect(imageSize(bytes)).toEqual({ width: 1568, height: pic.h });
    expect(readPicture(bytes)).toMatchObject({
      type: "image/png",
      w: 1568,
      h: pic.h,
    });
    // A viewer's browser gets the stored copy, byte for byte.
    await thread(id, [{ pictureId: pic.id }]);
    const served = await api(app, R.commentPicture(id, pic.id), owner.cookie);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-length")).toBe(String(pic.bytes));
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  }, 60_000);

  it("stores an 800 by 600, 200 KB picture untouched, byte for byte", async () => {
    const id = await pub();
    const original = small();
    expect(original.length).toBeGreaterThan(150 * 1024);
    expect(original.length).toBeLessThan(300 * 1024);
    const pic = await upload(id, original);
    expect(pic).toMatchObject({ type: "image/png", w: 800, h: 600 });
    expect(pic.bytes).toBe(original.length);
    const kept = await r2(pic.id);
    expect(kept).toEqual(original);
    await thread(id, [{ pictureId: pic.id }]);
    const served = await api(app, R.commentPicture(id, pic.id), owner.cookie);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-length")).toBe(String(original.length));
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(original);
    // No re-encode through MCP either: the same bytes, base64, image/png.
    const client = await connect(
      (await createPat(env, owner.userId, "untouched")).token,
    );
    try {
      const result = await tool(client, "get_comment_picture", {
        id,
        pictureId: pic.id,
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(result.content).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          data: b64(original),
        },
      ]);
    } finally {
      await close(client);
    }
  }, 60_000);

  it("stores a picture exactly at the limits untouched", async () => {
    const id = await pub();
    const original = greyPng(1568, 1568, { bits: 2 });
    const size = imageSize(original);
    expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBe(1568);
    expect(original.length).toBeLessThan(PICTURE_STORE_MAX_BYTES);
    const pic = await upload(id, original);
    expect(pic).toMatchObject({ w: 1568, h: 1568, bytes: original.length });
    expect(await r2(pic.id)).toEqual(original);
  }, 60_000);

  it("keeps the original when the resize fails, and the upload still succeeds", async () => {
    const id = await pub();
    const original = huge();
    // Over the limits on its side alone, so the resize is attempted.
    const size = imageSize(original);
    expect(
      beyondStoreLimits({
        w: size?.width ?? 0,
        h: size?.height ?? 0,
        bytes: original.length,
      }),
    ).toBe(true);
    const failing = {
      input() {
        throw new Error("images unavailable");
      },
    };
    const rejecting = {
      input: () => ({
        transform: () => ({
          output: async () => {
            throw new Error("images unavailable");
          },
        }),
      }),
    };
    for (const IMAGES of [failing, rejecting]) {
      const pic = await upload(id, original, "image/png", {
        ...env,
        IMAGES,
      } as never);
      // The upload succeeded, with the bytes as they came: 4000 by 3000.
      expect(pic).toMatchObject({ w: 4000, h: 3000, bytes: original.length });
      expect(await r2(pic.id)).toEqual(original);
    }
  }, 60_000);

  it("keeps the original when Images answers something unusable", async () => {
    const id = await pub();
    const original = huge();
    const nonsense = {
      input: () => ({
        transform: () => ({
          output: async () => ({
            response: () =>
              new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "text/html" },
              }),
          }),
        }),
      }),
    };
    const pic = await upload(id, original, "image/png", {
      ...env,
      IMAGES: nonsense,
    } as never);
    expect(pic).toMatchObject({ w: 4000, h: 3000, bytes: original.length });
    expect(await r2(pic.id)).toEqual(original);
  }, 60_000);
});

describe("the read path after the resize (#3007)", () => {
  it("serves the stored copy for a downscaled picture, with no second resize", async () => {
    const id = await pub();
    const pic = await upload(id, big());
    await thread(id, [{ pictureId: pic.id }]);
    const hit = await getPicture(env, id, pic.id, owner.userId, "agent");
    expect({ w: hit.w, h: hit.h, bytes: hit.bytes, type: hit.type }).toEqual({
      w: pic.w,
      h: pic.h,
      bytes: pic.bytes,
      type: pic.type,
    });
    const preview = await previewForAgent(env, hit);
    expect(preview.mimeType).toBe("image/png");
    expect(preview.data.length).toBe(pic.bytes);
    expect(imageSize(preview.data)).toEqual({ width: 1568, height: pic.h });
  }, 60_000);

  it("still serves an untouched picture as it was uploaded", async () => {
    const id = await pub();
    const original = small();
    const pic = await upload(id, original);
    await thread(id, [{ pictureId: pic.id }]);
    const hit = await getPicture(env, id, pic.id, owner.userId, "agent");
    const preview = await previewForAgent(env, hit);
    expect(preview.mimeType).toBe("image/png");
    expect(preview.data).toEqual(original);
  }, 60_000);

  it("serves a picture whose resize failed: images at read make the preview", async () => {
    const id = await pub();
    const original = huge();
    const pic = await upload(id, original, "image/png", {
      ...env,
      IMAGES: {
        input() {
          throw new Error("images unavailable");
        },
      },
    } as never);
    await thread(id, [{ pictureId: pic.id }]);
    const hit = await getPicture(env, id, pic.id, owner.userId, "agent");
    const preview = await previewForAgent(env, hit);
    // The old read path's own downscale, unchanged: a valid image within the budget.
    expect(preview.mimeType).toBe("image/webp");
    expect(preview.data.length).toBeLessThanOrEqual(PICTURE_STORE_MAX_BYTES);
    const size = imageSize(preview.data);
    expect(Math.max(size?.width ?? 0, size?.height ?? 0)).toBe(
      PICTURE_STORE_MAX_SIDE,
    );
    // And the original is still there for the browser.
    const served = await api(app, R.commentPicture(id, pic.id), owner.cookie);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(original);
  }, 60_000);

  it("keeps the pre-#3007 refusal when there is no Images and the file is over the budget", async () => {
    // A stored original that a failed resize left in place: over 3 MB, so
    // without Images the agent read path refuses it, exactly as before #3007.
    const bytes = big();
    const hit = {
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      type: "image/png" as const,
      bytes: bytes.length,
      w: 4000,
      h: 3000,
    };
    const { IMAGES: _images, ...withoutImages } = env;
    await expect(
      previewForAgent(withoutImages as never, hit),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("the upload contract is unchanged (#3007)", () => {
  it("still accepts up to 10 MB, and reserves the downscaled size after", async () => {
    const id = await pub();
    const original = big();
    const r = await reserve(id, { type: "image/png", bytes: original.length });
    expect(r.status).toBe(201);
    const { url } = (await r.json()) as CommentPictureReserved;
    const p = await put(url, original);
    const pic = (await p.json()) as CommentPicture;
    expect(pic.bytes).toBeLessThan(PICTURE_STORE_MAX_BYTES);
  }, 60_000);

  it("refuses a HEIC picture whatever its size", async () => {
    const id = await pub();
    const bytes = Uint8Array.from([
      0,
      0,
      0,
      24,
      ..."ftypheic".split("").map((c) => c.charCodeAt(0)),
    ]);
    const r = await reserve(id, { type: "image/heic", bytes: bytes.length });
    expect(r.status).toBe(400);
    expect(await errOf(r)).toMatchObject({ code: "unsupported_format" });
  });
});

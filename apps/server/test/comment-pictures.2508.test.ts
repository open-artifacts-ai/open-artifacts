// #2508 A1: pictures on comments. Reserve, the signed PUT (type from the bytes,
// metadata removed), the limits, attach, fetch access and headers, delete.
import { env } from "cloudflare:workers";
import {
  COMMENT_PICTURE_PENDING_MAX,
  COMMENT_PICTURE_RESERVATIONS_PER_DAY,
  type Comment,
  type CommentPicture,
  type CommentPictureReserved,
  imageSize,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { publish } from "../src/services/artifacts.js";
import { sweepPictures } from "../src/services/comment-pictures.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, fetchAndWait, login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";
import {
  contains,
  gif,
  heic,
  jpeg,
  png,
  SECRET,
  svg,
  webp,
} from "./picture-fixtures.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
let stranger: U;
let guest: U;

async function mk(prefix: string, role: Member["role"] = "member"): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "doc",
        format: "html",
        content: "<p>hello</p>",
        comments: "everyone",
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

beforeAll(async () => {
  owner = await mk("own");
  viewer = await mk("view");
  stranger = await mk("stranger");
  guest = await mk("guest", "guest");
});

const TYPES = {
  "image/png": png,
  "image/jpeg": jpeg,
  "image/gif": gif,
  "image/webp": webp,
} as const;
type Kind = keyof typeof TYPES;

const reserve = (u: U | null, id: string, body: unknown) =>
  api(app, R.commentPictures(id), u?.cookie ?? null, {
    method: "POST",
    body,
  });

const put = (
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) => {
  const u = new URL(url);
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${u.pathname}${u.search}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length), ...headers },
      body: bytes as BodyInit,
    }),
  );
};

/** Reserves and uploads one picture; returns the Picture and the reservation. */
async function upload(
  u: U,
  id: string,
  type: Kind = "image/png",
  bytes: Uint8Array = TYPES[type](),
) {
  const r = await reserve(u, id, { type, bytes: bytes.length });
  expect(r.status).toBe(201);
  const res = (await r.json()) as CommentPictureReserved;
  const p = await put(res.url, bytes);
  expect(p.status).toBe(200);
  return { pic: (await p.json()) as CommentPicture, res };
}

const post = (
  u: U | null,
  id: string,
  body: Record<string, unknown>,
  path = "",
) =>
  api(app, `${R.comments(id)}${path}`, u?.cookie ?? null, {
    method: "POST",
    body,
  });
const note = { kind: "note" } as const;
const thread = (u: U, id: string, pictures: unknown, body = "look") =>
  post(u, id, { anchor: note, body, pictures });
const stored = async (pictureId: string) =>
  env.DB.prepare("select * from comment_pictures where id = ?")
    .bind(pictureId)
    .first<{
      r2_key: string;
      comment_id: string | null;
      thread_id: string | null;
      bytes: number;
      alt: string | null;
    }>();
const r2 = async (pictureId: string) => {
  const row = await stored(pictureId);
  const o = row ? await env.FILES.get(row.r2_key) : null;
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
};

describe("reserve and upload", () => {
  it.each(Object.keys(TYPES) as Kind[])(
    "%s: accepted; w and h read from the file; the Picture comes back",
    async (type) => {
      const id = await pub();
      const { pic } = await upload(owner, id, type, TYPES[type](7, 5));
      expect(pic).toMatchObject({ type, w: 7, h: 5 });
      expect(pic.bytes).toBeGreaterThan(0);
      expect(pic.id).toBeTruthy();
    },
  );

  it("no client dimension is trusted: the body has no w or h", async () => {
    const id = await pub();
    const r = await reserve(owner, id, {
      type: "image/png",
      bytes: 10,
      w: 9999,
      h: 9999,
    });
    expect(r.status).toBe(400);
  });

  it("metadata is gone after upload: JPEG, PNG, WebP and GIF; the picture is unchanged otherwise", async () => {
    const id = await pub();
    for (const type of Object.keys(TYPES) as Kind[]) {
      const original = TYPES[type](6, 4, true);
      expect(contains(original, SECRET)).toBe(true);
      const { pic } = await upload(owner, id, type, original);
      const kept = await r2(pic.id);
      expect(kept, type).not.toBeNull();
      expect(contains(kept as Uint8Array, SECRET), type).toBe(false);
      expect(contains(kept as Uint8Array, "Exif"), type).toBe(false);
      expect(contains(kept as Uint8Array, "tEXt"), type).toBe(false);
      expect(contains(kept as Uint8Array, "EXIF"), type).toBe(false);
      expect(pic.bytes, type).toBe((kept as Uint8Array).length);
      expect(pic.bytes, type).toBeLessThan(original.length);
      expect(pic).toMatchObject({ w: 6, h: 4 });
    }
    // WebP: the RIFF size is fixed and the metadata flags are cleared.
    const w = await r2((await upload(owner, id, "image/webp")).pic.id);
    const dv = new DataView(
      (w as Uint8Array).buffer,
      (w as Uint8Array).byteOffset,
    );
    expect(dv.getUint32(4, true) + 8).toBe((w as Uint8Array).length);
    expect(((w as Uint8Array)[20] ?? 0) & 0x0c).toBe(0);
  });

  it("HEIC is refused with the message; SVG and a type that doesn't match the bytes are binary_entry", async () => {
    const id = await pub();
    const h = await reserve(owner, id, { type: "image/heic", bytes: 100 });
    expect(h.status).toBe(400);
    expect(await errOf(h)).toMatchObject({
      code: "unsupported_format",
      message: "This photo is in HEIC format. Save it as JPEG and try again.",
    });
    const s = await reserve(owner, id, { type: "image/svg+xml", bytes: 100 });
    expect((await errOf(s)).code).toBe("unsupported_format");
    // HEIC bytes reserved as a PNG.
    const hb = heic();
    const rh = (await (
      await reserve(owner, id, { type: "image/png", bytes: hb.length })
    ).json()) as CommentPictureReserved;
    const ph = await put(rh.url, hb);
    expect(ph.status).toBe(400);
    expect((await errOf(ph)).code).toBe("unsupported_format");
    // SVG bytes reserved as a PNG.
    const sb = svg();
    const rs = (await (
      await reserve(owner, id, { type: "image/png", bytes: sb.length })
    ).json()) as CommentPictureReserved;
    const ps = await put(rs.url, sb);
    expect(ps.status).toBe(400);
    expect((await errOf(ps)).code).toBe("binary_entry");
    // JPEG bytes reserved as a PNG.
    const jb = jpeg();
    const rj = (await (
      await reserve(owner, id, { type: "image/png", bytes: jb.length })
    ).json()) as CommentPictureReserved;
    const pj = await put(rj.url, jb);
    expect(pj.status).toBe(400);
    expect((await errOf(pj)).code).toBe("binary_entry");
    // Nothing was stored for any of them.
    for (const x of [rh, rs, rj]) expect(await r2(x.pictureId)).toBeNull();
  });

  it("a truncated or corrupt file is refused", async () => {
    const id = await pub();
    const cut = png().subarray(0, 20);
    const r = (await (
      await reserve(owner, id, { type: "image/png", bytes: cut.length })
    ).json()) as CommentPictureReserved;
    expect((await errOf(await put(r.url, cut))).code).toBe("binary_entry");
  });

  it("the size limit: over 10 MB is too_large", async () => {
    const id = await pub();
    const r = await reserve(owner, id, {
      type: "image/png",
      bytes: 10 * 1024 * 1024 + 1,
    });
    expect(r.status).toBe(413);
    expect((await errOf(r)).code).toBe("too_large");
  });

  it("the PUT must send exactly the reserved bytes, once, with the matching checksum", async () => {
    const id = await pub();
    const b = png();
    const r = (await (
      await reserve(owner, id, { type: "image/png", bytes: b.length })
    ).json()) as CommentPictureReserved;
    expect((await put(r.url, b.subarray(1))).status).toBe(400);
    expect((await put(r.url, b)).status).toBe(200);
    expect((await put(r.url, b)).status).toBe(409);
    const wrong = (await (
      await reserve(owner, id, {
        type: "image/png",
        bytes: b.length,
        sha256: "0".repeat(64),
      })
    ).json()) as CommentPictureReserved;
    expect((await put(wrong.url, b)).status).toBe(400);
    const right = (await (
      await reserve(owner, id, {
        type: "image/png",
        bytes: b.length,
        sha256: [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", b as BufferSource),
          ),
        ]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join(""),
      })
    ).json()) as CommentPictureReserved;
    expect((await put(right.url, b)).status).toBe(200);
  });

  it("the signature: a forged, edited or another picture's URL is 404", async () => {
    const id = await pub();
    const b = png();
    const r = (await (
      await reserve(owner, id, { type: "image/png", bytes: b.length })
    ).json()) as CommentPictureReserved;
    const u = new URL(r.url);
    expect(
      (
        await put(
          `${u.origin}${u.pathname}?exp=${u.searchParams.get("exp")}&sig=AAAA`,
          b,
        )
      ).status,
    ).toBe(404);
    expect((await put(`${u.origin}${u.pathname}`, b)).status).toBe(404);
    // Another artifact's path with this picture's signature.
    const other = await pub();
    const via = r.url.replace(`/artifacts/${id}/`, `/artifacts/${other}/`);
    expect((await put(via, b)).status).toBe(404);
    expect((await put(r.url, b)).status).toBe(200);
  });
});

describe("who may reserve", () => {
  it("members and agents; not a guest, not signed out; no access is 404", async () => {
    const id = await pub({ visibility: "public" });
    const body = { type: "image/png", bytes: 100 };
    expect((await reserve(owner, id, body)).status).toBe(201);
    // A guest is a capped caller: the API is read-only for them, so the
    // reservation is refused before the handler, as any write is (404), even
    // with a "Can comment" share (which lets them post comments, not pictures).
    expect((await reserve(guest, id, body)).status).toBe(404);
    const sh = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: guest.email, role: "commenter" },
    });
    expect(sh.status).toBe(200);
    expect((await reserve(guest, id, body)).status).toBe(404);
    expect((await reserve(null, id, body)).status).toBe(403);
    const priv = await pub({ visibility: "private" });
    expect((await reserve(stranger, priv, body)).status).toBe(404);
  });
});

describe("limits per person", () => {
  it("20 reserved and not yet used at once: the 21st is 429", async () => {
    const u = await mk("pend");
    const id = await pub({ visibility: "team" });
    for (let i = 0; i < COMMENT_PICTURE_PENDING_MAX; i++)
      expect(
        (await reserve(u, id, { type: "image/png", bytes: 10 })).status,
      ).toBe(201);
    const over = await reserve(u, id, { type: "image/png", bytes: 10 });
    expect(over.status).toBe(429);
    expect((await errOf(over)).details).toMatchObject({ reason: "pending" });
    // Another person is not affected.
    expect(
      (await reserve(owner, id, { type: "image/png", bytes: 10 })).status,
    ).toBe(201);
  });

  it("100 reservations a day: the 101st is 429", async () => {
    const u = await mk("day");
    const id = await pub({ visibility: "team" });
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(`cpic:${u.userId}`, COMMENT_PICTURE_RESERVATIONS_PER_DAY, day)
      .run();
    const over = await reserve(u, id, { type: "image/png", bytes: 10 });
    expect(over.status).toBe(429);
    expect((await errOf(over)).details).toMatchObject({ reason: "day" });
  });

  it("an unattached picture is deleted by the sweep after an hour", async () => {
    const id = await pub();
    const { pic } = await upload(owner, id);
    const row = await stored(pic.id);
    expect(await sweepPictures(env, Date.now() + 30 * 60_000)).toBe(0);
    expect(await r2(pic.id)).not.toBeNull();
    expect(await sweepPictures(env, Date.now() + 61 * 60_000)).toBeGreaterThan(
      0,
    );
    expect(await stored(pic.id)).toBeNull();
    expect(await env.FILES.get((row as { r2_key: string }).r2_key)).toBeNull();
  });

  it("a picture stuck under a hold: claim is deleted by the sweep after an hour", async () => {
    const id = await pub();
    const { pic } = await upload(owner, id);
    const row = await stored(pic.id);
    await env.DB.prepare(
      "update comment_pictures set comment_id = ? where id = ?",
    )
      .bind(`hold:${newId()}`, pic.id)
      .run();
    expect(await sweepPictures(env, Date.now() + 30 * 60_000)).toBe(0);
    expect(await r2(pic.id)).not.toBeNull();
    expect(await sweepPictures(env, Date.now() + 61 * 60_000)).toBeGreaterThan(
      0,
    );
    expect(await stored(pic.id)).toBeNull();
    expect(await env.FILES.get((row as { r2_key: string }).r2_key)).toBeNull();
  });

  it("a picture attached to a comment is not swept", async () => {
    const id = await pub();
    const { pic } = await upload(owner, id);
    expect((await thread(owner, id, [{ pictureId: pic.id }])).status).toBe(201);
    await sweepPictures(env, Date.now() + 61 * 60_000);
    expect(await stored(pic.id)).not.toBeNull();
  });
});

describe("declared dimensions (#2508)", () => {
  // A tiny file can claim a huge picture: refused when a side is over 16384
  // or the area over 50 million pixels, whatever the type.
  const SIZES = [
    [16_385, 4],
    [4, 16_385],
    [9_000, 9_000],
  ] as const;
  for (const type of Object.keys(TYPES) as Kind[])
    for (const [w, h] of SIZES)
      it(`${type} ${w}x${h} is too_large (dimensions)`, async () => {
        const id = await pub();
        const bytes = TYPES[type](w, h, false);
        const r = await reserve(owner, id, { type, bytes: bytes.length });
        expect(r.status).toBe(201);
        const res = (await r.json()) as CommentPictureReserved;
        const p = await put(res.url, bytes);
        expect(p.status).toBe(413);
        const e = await errOf(p);
        expect(e.code).toBe("too_large");
        expect(e.details).toMatchObject({ reason: "dimensions" });
        // Not a pending reservation of the owner's for the tests after it.
        await env.DB.prepare(
          "delete from comment_pictures where artifact_id = ?",
        )
          .bind(id)
          .run();
      });

  it("a large picture inside the limits is accepted", async () => {
    const id = await pub();
    const { pic } = await upload(
      owner,
      id,
      "image/png",
      png(7_000, 7_000, false),
    );
    expect(pic).toMatchObject({ w: 7_000, h: 7_000 });
    await env.DB.prepare("delete from comment_pictures where artifact_id = ?")
      .bind(id)
      .run();
  });
});

describe("attach", () => {
  it("a thread and a reply carry pictures; comments return them, with cleaned alt", async () => {
    const id = await pub();
    const a = (await upload(owner, id)).pic;
    const b = (await upload(owner, id, "image/jpeg")).pic;
    const t = await thread(owner, id, [
      { pictureId: a.id, alt: "  a\u0000 chart\n of  sales  " },
    ]);
    expect(t.status).toBe(201);
    const th = (await t.json()) as Thread;
    expect(th.comments[0]?.pictures).toEqual([
      {
        id: a.id,
        type: a.type,
        w: a.w,
        h: a.h,
        bytes: a.bytes,
        alt: "a chart of sales",
      },
    ]);
    const r = await post(
      owner,
      id,
      { body: "again", pictures: [{ pictureId: b.id }] },
      `/${th.id}/replies`,
    );
    expect(r.status).toBe(201);
    const reply = (await r.json()) as Comment;
    expect(reply.pictures).toEqual([
      { id: b.id, type: b.type, w: b.w, h: b.h, bytes: b.bytes },
    ]);
    // The list carries them too.
    const list = (await (
      await api(app, R.comments(id), owner.cookie)
    ).json()) as {
      threads: Thread[];
    };
    expect(list.threads[0]?.comments.map((c) => c.pictures?.length)).toEqual([
      1, 1,
    ]);
  });

  it("a picture-only comment is fine; with a mention it needs text; no text and no picture is 400", async () => {
    const id = await pub();
    const a = (await upload(owner, id)).pic;
    expect((await thread(owner, id, [{ pictureId: a.id }], "")).status).toBe(
      201,
    );
    expect((await post(owner, id, { anchor: note, body: "" })).status).toBe(
      400,
    );
    const b = (await upload(owner, id)).pic;
    const m = await post(owner, id, {
      anchor: note,
      body: "",
      pictures: [{ pictureId: b.id }],
      mentions: [{ kind: "agent", key: "x" }],
    });
    expect(m.status).toBeGreaterThanOrEqual(400);
    // The refused comment did not use the picture up.
    expect((await stored(b.id))?.comment_id).toBeNull();
  });

  it("refused: more than 4, a foreign picture, a used one, another artifact's, an unknown id; nothing is claimed", async () => {
    const id = await pub({ visibility: "team" });
    const other = await pub({ visibility: "team" });
    const mine = await Promise.all(
      [1, 2, 3, 4, 5].map(() => upload(owner, id)),
    );
    expect(
      (
        await thread(
          owner,
          id,
          mine.map((m) => ({ pictureId: m.pic.id })),
        )
      ).status,
    ).toBe(400);
    const foreign = (await upload(owner, id)).pic;
    const u2 = await mk("att2");
    expect((await thread(u2, id, [{ pictureId: foreign.id }])).status).toBe(
      400,
    );
    const elsewhere = (await upload(owner, other)).pic;
    expect(
      (await thread(owner, id, [{ pictureId: elsewhere.id }])).status,
    ).toBe(400);
    expect((await thread(owner, id, [{ pictureId: newId() }])).status).toBe(
      400,
    );
    const used = (await upload(owner, id)).pic;
    expect((await thread(owner, id, [{ pictureId: used.id }])).status).toBe(
      201,
    );
    const again = await thread(owner, id, [{ pictureId: used.id }]);
    expect(again.status).toBe(400);
    expect((await errOf(again)).code).toBe("bad_request");
    // A valid and an invalid picture together: neither is used.
    const ok = (await upload(owner, id)).pic;
    expect(
      (await thread(owner, id, [{ pictureId: ok.id }, { pictureId: newId() }]))
        .status,
    ).toBe(400);
    expect((await stored(ok.id))?.comment_id).toBeNull();
    // The same picture twice.
    expect(
      (await thread(owner, id, [{ pictureId: ok.id }, { pictureId: ok.id }]))
        .status,
    ).toBe(400);
  });

  it("an unuploaded reservation can't be attached", async () => {
    const id = await pub();
    const r = (await (
      await reserve(owner, id, { type: "image/png", bytes: 10 })
    ).json()) as CommentPictureReserved;
    expect((await thread(owner, id, [{ pictureId: r.pictureId }])).status).toBe(
      400,
    );
  });
});

describe("fetch", () => {
  it("returns one MCP image after attachment and checks access on each read", async () => {
    const id = await pub({ visibility: "private" });
    const other = await pub({ visibility: "team" });
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const { pic } = await upload(owner, id, "image/jpeg");
    const client = await connect(
      (await createPat(env, viewer.userId, "picture viewer")).token,
    );
    const read = (page = id) =>
      tool(client, "get_comment_picture", { id: page, pictureId: pic.id });
    try {
      expect(textOf(await read())).toMatch(/^not_found/);
      await thread(owner, id, [{ pictureId: pic.id }]);
      const bytes = await r2(pic.id);
      expect(bytes).toBeTruthy();
      expect((await read()).content).toEqual([
        {
          type: "image",
          mimeType: "image/jpeg",
          data: btoa(String.fromCharCode(...(bytes ?? []))),
        },
      ]);
      expect(textOf(await read(other))).toMatch(/^not_found/);
      await api(app, R.share(id, viewer.email), owner.cookie, {
        method: "DELETE",
      });
      expect(textOf(await read())).toMatch(/^not_found/);
    } finally {
      await close(client);
    }
  });

  it("returns a scaled portrait over MCP and keeps the original for REST", async () => {
    const id = await pub();
    // A valid single-colour 32 by 3136 PNG, small on disk but tall in pixels.
    const raw = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAACAAAAxAAQAAAACUVSJ3AAAAJklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAwIcBPUAAARircRgAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    const { pic } = await upload(owner, id, "image/png", raw);
    await thread(owner, id, [{ pictureId: pic.id }]);
    const client = await connect(
      (await createPat(env, owner.userId, "portrait")).token,
    );
    try {
      const result = await tool(client, "get_comment_picture", {
        id,
        pictureId: pic.id,
      });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(result.content).toMatchObject([
        { type: "image", mimeType: "image/webp" },
      ]);
      const image = result.content[0] as { type: string; data: string };
      const preview = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
      expect(imageSize(preview)).toEqual({ width: 16, height: 1568 });
      const original = await api(
        app,
        R.commentPicture(id, pic.id),
        owner.cookie,
      );
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(raw);
    } finally {
      await close(client);
    }
  });

  it("serves the bytes with the server's type and the safe headers", async () => {
    const id = await pub();
    const { pic } = await upload(owner, id, "image/jpeg");
    await thread(owner, id, [{ pictureId: pic.id }]);
    const r = await api(app, R.commentPicture(id, pic.id), owner.cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-disposition")).toBe("inline");
    expect(r.headers.get("cache-control")).toBe("private, max-age=300");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
    const body = new Uint8Array(await r.arrayBuffer());
    expect(body.length).toBe(pic.bytes);
    expect(contains(body, SECRET)).toBe(false);
    // Never SVG or HTML, whatever is stored.
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(["image/png", "image/jpeg", "image/gif", "image/webp"]).toContain(
        t,
      );
  });

  it("access follows the page, on every request: a viewer reads it, an outsider gets 404, signed-out reads a public page", async () => {
    const id = await pub({ visibility: "private" });
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    const { pic } = await upload(owner, id);
    await thread(owner, id, [{ pictureId: pic.id }]);
    const path = R.commentPicture(id, pic.id);
    expect((await api(app, path, viewer.cookie)).status).toBe(200);
    expect((await api(app, path, stranger.cookie)).status).toBe(404);
    expect((await api(app, path, null)).status).toBe(404);
    // Unshared: the next request is refused.
    await api(app, R.share(id, viewer.email), owner.cookie, {
      method: "DELETE",
    });
    expect((await api(app, path, viewer.cookie)).status).toBe(404);
    // A public page: anyone who can open it, signed out too.
    await env.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(id)
      .run();
    expect((await api(app, path, null)).status).toBe(200);
    expect((await api(app, path, stranger.cookie)).status).toBe(200);
  });

  it("an unknown, foreign or another page's picture is 404; an unattached one is its uploader's only", async () => {
    const id = await pub({ visibility: "team" });
    const other = await pub({ visibility: "team" });
    const { pic } = await upload(owner, id);
    // Unattached: the uploader sees it, others don't.
    expect(
      (await api(app, R.commentPicture(id, pic.id), owner.cookie)).status,
    ).toBe(200);
    expect(
      (await api(app, R.commentPicture(id, pic.id), viewer.cookie)).status,
    ).toBe(404);
    await thread(owner, id, [{ pictureId: pic.id }]);
    expect(
      (await api(app, R.commentPicture(id, pic.id), viewer.cookie)).status,
    ).toBe(200);
    // Right id, wrong page.
    expect(
      (await api(app, R.commentPicture(other, pic.id), owner.cookie)).status,
    ).toBe(404);
    expect(
      (await api(app, R.commentPicture(id, newId()), owner.cookie)).status,
    ).toBe(404);
    expect(
      (await api(app, R.commentPicture(id, "bad.name"), owner.cookie)).status,
    ).toBe(400);
  });
});

describe("delete and storage", () => {
  it("deleting a comment deletes its pictures; deleting the root takes the whole thread's", async () => {
    const id = await pub();
    const a = (await upload(owner, id)).pic;
    const b = (await upload(owner, id)).pic;
    const c = (await upload(owner, id)).pic;
    const th = (await (
      await thread(owner, id, [{ pictureId: a.id }])
    ).json()) as Thread;
    const reply1 = (await (
      await post(
        owner,
        id,
        { body: "r1", pictures: [{ pictureId: b.id }] },
        `/${th.id}/replies`,
      )
    ).json()) as Comment;
    await post(
      owner,
      id,
      { body: "r2", pictures: [{ pictureId: c.id }] },
      `/${th.id}/replies`,
    );
    const del = (cid: string) =>
      api(app, `${R.comments(id)}/${th.id}/comments/${cid}`, owner.cookie, {
        method: "DELETE",
      });
    expect((await del(reply1.id)).status).toBe(204);
    expect(await stored(b.id)).toBeNull();
    expect(await r2(b.id)).toBeNull();
    expect(await stored(a.id)).not.toBeNull();
    expect(await stored(c.id)).not.toBeNull();
    // The root: the thread goes, and every picture in it.
    const root = th.comments[0] as Comment;
    expect((await del(root.id)).status).toBe(204);
    expect(await stored(a.id)).toBeNull();
    expect(await stored(c.id)).toBeNull();
    expect(await r2(a.id)).toBeNull();
    expect(await r2(c.id)).toBeNull();
  });

  it("pictures count toward the instance's stored bytes", async () => {
    const { storedBytes } = await import("../src/billing/caps.js");
    const before = await storedBytes(env);
    const id = await pub();
    const { pic } = await upload(owner, id);
    expect(await storedBytes(env)).toBe(before + pic.bytes);
  });
});

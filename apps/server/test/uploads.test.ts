import { env } from "cloudflare:workers";
import { newId, R, UploadCreatedSchema } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { contentKey } from "../src/auth/keys.js";
import { verifyContentToken } from "../src/content/signing.js";
import { putUpload, sweepUploads } from "../src/services/uploads.js";
import { hmacSign } from "../src/util/crypto.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const tag = newId().slice(0, 6).toLowerCase();
let alice: { cookie: string; userId: string };
let bob: { cookie: string; userId: string };

beforeAll(async () => {
  alice = await login(`up-alice-${tag}@x.com`);
  bob = await login(`up-bob-${tag}@x.com`);
});

async function create(cookie: string, body: Record<string, unknown>) {
  const r = await api(app, R.uploads, cookie, { method: "POST", body });
  expect(r.status).toBe(201);
  return UploadCreatedSchema.parse(await r.json());
}

const put = (
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => {
  const u = new URL(url);
  const len =
    typeof body === "string"
      ? new TextEncoder().encode(body).length
      : body.length;
  headers = { "content-length": String(len), ...headers };
  return app.fetch(
    new Request(`http://app.localhost${u.pathname}${u.search}`, {
      method: "PUT",
      body,
      headers,
    }),
    env,
    ctx,
  );
};

const upload = (id: string) =>
  env.DB.prepare("select * from uploads where id = ?")
    .bind(id)
    .first<{ r2_key: string; consumed: number; artifact_id: string }>();

describe("uploads", () => {
  let artifactId: string;

  it("create → PUT → publish reuses the key", async () => {
    const up = await create(alice.cookie, { path: "img/a.bin", size: 3 });
    artifactId = up.artifactId;
    expect(new URL(up.url).pathname).toBe(R.upload(up.uploadId));
    // Signed: no session, and a cookie without X-OA-Request is not CSRF-blocked.
    const p = await put(up.url, new Uint8Array([1, 2, 3]), {
      cookie: alice.cookie,
    });
    expect(p.status).toBe(204);
    const row = await upload(up.uploadId);
    expect(row?.r2_key).toMatch(new RegExp(`^files/${artifactId}/`));

    const noTitle = await api(app, R.artifacts, alice.cookie, {
      method: "POST",
      body: {
        id: artifactId,
        files: { "img/a.bin": { uploadId: up.uploadId } },
      },
    });
    expect(noTitle.status).toBe(400);

    const r = await api(app, R.artifacts, alice.cookie, {
      method: "POST",
      body: {
        id: artifactId,
        title: "With upload",
        entry: "index.html",
        files: {
          "index.html": "<img src=img/a.bin>",
          "img/a.bin": { uploadId: up.uploadId },
        },
      },
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: artifactId, version: 1 });
    const v = await env.DB.prepare(
      "select manifest from versions where artifact_id = ? and version = 1",
    )
      .bind(artifactId)
      .first<{ manifest: string }>();
    const m = JSON.parse(v?.manifest ?? "[]") as {
      path: string;
      key: string;
      size: number;
    }[];
    expect(m.find((e) => e.path === "img/a.bin")).toMatchObject({
      key: row?.r2_key,
      size: 3,
    });
    expect((await upload(up.uploadId))?.consumed).toBe(1);
    const reserved = await env.DB.prepare(
      "select id from reserved_artifacts where id = ?",
    )
      .bind(artifactId)
      .first();
    expect(reserved).toBeNull();
  });

  it("reusing a consumed upload → 400", async () => {
    const row = await env.DB.prepare(
      "select id, path from uploads where artifact_id = ? and consumed = 1",
    )
      .bind(artifactId)
      .first<{ id: string; path: string }>();
    const r = await api(app, R.versions(artifactId), alice.cookie, {
      method: "POST",
      body: { files: { [row?.path ?? ""]: { uploadId: row?.id ?? "" } } },
    });
    expect(r.status).toBe(400);
  });

  it("another user's upload → 400", async () => {
    const up = await create(bob.cookie, { path: "b.txt", size: 2 });
    expect((await put(up.url, "hi")).status).toBe(204);
    const r = await api(app, R.versions(artifactId), alice.cookie, {
      method: "POST",
      body: { files: { "b.txt": { uploadId: up.uploadId } } },
    });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ path: "b.txt" });
  });

  it("an upload never PUT → 400", async () => {
    const up = await create(alice.cookie, {
      artifactId,
      path: "c.txt",
      size: 2,
    });
    const r = await api(app, R.versions(artifactId), alice.cookie, {
      method: "POST",
      body: { files: { "c.txt": { uploadId: up.uploadId } } },
    });
    expect(r.status).toBe(400);
  });

  it("bad sig / expired → 404; length mismatch → 400", async () => {
    const up = await create(alice.cookie, {
      artifactId,
      path: "d.txt",
      size: 5,
    });
    const u = new URL(up.url);
    // Flip the first character: it can never equal the real signature.
    const real = u.searchParams.get("sig") ?? "";
    u.searchParams.set("sig", `${real[0] === "A" ? "B" : "A"}${real.slice(1)}`);
    expect((await put(u.toString(), "hello")).status).toBe(404);
    const exp = String(Math.floor(Date.now() / 1000) - 10);
    const sig = await hmacSign(
      await contentKey(env, "oa:upload"),
      `${up.uploadId}:${exp}`,
    );
    const old = new URL(up.url);
    old.searchParams.set("exp", exp);
    old.searchParams.set("sig", sig);
    expect((await put(old.toString(), "hello")).status).toBe(404);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    const u2 = new URL(up.url);
    const noLen = await app.fetch(
      new Request(`http://app.localhost${u2.pathname}${u2.search}`, {
        method: "PUT",
        body: stream,
      }),
      env,
      ctx,
    );
    expect(noLen.status).toBe(400);
    const mismatch = await put(up.url, "hey");
    expect(mismatch.status).toBe(400);
    expect((await put(up.url, "hello")).status).toBe(204);
  });

  it("create: size over 25 MB → 413; hostile path → 400; no access → 404", async () => {
    const big = await api(app, R.uploads, alice.cookie, {
      method: "POST",
      body: { path: "a", size: 25 * 1024 * 1024 + 1 },
    });
    expect(big.status).toBe(413);
    const bad = await api(app, R.uploads, alice.cookie, {
      method: "POST",
      body: { path: "../a", size: 1 },
    });
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).details).toMatchObject({ path: "../a" });
    const other = await api(app, R.uploads, bob.cookie, {
      method: "POST",
      body: { artifactId, path: "a", size: 1 },
    });
    expect(other.status).toBe(404);
  });

  it("publishing to someone else's reserved id → 400 (not this user's reservation)", async () => {
    const up = await create(bob.cookie, { path: "x.txt", size: 1 });
    const r = await api(app, R.artifacts, alice.cookie, {
      method: "POST",
      body: {
        id: up.artifactId,
        title: "steal",
        format: "markdown",
        content: "x",
      },
    });
    expect(r.status).toBe(400);
  });
});

describe("write-once uploads", () => {
  const received = async (id: string) =>
    (
      await env.DB.prepare("select received_at from uploads where id = ?")
        .bind(id)
        .first<{ received_at: number | null }>()
    )?.received_at;

  it("a second PUT → 409 and does not overwrite", async () => {
    const up = await create(alice.cookie, { path: "w.txt", size: 3 });
    expect((await put(up.url, "abc")).status).toBe(204);
    expect(await received(up.uploadId)).toBeGreaterThan(0);
    const again = await put(up.url, "xyz");
    expect(again.status).toBe(409);
    const key = (await upload(up.uploadId))?.r2_key ?? "";
    expect(await (await env.FILES.get(key))?.text()).toBe("abc");
  });

  it("an in-flight PUT (claimed slot) → 409; publish rejects it", async () => {
    const up = await create(alice.cookie, { path: "f.txt", size: 3 });
    await env.DB.prepare("update uploads set received_at = -1 where id = ?")
      .bind(up.uploadId)
      .run();
    expect((await put(up.url, "abc")).status).toBe(409);
    const r = await api(app, R.artifacts, alice.cookie, {
      method: "POST",
      body: {
        id: up.artifactId,
        title: "t",
        files: { "f.txt": { uploadId: up.uploadId } },
      },
    });
    expect(r.status).toBe(400);
  });

  it("a failed or size-mismatched put clears the slot so a retry works", async () => {
    const up = await create(alice.cookie, { path: "g.txt", size: 3 });
    const u = new URL(up.url);
    const exp = u.searchParams.get("exp") ?? "";
    const sig = u.searchParams.get("sig") ?? "";
    const req = (body: string) =>
      new Request("http://x/", {
        method: "PUT",
        body,
        headers: { "content-length": String(body.length) },
      });
    const failing = {
      ...env,
      FILES: {
        ...env.FILES,
        put: async () => {
          throw new Error("r2 down");
        },
        delete: env.FILES.delete.bind(env.FILES),
      },
    } as unknown as typeof env;
    await expect(
      putUpload(failing, up.uploadId, exp, sig, req("abc")),
    ).rejects.toThrow("r2 down");
    expect(await received(up.uploadId)).toBeNull();
    const short = {
      ...env,
      FILES: {
        put: async (k: string) => {
          await env.FILES.put(k, "ab");
          return { size: 2 };
        },
        delete: env.FILES.delete.bind(env.FILES),
      },
    } as unknown as typeof env;
    await expect(
      putUpload(short, up.uploadId, exp, sig, req("abc")),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await received(up.uploadId)).toBeNull();
    const key = (await upload(up.uploadId))?.r2_key ?? "";
    expect(await env.FILES.head(key)).toBeNull();
    expect((await put(up.url, "abc")).status).toBe(204);
    expect(await received(up.uploadId)).toBeGreaterThan(0);
  });
});

describe("multiple uploads", () => {
  it("one publish consumes every listed upload", async () => {
    const a = await create(alice.cookie, { path: "m1.txt", size: 1 });
    const b = await create(alice.cookie, {
      artifactId: a.artifactId,
      path: "m2.txt",
      size: 1,
    });
    expect((await put(a.url, "a")).status).toBe(204);
    expect((await put(b.url, "b")).status).toBe(204);
    const r = await api(app, R.artifacts, alice.cookie, {
      method: "POST",
      body: {
        id: a.artifactId,
        title: "two",
        files: {
          "m1.txt": { uploadId: a.uploadId },
          "m2.txt": { uploadId: b.uploadId },
        },
      },
    });
    expect(r.status).toBe(201);
    expect((await upload(a.uploadId))?.consumed).toBe(1);
    expect((await upload(b.uploadId))?.consumed).toBe(1);
  });
});

describe("sweepUploads", () => {
  it("deletes stale unconsumed uploads and reserved ids; keeps fresh ones", async () => {
    const stale = await create(alice.cookie, { path: "s.txt", size: 1 });
    const fresh = await create(alice.cookie, { path: "f.txt", size: 1 });
    expect((await put(stale.url, "s")).status).toBe(204);
    expect((await put(fresh.url, "f")).status).toBe(204);
    const old = Date.now() - 25 * 3600 * 1000;
    await env.DB.batch([
      env.DB.prepare("update uploads set created_at = ? where id = ?").bind(
        old,
        stale.uploadId,
      ),
      env.DB.prepare(
        "update reserved_artifacts set created_at = ? where id = ?",
      ).bind(old, stale.artifactId),
    ]);
    const staleKey = (await upload(stale.uploadId))?.r2_key ?? "";
    const n = await sweepUploads(env, Date.now());
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await upload(stale.uploadId)).toBeNull();
    expect(await env.FILES.head(staleKey)).toBeNull();
    expect(
      await env.DB.prepare("select id from reserved_artifacts where id = ?")
        .bind(stale.artifactId)
        .first(),
    ).toBeNull();
    const kept = await upload(fresh.uploadId);
    expect(kept).not.toBeNull();
    expect(await env.FILES.head(kept?.r2_key ?? "")).not.toBeNull();
  });
});

describe("per-purpose keys from CONTENT_SIGNING_KEY", () => {
  const exp = () => String(Math.floor(Date.now() / 1000) + 300);

  it("an upload signature made with the content-url key (or the raw secret) is refused", async () => {
    const up = await create(alice.cookie, { path: "k.txt", size: 2 });
    const e = exp();
    for (const key of [
      await contentKey(env, "oa:content-url"),
      env.CONTENT_SIGNING_KEY,
    ]) {
      const u = new URL(up.url);
      u.searchParams.set("exp", e);
      u.searchParams.set("sig", await hmacSign(key, `${up.uploadId}:${e}`));
      expect((await put(u.toString(), "hi")).status).toBe(404);
    }
    // The same forgery with the upload key is accepted: only the key differs.
    const u = new URL(up.url);
    u.searchParams.set("exp", e);
    u.searchParams.set(
      "sig",
      await hmacSign(await contentKey(env, "oa:upload"), `${up.uploadId}:${e}`),
    );
    expect((await put(u.toString(), "hi")).status).toBe(204);
  });

  it("a content token made with the upload key (or the raw secret) is refused", async () => {
    const id = newId();
    const e = exp();
    const token = async (key: string) =>
      `${e}.${await hmacSign(key, `${id}:1:${e}`)}`;
    for (const key of [
      await contentKey(env, "oa:upload"),
      env.CONTENT_SIGNING_KEY,
    ])
      expect(
        await verifyContentToken(env, await token(key), id, 1, false),
      ).toBeNull();
    expect(
      await verifyContentToken(
        env,
        await token(await contentKey(env, "oa:content-url")),
        id,
        1,
        false,
      ),
    ).toEqual({ mode: "frame", viewer: null });
  });
});

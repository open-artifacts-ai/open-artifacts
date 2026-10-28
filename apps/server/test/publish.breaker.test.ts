import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MAX_INLINE_FILES } from "../src/services/manifest.js";
import { api, errOf, login } from "./helpers.js";

// Adversarial cases from the B6 review (fix round 1).
const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
let u: { cookie: string; userId: string };
beforeAll(async () => {
  u = await login(`brk-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

const call = (e: unknown, path: string, body: unknown, method = "POST") =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method,
      headers: {
        cookie: u.cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e as typeof env,
    ctx,
  );

async function putTo(url: string) {
  const x = new URL(url);
  return app.fetch(
    new Request(`http://app.localhost${x.pathname}${x.search}`, {
      method: "PUT",
      body: "abc",
      headers: { "content-length": "3" },
    }),
    env,
    ctx,
  );
}

async function uploaded(path: string, artifactId?: string) {
  const r = await api(app, R.uploads, u.cookie, {
    method: "POST",
    body: { path, size: 3, ...(artifactId ? { artifactId } : {}) },
  });
  const up = (await r.json()) as {
    uploadId: string;
    artifactId: string;
    url: string;
  };
  expect((await putTo(up.url)).status).toBe(204);
  return up;
}

const consumed = async (id: string) =>
  (
    await env.DB.prepare("select consumed from uploads where id = ?")
      .bind(id)
      .first<{ consumed: number }>()
  )?.consumed;

describe("B6 breaker", () => {
  it("1. 900 inline files stay under 1000 internal calls; 901 → 413", async () => {
    let n = 0;
    const count = <T extends object>(t: T): T =>
      new Proxy(t, {
        get(o, k) {
          const v = Reflect.get(o, k, o);
          return typeof v === "function"
            ? (...a: unknown[]) => {
                n++;
                return v.apply(o, a);
              }
            : v;
        },
      });
    const e = { ...env, FILES: count(env.FILES), DB: count(env.DB) };
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_INLINE_FILES; i++) files[`f${i}.txt`] = "x";
    const r = await call(e, R.artifacts, { title: "many", files });
    expect(r.status).toBe(201);
    expect(n).toBeLessThan(1000);
    files.extra = "x";
    const over = await call(env, R.artifacts, { title: "many", files });
    expect(over.status).toBe(413);
    expect((await errOf(over)).message).toBe(
      "publish more than 900 inline files via uploads",
    );
  }, 30_000);

  it("an upload that was never PUT is rejected without an R2 head", async () => {
    const up = await uploaded("z.txt");
    const r = await api(app, R.uploads, u.cookie, {
      method: "POST",
      body: { path: "y.txt", size: 3, artifactId: up.artifactId },
    });
    const { uploadId } = (await r.json()) as { uploadId: string };
    const res = await call(env, R.artifacts, {
      title: "t",
      id: up.artifactId,
      files: { "y.txt": { uploadId } },
    });
    expect(res.status).toBe(400);
  });

  it("2. an upload consumed by two concurrent publishes → one fails", async () => {
    const up = await uploaded("a.txt");
    const c = await call(env, R.artifacts, {
      title: "t",
      id: up.artifactId,
      files: { "a.txt": { uploadId: up.uploadId } },
    });
    expect(c.status).toBe(201);
    const { uploadId } = await uploaded("b.txt", up.artifactId);
    const v = { files: { "b.txt": { uploadId } } };
    const rs = await Promise.all(
      [1, 2].map(() => call(env, R.versions(up.artifactId), v)),
    );
    const st = rs.map((r) => r.status).sort();
    expect(st[0]).toBe(201);
    expect([400, 409]).toContain(st[1]);
    const n = await env.DB.prepare(
      "select count(*) as n from versions where artifact_id = ?",
    )
      .bind(up.artifactId)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it("2b. the batch refuses an upload consumed after the precheck → 409", async () => {
    const up = await uploaded("e.txt");
    await call(env, R.artifacts, {
      title: "t",
      id: up.artifactId,
      files: { "x.txt": "x" },
    });
    const DB = new Proxy(env.DB, {
      get(o, k) {
        if (k === "batch")
          return async (s: D1PreparedStatement[]) => {
            await o
              .prepare("update uploads set consumed = 1 where id = ?")
              .bind(up.uploadId)
              .run();
            return o.batch(s);
          };
        const v = Reflect.get(o, k, o);
        return typeof v === "function" ? v.bind(o) : v;
      },
    });
    const r = await call({ ...env, DB }, R.versions(up.artifactId), {
      files: { "e.txt": { uploadId: up.uploadId }, "i.txt": "inline" },
    });
    expect(r.status).toBe(409);
    const cv = await env.DB.prepare(
      "select current_version from artifacts where id = ?",
    )
      .bind(up.artifactId)
      .first<{ current_version: number }>();
    expect(cv?.current_version).toBe(1);
  });

  it("3. publish that loses a race with delete must not consume its upload", async () => {
    const up = await uploaded("c.txt");
    await call(env, R.artifacts, {
      title: "t",
      id: up.artifactId,
      files: { "c.txt": "x" },
    });
    const { uploadId } = await uploaded("d.txt", up.artifactId);
    const DB = new Proxy(env.DB, {
      get(o, k) {
        if (k === "batch")
          return async (s: D1PreparedStatement[]) => {
            await o
              .prepare("update artifacts set deleted_at = 1 where id = ?")
              .bind(up.artifactId)
              .run();
            return o.batch(s);
          };
        const v = Reflect.get(o, k, o);
        return typeof v === "function" ? v.bind(o) : v;
      },
    });
    const r = await call({ ...env, DB }, R.versions(up.artifactId), {
      files: { "d.txt": { uploadId } },
    });
    expect(r.status).toBe(404);
    expect(await consumed(uploadId)).toBe(0);
  });

  it("4. chunked body without Content-Length is not buffered past MAX_BODY", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1 << 20).fill(32);
    const body = new ReadableStream({
      pull(c) {
        pulled += chunk.length;
        if (pulled > 20 << 20) c.close();
        else c.enqueue(chunk);
      },
    });
    const r = await app.fetch(
      new Request(`http://app.localhost${R.artifacts}`, {
        method: "POST",
        body,
        duplex: "half",
        headers: {
          cookie: u.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
      } as RequestInit),
      env,
      ctx,
    );
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(4 << 20);
  });

  it("5. code content with language 'python' → main.py, language kept", async () => {
    const r = await call(env, R.artifacts, {
      title: "c",
      format: "code",
      language: "python",
      content: "print(1)",
    });
    const { id } = (await r.json()) as { id: string };
    const v = await env.DB.prepare(
      "select entry, language from versions where artifact_id = ?",
    )
      .bind(id)
      .first<{ entry: string; language: string }>();
    expect(v).toEqual({ entry: "main.py", language: "python" });
  });

  it("6. POST artifacts with an existing id → 400; versions on a reserved id → 404", async () => {
    const r = await call(env, R.artifacts, {
      title: "t",
      format: "markdown",
      content: "a",
    });
    const { id } = (await r.json()) as { id: string };
    const r2 = await call(env, R.artifacts, {
      id,
      title: "t",
      format: "markdown",
      content: "b",
    });
    expect(r2.status).toBe(400);
    expect((await errOf(r2)).message).toBe(
      "use POST /versions to publish a new version",
    );
    const up = await uploaded("r.txt");
    const r3 = await call(env, R.versions(up.artifactId), {
      title: "t",
      format: "markdown",
      content: "b",
    });
    expect(r3.status).toBe(404);
  });

  for (const k of ["__proto__", "constructor", "prototype"]) {
    it(`7. a file named ${k} → 400 with details.path`, async () => {
      const r = await call(
        env,
        R.artifacts,
        `{"title":"p","files":{"index.html":"x","${k}":{"base64":"QQ=="}}}`,
      );
      expect(r.status).toBe(400);
      expect((await errOf(r)).details).toMatchObject({ path: k });
    });
  }
});

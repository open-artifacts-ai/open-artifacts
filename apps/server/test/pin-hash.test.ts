// Pin hashes (#1490): VersionInfo.contentHash for inline, uploaded and
// pre-digest versions; pins stamped on any version; no R2 read before the
// rate limit; a client hash that is not sha256 hex is refused.
import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { checkAnchor } from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

const app = createApp();
let cookie: string;
let me: Member;

const hex = async (b: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const PDF1 = new TextEncoder().encode("%PDF-1.4\n% one\n");
const PDF2 = new TextEncoder().encode("%PDF-1.4\n% two\n");
const pin = (extra: object = {}) => ({
  kind: "pin",
  x: 0.5,
  y: 0.5,
  ...extra,
});
const art = (id: string) => ({ id, format: "pdf", currentVersion: 2 });

type V = { version: number; contentHash: string | null };
const versions = async (id: string) =>
  (await (await api(app, R.versions(id), cookie)).json()) as V[];

beforeAll(async () => {
  const l = await login(`ph-${newId().slice(0, 6).toLowerCase()}@x.com`);
  cookie = l.cookie;
  me = (await getUser(env, l.userId)) as Member;
});

const pub = async (bytes: Uint8Array, id?: string) =>
  publish(
    env,
    me,
    {
      ...(id ? { id } : {}),
      title: "t",
      format: "pdf",
      content: new TextDecoder().decode(bytes),
    } as never,
    null,
    undefined,
    id ? "version" : "create",
  );

describe("contentHash on versions", () => {
  it("lists the entry sha256 for inline versions, null before digests", async () => {
    const { id } = await pub(PDF1);
    await pub(PDF2, id);
    const list = await versions(id);
    expect(list.map((v) => v.contentHash)).toEqual([
      await hex(PDF2),
      await hex(PDF1),
    ]);
    await env.DB.prepare(
      "update versions set manifest = json_remove(manifest, '$[0].digest') where artifact_id = ? and version = 1",
    )
      .bind(id)
      .run();
    expect((await versions(id)).map((v) => v.contentHash)).toEqual([
      await hex(PDF2),
      null,
    ]);
  });

  it("an uploaded entry lists the sha256 the PUT stored", async () => {
    const bytes = new TextEncoder().encode(`%PDF-1.4\n% up ${newId()}\n`);
    const r = await api(app, R.uploads, cookie, {
      method: "POST",
      body: { path: "u.pdf", size: bytes.length },
    });
    const up = (await r.json()) as {
      uploadId: string;
      artifactId: string;
      url: string;
    };
    const u = new URL(up.url);
    const put = await app.fetch(
      new Request(`http://app.localhost${u.pathname}${u.search}`, {
        method: "PUT",
        body: bytes as Uint8Array<ArrayBuffer>,
        headers: { "content-length": String(bytes.length) },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(put.status).toBe(204);
    const p = await api(app, R.artifacts, cookie, {
      method: "POST",
      body: {
        id: up.artifactId,
        title: "u",
        files: { "u.pdf": { uploadId: up.uploadId } },
      },
    });
    expect(p.status).toBe(201);
    const [v] = await versions(up.artifactId);
    expect(v?.contentHash).toBe(await hex(bytes));
    // A pin stamps the same value.
    const a = await checkAnchor(env, art(up.artifactId), pin({ version: 1 }));
    expect(a.anchor).toMatchObject({ contentHash: await hex(bytes) });
  });
});

describe("pin stamping", () => {
  it("stamps the version the pin names, not the current one", async () => {
    const { id } = await pub(PDF1);
    await pub(PDF2, id);
    const old = await checkAnchor(env, art(id), pin({ version: 1 }));
    const cur = await checkAnchor(env, art(id), pin());
    expect(old.anchor).toMatchObject({
      version: 1,
      contentHash: await hex(PDF1),
    });
    expect(cur.anchor).toMatchObject({
      version: 2,
      contentHash: await hex(PDF2),
    });
  });

  it("a rate-limited caller causes no R2 read", async () => {
    const { id } = await pub(PDF1);
    await env.DB.prepare(
      "update versions set manifest = json_remove(manifest, '$[0].digest') where artifact_id = ?",
    )
      .bind(id)
      .run();
    const get = vi.fn();
    const spy = { DB: env.DB, FILES: { get } } as never;
    await expect(
      checkAnchor(spy, art(id), pin({ version: 1 }), async () => {
        throw new Error("rate_limited");
      }),
    ).rejects.toThrow("rate_limited");
    expect(get).not.toHaveBeenCalled();
  });

  it("a client contentHash that is not 64 hex is invalid_anchor", async () => {
    const { id } = await pub(PDF1);
    for (const h of ["bogus", "F".repeat(64), "a".repeat(63), ""])
      await expect(
        checkAnchor(env, art(id), pin({ version: 1, contentHash: h })),
      ).rejects.toMatchObject({ code: "invalid_anchor" });
    // Omitted, or a valid-looking hash, is accepted and overwritten.
    const ok = await checkAnchor(
      env,
      art(id),
      pin({ version: 1, contentHash: "a".repeat(64) }),
    );
    expect(ok.anchor).toMatchObject({ contentHash: await hex(PDF1) });
    expect(
      (await checkAnchor(env, art(id), pin({ version: 1 }))).anchor,
    ).toMatchObject({ contentHash: await hex(PDF1) });
  });
});

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

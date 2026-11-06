import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { api, errOf, login } from "./helpers.js";

// #1540: every publish-path error ends with the concrete next step, and its
// code and status stay as they were.

const app = createApp();
let owner: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(`errcopy-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

const post = (path: string, body: unknown) =>
  api(app, path, owner.cookie, { method: "POST", body });

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

/** A step word each message must contain, by code and reason. */
async function refused(
  r: Response,
  status: number,
  code: string,
  step: RegExp,
) {
  expect(r.status).toBe(status);
  const e = await errOf(r);
  expect(e.code).toBe(code);
  expect(e.message.length).toBeGreaterThan(0);
  expect(e.message).toMatch(step);
  // No hosts, emails or IPs in the copy.
  expect(e.message).not.toMatch(/https?:\/\/|@|\b\d{1,3}(\.\d{1,3}){3}\b/);
  return e;
}

describe("publish errors name the next step", () => {
  it("invalid_upload: an unknown upload id", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      entry: "a.html",
      files: { "a.html": { uploadId: "nope" } },
    });
    const e = await refused(r, 400, "bad_request", /create_upload/);
    expect(e.details).toMatchObject({ reason: "invalid_upload" });
    expect(e.message).toBe(
      "This upload was already used or has expired. Create a new one with create_upload.",
    );
  });

  it("upload_incomplete: an upload nobody PUT", async () => {
    const c = await post(R.uploads, {
      path: "a.html",
      size: 5,
      contentType: "text/html",
    });
    expect(c.status).toBe(201);
    const up = (await c.json()) as { uploadId: string; artifactId: string };
    const r = await post(R.artifacts, {
      id: up.artifactId,
      title: "t",
      entry: "a.html",
      files: { "a.html": { uploadId: up.uploadId } },
    });
    await refused(r, 400, "bad_request", /PUT the file/);
  });

  it("too_large: inline content over the limit", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      format: "code",
      content: "x".repeat(130 * 1024),
    });
    await refused(r, 413, "too_large", /create_upload/);
  });

  it("unsupported_format: bytes no viewer shows", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      entry: "a.bin",
      files: { "a.bin": { base64: b64([0, 1, 2, 3, 0, 255, 254]) } },
    });
    await refused(r, 400, "unsupported_format", /Publish/);
  });

  it("binary_entry: bytes that do not fit the format", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      format: "html",
      entry: "a.html",
      files: { "a.html": { base64: b64([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) } },
    });
    await refused(r, 400, "binary_entry", /Publish|name the file/);
  });

  it("version_conflict and edit_failed", async () => {
    const m = await post(R.artifacts, {
      title: "t",
      format: "html",
      content: "<p>a</p>",
    });
    const a = (await m.json()) as { id: string };
    await post(R.versions(a.id), { format: "html", content: "<p>b</p>" });
    await refused(
      await post(R.versions(a.id), {
        format: "html",
        content: "<p>c</p>",
        expectedVersion: 1,
      }),
      409,
      "version_conflict",
      /get_artifact/,
    );
    await refused(
      await post(R.versions(a.id), { edits: [{ old: "zzz", new: "y" }] }),
      400,
      "edit_failed",
      /get_artifact/,
    );
  });

  it("bad_request cases: entry and content/files mistakes", async () => {
    await refused(
      await post(R.artifacts, {
        title: "t",
        files: { "a.html": "<p>a</p>" },
        entry: "missing.html",
      }),
      400,
      "bad_request",
      /Set entry/,
    );
    await refused(
      await post(R.artifacts, {
        title: "t",
        content: "x",
        files: { "a.html": "<p>a</p>" },
      }),
      400,
      "bad_request",
      /either content or files/,
    );
  });
});

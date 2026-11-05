import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

// #1216 expectedVersion and #1540 edits on publish.

const app = createApp();
let owner: { cookie: string; userId: string };

beforeAll(async () => {
  owner = await login(`edits-${newId().slice(0, 6).toLowerCase()}@x.com`);
});

const post = (path: string, body: unknown) =>
  api(app, path, owner.cookie, { method: "POST", body });

const make = async (body: Record<string, unknown>) => {
  const r = await post(R.artifacts, { title: "t", ...body });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; version: number };
};

const publishV = (id: string, body: Record<string, unknown>) =>
  post(R.versions(id), body);

const text = async (id: string, v: number, path: string) =>
  (await api(app, R.versionFile(id, v, path), owner.cookie)).text();

const versionCount = async (id: string) =>
  ((await (await api(app, R.versions(id), owner.cookie)).json()) as unknown[])
    .length;

describe("expectedVersion", () => {
  it("a current expectedVersion publishes", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    const r = await publishV(a.id, {
      format: "html",
      content: "<p>b</p>",
      expectedVersion: 1,
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { version: number }).version).toBe(2);
  });

  it("a stale one is version_conflict naming the current version", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    await publishV(a.id, { format: "html", content: "<p>b</p>" });
    const r = await publishV(a.id, {
      format: "html",
      content: "<p>c</p>",
      expectedVersion: 1,
    });
    expect(r.status).toBe(409);
    const e = await errOf(r);
    expect(e.code).toBe("version_conflict");
    expect(e.message).toBe(
      "Version 2 is current. Read it with get_artifact and apply your change to it.",
    );
    expect(e.details).toMatchObject({ currentVersion: 2 });
    expect(await versionCount(a.id)).toBe(2);
    // Nothing of the refused publish stays in storage.
    expect(await text(a.id, 2, "index.html")).toBe("<p>b</p>");
  });

  it("an expectedVersion ahead of the artifact is version_conflict too", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    const r = await publishV(a.id, {
      format: "html",
      content: "<p>b</p>",
      expectedVersion: 5,
    });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("version_conflict");
  });

  it("two concurrent publishes with the same expectedVersion: one wins, one conflicts", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    const rs = await Promise.all(
      ["x", "y"].map((c) =>
        publishV(a.id, {
          format: "html",
          content: `<p>${c}</p>`,
          expectedVersion: 1,
        }),
      ),
    );
    const statuses = rs.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const lost = rs.find((r) => r.status === 409) as Response;
    expect((await errOf(lost)).code).toBe("version_conflict");
    expect(await versionCount(a.id)).toBe(2);
  });

  it("is refused without an id, and on a create", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      format: "html",
      content: "x",
      expectedVersion: 1,
    });
    expect(r.status).toBe(400);
  });

  it("must be a positive integer", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    for (const v of [0, -1, 1.5, "1"]) {
      const r = await publishV(a.id, {
        format: "html",
        content: "x",
        expectedVersion: v,
      });
      expect(r.status, String(v)).toBe(400);
    }
  });
});

describe("edits", () => {
  it("applies the edits in order, each against the text as it stands", async () => {
    const a = await make({ format: "html", content: "<p>one two</p>" });
    const r = await publishV(a.id, {
      edits: [
        { old: "one", new: "three" },
        // Matches only the text the first edit wrote.
        { old: "three two", new: "done" },
      ],
      message: "edit",
    });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { version: number }).version).toBe(2);
    expect(await text(a.id, 2, "index.html")).toBe("<p>done</p>");
    // The old version is untouched.
    expect(await text(a.id, 1, "index.html")).toBe("<p>one two</p>");
  });

  it("a miss publishes nothing and names the edit's index", async () => {
    const a = await make({ format: "html", content: "<p>one two</p>" });
    const r = await publishV(a.id, {
      edits: [
        { old: "one", new: "1" },
        { old: "absent", new: "x" },
      ],
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.code).toBe("edit_failed");
    expect(e.message).toContain("edits[1]");
    expect(e.message).toContain("not found");
    expect(e.message).toContain("get_artifact");
    expect(e.details).toMatchObject({ index: 1, reason: "not_found" });
    expect(await versionCount(a.id)).toBe(1);
  });

  it("a double match publishes nothing and names the index and count", async () => {
    const a = await make({ format: "html", content: "<p>ab ab ab</p>" });
    const r = await publishV(a.id, {
      edits: [{ old: "ab", new: "x" }],
    });
    expect(r.status).toBe(400);
    const e = await errOf(r);
    expect(e.code).toBe("edit_failed");
    expect(e.message).toContain("edits[0]");
    expect(e.message).toContain("found 3 times");
    expect(e.details).toMatchObject({
      index: 0,
      reason: "ambiguous",
      count: 3,
    });
    expect(await versionCount(a.id)).toBe(1);
  });

  it("an old that overlaps itself counts as more than one match", async () => {
    const a = await make({ format: "markdown", content: "aaa" });
    const r = await publishV(a.id, { edits: [{ old: "aa", new: "b" }] });
    expect(r.status).toBe(400);
    expect((await errOf(r)).details).toMatchObject({ count: 2 });
  });

  it("carries every other file over byte for byte", async () => {
    const bin = Buffer.from([0, 1, 2, 250, 251, 252, 255, 7]);
    const a = await make({
      entry: "index.html",
      files: {
        "index.html": '<script src="app.js"></script><p>old</p>',
        "app.js": "console.log(1)",
        "img/logo.png": { base64: bin.toString("base64") },
      },
    });
    const r = await publishV(a.id, { edits: [{ old: "old", new: "new" }] });
    expect(r.status).toBe(201);
    expect(await text(a.id, 2, "index.html")).toBe(
      '<script src="app.js"></script><p>new</p>',
    );
    expect(await text(a.id, 2, "app.js")).toBe("console.log(1)");
    const png = await api(
      app,
      R.versionFile(a.id, 2, "img/logo.png"),
      owner.cookie,
    );
    expect(Buffer.from(await png.arrayBuffer())).toEqual(bin);
    const vs = (await (
      await api(app, R.versions(a.id), owner.cookie)
    ).json()) as { version: number; files: { path: string; size: number }[] }[];
    const sorted = (v: number) =>
      (vs.find((x) => x.version === v)?.files ?? []).map((f) => f.path).sort();
    expect(sorted(2)).toEqual(sorted(1));
  });

  it("works on markdown and code", async () => {
    const m = await make({ format: "markdown", content: "# Hi\n\nold" });
    expect(
      (await publishV(m.id, { edits: [{ old: "old", new: "new" }] })).status,
    ).toBe(201);
    expect(await text(m.id, 2, "README.md")).toBe("# Hi\n\nnew");
    const c = await make({
      format: "code",
      language: "python",
      content: "x = 1\n",
    });
    expect(
      (await publishV(c.id, { edits: [{ old: "1", new: "2" }] })).status,
    ).toBe(201);
    expect(await text(c.id, 2, "main.py")).toBe("x = 2\n");
  });

  it("keeps a BOM and CRLF line endings outside the edit", async () => {
    const src = "\uFEFF<p>one</p>\r\n<p>two</p>\r\n<p>three</p>\r\n";
    const a = await make({ format: "html", content: src });
    const r = await publishV(a.id, {
      edits: [{ old: "<p>two</p>", new: "<p>2</p>" }],
    });
    expect(r.status).toBe(201);
    const bytes = new Uint8Array(
      await (
        await api(app, R.versionFile(a.id, 2, "index.html"), owner.cookie)
      ).arrayBuffer(),
    );
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(
      src.replace("<p>two</p>", "<p>2</p>"),
    );
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("a pdf or an image is refused", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const pdf = await make({
      entry: "doc.pdf",
      files: {
        "doc.pdf": {
          base64: Buffer.from("%PDF-1.4\nold\n").toString("base64"),
        },
      },
    });
    const img = await make({
      entry: "p.png",
      files: { "p.png": { base64: png.toString("base64") } },
    });
    const svg = await make({
      format: "image",
      entry: "i.svg",
      content: '<svg xmlns="http://www.w3.org/2000/svg">old</svg>',
    });
    for (const a of [pdf, img, svg]) {
      const r = await publishV(a.id, { edits: [{ old: "old", new: "x" }] });
      expect(r.status).toBe(400);
      expect((await errOf(r)).details).toMatchObject({ path: "edits" });
      expect(await versionCount(a.id)).toBe(1);
    }
  });

  it("can't be combined with content, files, entry, format or language", async () => {
    const a = await make({ format: "html", content: "<p>x</p>" });
    const edits = [{ old: "x", new: "y" }];
    for (const extra of [
      { content: "z", format: "html" },
      { files: { "a.html": "z" } },
      { entry: "index.html" },
      { format: "html" },
      { language: "html" },
    ]) {
      const r = await publishV(a.id, { edits, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await versionCount(a.id)).toBe(1);
  });

  it("takes 1 to 64 non-empty olds", async () => {
    const a = await make({ format: "html", content: "<p>x</p>" });
    const one = { old: "x", new: "y" };
    expect((await publishV(a.id, { edits: [] })).status).toBe(400);
    expect(
      (await publishV(a.id, { edits: Array.from({ length: 65 }, () => one) }))
        .status,
    ).toBe(400);
    expect(
      (await publishV(a.id, { edits: [{ old: "", new: "y" }] })).status,
    ).toBe(400);
    expect((await publishV(a.id, { edits: [{ old: "x" }] })).status).toBe(400);
  });

  it("needs an id", async () => {
    const r = await post(R.artifacts, {
      title: "t",
      edits: [{ old: "x", new: "y" }],
    });
    expect(r.status).toBe(400);
  });

  it("takes an implicit expectedVersion; a stated one must be current", async () => {
    const a = await make({ format: "html", content: "<p>x</p>" });
    await publishV(a.id, { format: "html", content: "<p>x2</p>" });
    const stale = await publishV(a.id, {
      edits: [{ old: "x2", new: "y" }],
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect((await errOf(stale)).code).toBe("version_conflict");
    const ok = await publishV(a.id, {
      edits: [{ old: "x2", new: "y" }],
      expectedVersion: 2,
    });
    expect(ok.status).toBe(201);
  });

  it("two concurrent edits: one wins, the other conflicts and nothing is lost", async () => {
    const a = await make({ format: "html", content: "<p>a b</p>" });
    const rs = await Promise.all([
      publishV(a.id, { edits: [{ old: "a", new: "A" }] }),
      publishV(a.id, { edits: [{ old: "b", new: "B" }] }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const lost = rs.find((r) => r.status === 409) as Response;
    expect((await errOf(lost)).code).toBe("version_conflict");
    expect(await versionCount(a.id)).toBe(2);
  });

  it("a publish landing between the read and the allocate is version_conflict", async () => {
    const a = await make({ format: "html", content: "<p>a</p>" });
    let raced = false;
    // The entry is read from R2 after the current version is known: publish
    // another version right then.
    const files = new Proxy(env.FILES, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (typeof v !== "function") return v;
        if (k !== "get") return v.bind(t);
        return async (...args: unknown[]) => {
          if (!raced) {
            raced = true;
            const r = await publishV(a.id, {
              format: "html",
              content: "<p>other</p>",
            });
            expect(r.status).toBe(201);
          }
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
    const racing = new Proxy(env, {
      get: (t, k) => (k === "FILES" ? files : Reflect.get(t, k)),
    });
    const user = await getUser(env, owner.userId);
    if (!user) throw new Error("no user");
    const err = await publish(
      racing as typeof env,
      user,
      { id: a.id, edits: [{ old: "a", new: "b" }] } as never,
      null,
    ).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    expect(raced).toBe(true);
    expect(err?.code).toBe("version_conflict");
    expect(await versionCount(a.id)).toBe(2);
    expect(await text(a.id, 2, "index.html")).toBe("<p>other</p>");
  });

  it("a viewer can't edit", async () => {
    const a = await make({ format: "html", content: "<p>x</p>" });
    const other = await login(
      `edits-o-${newId().slice(0, 6).toLowerCase()}@x.com`,
    );
    const r = await api(app, R.versions(a.id), other.cookie, {
      method: "POST",
      body: { edits: [{ old: "x", new: "y" }] },
    });
    expect(r.status).toBe(404);
  });
});

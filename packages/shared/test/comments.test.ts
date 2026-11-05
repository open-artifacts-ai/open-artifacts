import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ArtifactEventSchema,
  ArtifactPatchSchema,
  ArtifactSummarySchema,
  anchorInputSchema,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
  NewThreadBodySchema,
  R,
  ReplyBodySchema,
} from "../src/index.js";
import { createArtifactEvents } from "../src/mocks/events.js";
import { fixtures } from "../src/mocks/fixtures.js";
import { createHandlers } from "../src/mocks/handlers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const O = "http://app.localhost";
const art = fixtures.artifacts.find((a) => a.title === "Landing page");
if (!art) throw new Error("no Landing page fixture");
const base = `${O}${R.comments(art.id)}`;
const send = (method: string, url: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      cookie: "oa_session=t",
      "X-OA-Request": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const use = (opts = {}) => server.use(...createHandlers(opts));
const list = async () =>
  CommentListSchema.parse(
    await (await send("GET", `${base}?status=all`)).json(),
  );

const author = { kind: "user", name: "A", me: true };
const comment = {
  id: "c1",
  body: "x",
  author,
  createdAt: "2026-11-05T10:00:00Z",
  editedAt: null,
  can: { edit: true, delete: false },
};

describe("comment schemas", () => {
  it("Comment.can carries edit and delete, both required booleans", () => {
    expect(CommentSchema.parse(comment).can).toEqual({
      edit: true,
      delete: false,
    });
    expect(
      CommentSchema.safeParse({ ...comment, can: { edit: true } }).success,
    ).toBe(false);
    expect(
      CommentSchema.safeParse({ ...comment, can: undefined }).success,
    ).toBe(false);
  });

  const thread = {
    id: "t1",
    anchor: { kind: "note" },
    version: 3,
    status: "open",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-11-05T10:00:00Z",
    comments: [comment],
  };
  it("Thread.version and anchor.version are integers of at least 1", () => {
    expect(CommentThreadSchema.safeParse(thread).success).toBe(true);
    for (const v of ["3", 1.5, 0, -1])
      expect(
        CommentThreadSchema.safeParse({ ...thread, version: v }).success,
      ).toBe(false);
    const text = { kind: "text", exact: "a", prefix: "", suffix: "" };
    expect(
      CommentThreadSchema.safeParse({
        ...thread,
        anchor: { ...text, version: 2 },
      }).success,
    ).toBe(true);
    for (const v of ["2", 2.5, 0])
      expect(
        CommentThreadSchema.safeParse({
          ...thread,
          anchor: { ...text, version: v },
        }).success,
      ).toBe(false);
  });

  it("the new error codes, the comments event and the settings fields parse", () => {
    for (const code of [
      "invalid_anchor",
      "invalid_body",
      "anchor_not_in_version",
      "comments_off",
      "forbidden",
    ])
      expect(
        ApiErrorSchema.safeParse({ error: { code, message: "m" } }).success,
      ).toBe(true);
    expect(ArtifactEventSchema.parse({ type: "comments", open: 2 })).toEqual({
      type: "comments",
      open: 2,
    });
    expect(
      ArtifactEventSchema.safeParse({ type: "comments", open: -1 }).success,
    ).toBe(false);
    expect(ArtifactPatchSchema.parse({ comments: false })).toEqual({
      comments: false,
    });
    expect(
      ArtifactSummarySchema.shape.comments.safeParse(undefined).success,
    ).toBe(true);
  });
});

describe("comment request bodies", () => {
  const text = { kind: "text", exact: "a", prefix: "", suffix: "" };
  const pin = { kind: "pin", x: 0.5, y: 0.25, contentHash: "h" };

  it("accepts an anchor with or without version; note needs none", () => {
    for (const a of [
      { kind: "note" },
      text,
      { ...text, version: 3 },
      pin,
      { ...pin, version: 2, page: 4 },
    ])
      expect(anchorInputSchema.safeParse(a).success).toBe(true);
  });

  it("rejects unknown kinds, oversize exact, bad pin x/y, bad versions, extra keys", () => {
    for (const a of [
      { kind: "region" },
      { kind: "note", extra: 1 },
      { ...text, exact: "" },
      { ...text, exact: "x".repeat(1001) },
      { ...text, prefix: "x".repeat(65) },
      { ...text, version: 0 },
      { ...text, version: "2" },
      { ...pin, x: 1.1 },
      { ...pin, y: -0.1 },
      { ...pin, x: Number.NaN },
      { ...pin, contentHash: "" },
    ])
      expect(anchorInputSchema.safeParse(a).success).toBe(false);
  });

  it("NewThreadBody trims the body and bounds it and guestName", () => {
    const ok = NewThreadBodySchema.parse({
      anchor: { kind: "note" },
      body: "  hi ",
    });
    expect(ok.body).toBe("hi");
    for (const body of ["  ", "x".repeat(2001)])
      expect(
        NewThreadBodySchema.safeParse({ anchor: { kind: "note" }, body })
          .success,
      ).toBe(false);
    expect(
      NewThreadBodySchema.safeParse({
        anchor: { kind: "note" },
        body: "a",
        guestName: "g".repeat(51),
      }).success,
    ).toBe(false);
    expect(
      NewThreadBodySchema.safeParse({
        anchor: { kind: "note" },
        body: "a",
        guestName: "g".repeat(50),
      }).success,
    ).toBe(true);
    expect(NewThreadBodySchema.safeParse({ body: "a" }).success).toBe(false);
  });

  it("ReplyBody is the same without an anchor", () => {
    expect(ReplyBodySchema.parse({ body: " ok " })).toEqual({ body: "ok" });
    expect(ReplyBodySchema.safeParse({ body: "" }).success).toBe(false);
    expect(
      ReplyBodySchema.safeParse({ body: "a", guestName: "g".repeat(51) })
        .success,
    ).toBe(false);
  });
});

describe("comments mock", () => {
  it("fills the current version when a text anchor has none, keeps an explicit one", async () => {
    use();
    const text = { kind: "text", exact: "a", prefix: "", suffix: "" };
    const t1 = CommentThreadSchema.parse(
      await (await send("POST", base, { anchor: text, body: "x" })).json(),
    );
    expect(t1.version).toBe(art.currentVersion);
    const t2 = CommentThreadSchema.parse(
      await (
        await send("POST", base, { anchor: { ...text, version: 1 }, body: "x" })
      ).json(),
    );
    expect(t2.version).toBe(1);
  });

  it("400 invalid_anchor for a bad anchor", async () => {
    use();
    for (const anchor of [
      { kind: "region" },
      { kind: "pin", version: 1, x: 2, y: 0, contentHash: "h" },
      undefined,
    ]) {
      const r = await send("POST", base, { anchor, body: "x" });
      expect(r.status).toBe(400);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
        "invalid_anchor",
      );
    }
  });

  it("lists, creates, replies, resolves, edits and deletes", async () => {
    use();
    const first = await list();
    expect(first.threads.length).toBeGreaterThan(0);
    const r = await send("POST", base, {
      anchor: { kind: "note" },
      body: " hi ",
    });
    expect(r.status).toBe(201);
    const t = CommentThreadSchema.parse(await r.json());
    expect(t.comments[0]?.body).toBe("hi");
    expect(
      (await send("POST", `${base}/${t.id}/replies`, { body: "r" })).status,
    ).toBe(201);
    const p = await send("PATCH", `${base}/${t.id}`, { status: "resolved" });
    expect(CommentThreadSchema.parse(await p.json()).status).toBe("resolved");
    const cid = t.comments[0]?.id;
    expect(
      (await send("PATCH", `${base}/${t.id}/comments/${cid}`, { body: "new" }))
        .status,
    ).toBe(200);
    expect(
      (await send("DELETE", `${base}/${t.id}/comments/${cid}`)).status,
    ).toBe(204);
    expect((await list()).threads.some((x) => x.id === t.id)).toBe(false);
  });

  it("400 invalid_body for an empty or over-long body", async () => {
    use();
    for (const body of ["  ", "x".repeat(2001)]) {
      const r = await send("POST", base, { anchor: { kind: "note" }, body });
      expect(r.status).toBe(400);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
        "invalid_body",
      );
    }
  });

  it("400 bad_request for a malformed thread or comment id", async () => {
    use();
    for (const [m, u, b] of [
      ["POST", `${base}/bad%20id/replies`, { body: "x" }],
      ["PATCH", `${base}/bad%20id`, { status: "open" }],
      ["PATCH", `${base}/t/comments/bad%20id`, { body: "x" }],
      ["DELETE", `${base}/t/comments/bad%20id`, undefined],
    ] as const) {
      const r = await send(m, u, b);
      expect(r.status).toBe(400);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
        "bad_request",
      );
    }
  });

  it("409 conflict on a thread's 201st reply", async () => {
    use();
    const t = CommentThreadSchema.parse(
      await (
        await send("POST", base, { anchor: { kind: "note" }, body: "root" })
      ).json(),
    );
    for (let i = 0; i < 200; i++)
      expect(
        (await send("POST", `${base}/${t.id}/replies`, { body: `r${i}` }))
          .status,
      ).toBe(201);
    const r = await send("POST", `${base}/${t.id}/replies`, { body: "201st" });
    expect(r.status).toBe(409);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("conflict");
  });

  it("429 rate_limited with Retry-After when commentsRateLimit is set; reads still work", async () => {
    use({ commentsRateLimit: 42 });
    const r = await send("POST", base, { anchor: { kind: "note" }, body: "x" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("42");
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
      "rate_limited",
    );
    expect((await send("GET", base)).status).toBe(200);
  });

  it("403 comments_off when the artifact has comments off", async () => {
    use();
    await send("PATCH", `${O}${R.artifact(art.id)}`, { comments: false });
    const r = await send("GET", base);
    expect(r.status).toBe(403);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe(
      "comments_off",
    );
  });

  it("emits a comments event with the open count after a write", async () => {
    const events = createArtifactEvents();
    server.use(...createHandlers({ events }), ...events.handlers);
    const ws = new WebSocket(`ws://app.localhost${R.events(art.id)}`);
    const frames: unknown[] = [];
    ws.addEventListener("message", (e) =>
      frames.push(JSON.parse(String(e.data))),
    );
    await new Promise((r) => ws.addEventListener("open", () => r(null)));
    await send("POST", base, { anchor: { kind: "note" }, body: "x" });
    await new Promise((r) => setTimeout(r, 20));
    expect(frames).toContainEqual({
      type: "comments",
      open: expect.any(Number),
    });
    ws.close();
  });
});

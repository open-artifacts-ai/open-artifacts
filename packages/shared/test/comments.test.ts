import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ArtifactEventSchema,
  ArtifactPatchSchema,
  ArtifactSummarySchema,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
  R,
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

describe("comments mock", () => {
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

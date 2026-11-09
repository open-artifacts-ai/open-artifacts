import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ArtifactAgentSchema,
  ArtifactEventSchema,
  ArtifactPatchSchema,
  ArtifactSummarySchema,
  AskInputSchema,
  anchorInputSchema,
  CommentAskSchema,
  CommentListSchema,
  CommentSchema,
  CommentThreadSchema,
  ListQuerySchema,
  NewThreadBodySchema,
  R,
  ReplyBodySchema,
} from "../src/index.js";
import { createCommentHandlers } from "../src/mocks/comments.js";
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
  const pin = { kind: "pin", x: 0.5, y: 0.25, contentHash: "a".repeat(64) };

  it("accepts an anchor with or without version; note needs none", () => {
    for (const a of [
      { kind: "note" },
      text,
      { ...text, version: 3 },
      pin,
      { ...pin, version: 2, page: 4 },
      { kind: "pin", x: 0.5, y: 0.25 },
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
      { ...pin, contentHash: "h" },
      { ...pin, contentHash: "A".repeat(64) },
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

  it("#1496: edit is the author's; delete is the author's or a moderator's", async () => {
    const me = { user: { id: "me1", name: "Me", email: "me@x.test" } };
    const handlers = (over: object) =>
      createCommentHandlers({
        artifacts: [{ ...art, ...over }] as never,
        me,
        err: () => new Response(null, { status: 400 }),
        emit: () => {},
      });
    const cans = async (over: object) => {
      server.use(...handlers(over));
      const l = await list();
      return l.threads[0]?.comments.map((c) => ({
        by: c.author.me,
        edit: c.can.edit,
        del: c.can.delete,
      }));
    };
    const someone = { ...art.owner, id: "someone-else" };
    // A plain viewer: nobody else's comment is theirs to change.
    expect(await cans({ owner: someone, can: { edit: false } })).toEqual([
      { by: false, edit: false, del: false },
      { by: true, edit: true, del: true },
    ]);
    // The owner, or one who can edit the artifact, may delete others' comments, never edit them.
    for (const over of [
      { owner: { ...someone, id: "me1" } },
      { owner: someone, can: { edit: true } },
    ])
      expect(await cans(over)).toEqual([
        { by: false, edit: false, del: true },
        { by: true, edit: true, del: true },
      ]);
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

describe("asks and mentions (#1535)", () => {
  const viewerArt = fixtures.artifacts.find(
    (a) => a.title === "Onboarding guide",
  );
  if (!viewerArt) throw new Error("no Onboarding guide fixture");
  const opts = [
    { id: "a", label: "A" },
    { id: "b", label: "B", detail: "d" },
  ];
  const ask = (to: string) => ({
    question: "Which?",
    options: opts,
    recommended: { optionId: "a", why: "Because" },
    to: [{ key: to }],
  });
  const seeded = async () => {
    const t = (await list()).threads.find((x) => x.comments.some((c) => c.ask));
    const c = t?.comments.find((x) => x.ask);
    if (!t || !c) throw new Error("no seeded ask");
    return { t, c };
  };
  const answerUrl = (t: string, c: string) =>
    `${O}${R.commentAnswer(art.id, t, c)}`;

  it("route builders", () => {
    expect(R.commentAnswer("a", "t", "c")).toBe(
      "/api/v1/artifacts/a/comments/t/comments/c/answer",
    );
    expect(R.artifactAgents("a")).toBe("/api/v1/artifacts/a/agents");
  });

  it("bounds on asks, options and keys; recommended must be an option", () => {
    expect(AskInputSchema.safeParse(ask("agent:codex")).success).toBe(true);
    const bad = (a: unknown) => AskInputSchema.safeParse(a).success;
    expect(bad({ ...ask("u"), options: [opts[0]] })).toBe(false);
    expect(
      bad({
        ...ask("u"),
        options: Array.from({ length: 7 }, (_, i) => ({
          id: `o${i}`,
          label: "l",
        })),
      }),
    ).toBe(false);
    expect(
      bad({ ...ask("u"), options: [opts[0], { id: "a", label: "dup" }] }),
    ).toBe(false);
    expect(bad({ ...ask("u"), question: "q".repeat(1001) })).toBe(false);
    expect(bad({ ...ask("u"), question: "   " })).toBe(false);
    expect(
      bad({ ...ask("u"), options: [opts[0], { id: "b", label: " \t " }] }),
    ).toBe(false);
    const trimmed = AskInputSchema.parse({
      ...ask("u"),
      question: "  Which?  ",
      options: [{ ...opts[0], label: "  A  " }, opts[1]],
    });
    expect(trimmed.question).toBe("Which?");
    expect(trimmed.options[0]?.label).toBe("A");
    expect(
      bad({
        ...ask("u"),
        options: [opts[0], { id: "b", label: "x".repeat(121) }],
      }),
    ).toBe(false);
    expect(
      bad({
        ...ask("u"),
        options: [opts[0], { id: "b", label: "l", detail: "x".repeat(501) }],
      }),
    ).toBe(false);
    expect(
      bad({
        ...ask("u"),
        recommended: { optionId: "a", why: "x".repeat(501) },
      }),
    ).toBe(false);
    expect(bad({ ...ask("u"), to: [] })).toBe(false);
    expect(bad(ask("bad key"))).toBe(false);
    expect(bad(ask("k".repeat(129)))).toBe(false);
    // recommended.optionId must be one of the options, on input and on output.
    expect(
      bad({ ...ask("u"), recommended: { optionId: "zzz", why: "w" } }),
    ).toBe(false);
    expect(bad({ ...ask("u"), recommended: undefined })).toBe(true);
    const out = {
      question: "Q",
      options: opts,
      to: [author],
      closed: false,
    };
    expect(CommentAskSchema.safeParse(out).success).toBe(true);
    expect(
      CommentAskSchema.safeParse({
        ...out,
        recommended: { optionId: "b", why: "w" },
      }).success,
    ).toBe(true);
    expect(
      CommentAskSchema.safeParse({
        ...out,
        recommended: { optionId: "zzz", why: "w" },
      }).success,
    ).toBe(false);
  });

  it("the REST bodies do not take an ask", async () => {
    const withAsk = { body: "x", ask: ask("u") };
    expect(ReplyBodySchema.parse(withAsk)).not.toHaveProperty("ask");
    expect(
      NewThreadBodySchema.parse({ ...withAsk, anchor: { kind: "note" } }),
    ).not.toHaveProperty("ask");
    use();
    const r = await send("POST", base, {
      anchor: { kind: "note" },
      ...withAsk,
    });
    expect(r.status).toBe(201);
    expect(
      CommentThreadSchema.parse(await r.json()).comments[0]?.ask,
    ).toBeUndefined();
  });

  it("mentions shape; assign is stripped, not stored", () => {
    expect(
      ReplyBodySchema.safeParse({
        body: "x",
        mentions: [{ key: "agent:codex" }],
      }).success,
    ).toBe(true);
    // The other fields are not strict: an unknown `assign` is dropped by parsing.
    expect(
      ReplyBodySchema.parse({
        body: "x",
        assign: { key: "agent:codex" },
      }),
    ).toEqual({ body: "x" });
    expect(
      ReplyBodySchema.safeParse({ body: "x", mentions: [{ key: "a b" }] })
        .success,
    ).toBe(false);
    // An old comment that still carries `assigned` reads, with it gone.
    const old = CommentSchema.parse({
      ...comment,
      mentions: [{ key: "k", name: "N", delivery: "gone" }],
      assigned: { key: "k", name: "N", state: "done" },
    });
    expect(old.mentions).toHaveLength(1);
    expect(old).not.toHaveProperty("assigned");
  });

  it("the list query accepts filter and summaries carry asksForYou", async () => {
    use({ commentAsks: true });
    expect(ListQuerySchema.parse({ filter: "needs_answer" }).filter).toBe(
      "needs_answer",
    );
    expect(ListQuerySchema.safeParse({ filter: "nope" }).success).toBe(false);
    const need = await (
      await send("GET", `${O}${R.artifacts}?filter=needs_answer`)
    ).json();
    expect(need.items.map((a: { id: string }) => a.id)).toEqual([art.id]);
    expect(ArtifactSummarySchema.parse(need.items[0]).asksForYou).toBe(1);
    expect(
      (await send("GET", `${O}${R.artifacts}?filter=waiting_on_agents`)).status,
    ).toBe(400);
    expect((await send("GET", `${O}${R.artifacts}?filter=x`)).status).toBe(400);
  });

  it("GET artifactAgents lists key, name and online", async () => {
    use({ commentAsks: true });
    const r = await send("GET", `${O}${R.artifactAgents(art.id)}`);
    const l = ArtifactAgentSchema.array().parse(await r.json());
    expect(l.length).toBeGreaterThan(0);
    expect(
      (await send("GET", `${O}${R.artifactAgents("Zz9yXwVuTs8rQpOn")}`)).status,
    ).toBe(404);
  });

  it("answers: addressee only, change before close, 409 once closed, 400 unknown option", async () => {
    use({ commentAsks: true });
    const { t, c } = await seeded();
    expect(CommentSchema.parse(c).ask?.closed).toBe(false);
    const url = answerUrl(t.id, c.id);
    let r = await send("POST", url, { optionId: "nope" });
    expect(r.status).toBe(400);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("bad_request");
    const first = c.ask?.options[0]?.id;
    const second = c.ask?.options[1]?.id;
    r = await send("POST", url, { optionId: first });
    expect(r.status).toBe(200);
    expect(CommentSchema.parse(await r.json()).ask?.answer?.optionId).toBe(
      first,
    );
    r = await send("POST", url, { optionId: second });
    expect(CommentSchema.parse(await r.json()).ask?.answer?.optionId).toBe(
      second,
    );
    expect((await list()).threads.find((x) => x.id === t.id)?.status).toBe(
      "open",
    );
    // Answered: no longer an ask for you.
    const none = await (
      await send("GET", `${O}${R.artifacts}?filter=needs_answer`)
    ).json();
    expect(none.items).toEqual([]);
    await send("PATCH", `${base}/${t.id}`, { status: "resolved" });
    expect(
      (await list()).threads
        .find((x) => x.id === t.id)
        ?.comments.find((x) => x.id === c.id)?.ask?.closed,
    ).toBe(true);
    r = await send("POST", url, { optionId: first });
    expect(r.status).toBe(409);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("conflict");
    await send("PATCH", `${base}/${t.id}`, { status: "open" });
    expect((await send("POST", url, { optionId: first })).status).toBe(200);
  });

  it("403 forbidden when the caller is not an addressee; 404 for a comment with no ask", async () => {
    use({ commentAsks: true });
    const t = (await list()).threads.find((x) =>
      x.comments.some((c) => c.ask && !c.ask.to.some((a) => a.me)),
    );
    const c = t?.comments[0];
    if (!t || !c) throw new Error("no ask for someone else");
    const a = await send("POST", answerUrl(t.id, c.id), { optionId: "yes" });
    expect(a.status).toBe(403);
    expect(ApiErrorSchema.parse(await a.json()).error.code).toBe("forbidden");
    const plain = await send("POST", `${base}/${t.id}/replies`, { body: "r" });
    const pc = CommentSchema.parse(await plain.json());
    expect(
      (await send("POST", answerUrl(t.id, pc.id), { optionId: "a" })).status,
    ).toBe(404);
  });

  it("mentions: delivery by agent presence; an assign in the body is ignored", async () => {
    use();
    const r = await send("POST", base, {
      anchor: { kind: "note" },
      body: "@Claude Code @Codex",
      mentions: [{ key: "agent:claude-code" }, { key: "agent:codex" }],
      assign: { key: "agent:codex" },
    });
    expect(r.status).toBe(201);
    const c = CommentThreadSchema.parse(await r.json()).comments[0];
    expect(c?.mentions).toEqual([
      { key: "agent:claude-code", name: "Claude Code", delivery: "delivered" },
      { key: "agent:codex", name: "Codex", delivery: "queued" },
    ]);
    expect(c).not.toHaveProperty("assigned");
  });

  it("403 forbidden for mentions from a non owner or editor", async () => {
    use();
    const url = `${O}${R.comments(viewerArt.id)}`;
    for (const extra of [{ mentions: [{ key: "agent:codex" }] }]) {
      const r = await send("POST", url, {
        anchor: { kind: "note" },
        body: "x",
        ...extra,
      });
      expect(r.status).toBe(403);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("forbidden");
    }
    // A plain comment is still fine.
    expect(
      (await send("POST", url, { anchor: { kind: "note" }, body: "x" })).status,
    ).toBe(201);
  });
});

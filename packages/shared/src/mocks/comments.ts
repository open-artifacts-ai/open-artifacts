/**
 * MSW mock of the comments REST contract (#682), in memory per createHandlers.
 * Seeded with one open text thread and one resolved note on the "Landing page"
 * fixture, so a test or the mock app has something to show.
 */
import { delay, type HttpHandler, HttpResponse, http } from "msw";
import type { Anchor } from "../anchor.js";
import {
  AnswerBodySchema,
  type ArtifactAgent,
  anchorInputSchema,
  type Comment,
  type CommentAuthor,
  type CommentThread,
  ReplyBodySchema,
  type ThreadAgent,
} from "../comments.js";
import type { ErrorCode } from "../errors.js";
import { newId } from "../ids.js";
import type { ArtifactSummary } from "../schemas.js";

/** The agents the mock lists for every artifact (R.artifactAgents). */
export const MOCK_AGENTS: ArtifactAgent[] = [
  {
    key: "agent:claude-code",
    name: "Claude Code",
    online: true,
    state: "online",
    lastActiveAt: null,
    machine: "laptop",
  },
  {
    key: "agent:manager-2",
    name: "OA Manager-2",
    online: true,
    state: "online",
    lastActiveAt: null,
    machine: "laptop",
  },
  {
    key: "agent:codex",
    name: "Codex",
    online: false,
    state: "away",
    lastActiveAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    machine: "laptop",
  },
  {
    key: "agent:sam-bot",
    name: "OA Manager (Sam)",
    online: true,
    state: "online",
    lastActiveAt: null,
    machine: null,
    owner: "Sam",
  },
  {
    key: "agent:manager",
    name: "OA Manager",
    online: false,
    state: "away",
    lastActiveAt: new Date(Date.now() - 19 * 3600_000).toISOString(),
    machine: "workstation",
  },
];

/** #2035: the agents the seeded agents thread notifies. The first two the caller may remove; the others are another member's. */
const THREAD_AGENTS: ThreadAgent[] = [
  {
    key: "agent:product",
    name: "OA Product",
    for: "Leo Urbina",
    linked: true,
    product: "Claude Code",
    animal: { id: "fox", color: 2 },
    canRemove: true,
  },
  {
    key: "agent:claude-code",
    name: "Claude Code",
    for: "Leo Urbina",
    linked: false,
    canRemove: true,
  },
  {
    key: "agent:bus",
    name: "OA Bus",
    for: "Sam Rivera",
    linked: true,
    product: "Codex",
    animal: { id: "owl", color: 4 },
    canRemove: false,
  },
  {
    key: "agent:polish",
    name: "OA Polish",
    for: "Sam Rivera",
    linked: true,
    product: "Codex",
    animal: { id: "otter", color: 5 },
    canRemove: false,
  },
];

type Deps = {
  artifacts: ArtifactSummary[];
  me: { user: { id: string; name: string | null; email: string } };
  err: (code: ErrorCode, message: string) => Response;
  emit: (id: string, open: number) => void;
  /** Every write answers 429 with this Retry-After (seconds). */
  rateLimit?: number;
  /** The hash of a version's content, which the server stamps on a pin (#1490). */
  contentHash?: (id: string, version: number) => string | null | undefined;
  /** Also seed an open ask addressed to the caller on "Landing page" (default off: list responses stay byte-identical to the fixtures). */
  seedAsk?: boolean;
  /** Also seed a thread with a linked agent, an unlinked agent of the same name and a person (#1822). */
  seedAgents?: boolean;
};

const iso = () => new Date().toISOString();

export function createCommentHandlers(d: Deps): HttpHandler[] {
  return createCommentMock(d).handlers;
}

export function createCommentMock({
  artifacts,
  me,
  err,
  emit,
  rateLimit,
  contentHash,
  seedAsk,
  seedAgents,
}: Deps): {
  handlers: HttpHandler[];
  /** Open asks addressed to the caller on this artifact. */
  asksForYou: (id: string) => number;
} {
  const threads = new Map<string, CommentThread[]>();
  const mine = (): CommentAuthor => ({
    kind: "user",
    id: me.user.id,
    name: me.user.name ?? me.user.email,
    me: true,
  });
  const other: CommentAuthor = {
    kind: "user",
    id: "someone",
    name: "Sam Rivera",
    me: false,
  };
  /** Per #1496: edit is the author's; delete is the author's or a moderator's (owner, manager or editor). */
  const comment = (
    body: string,
    by: CommentAuthor,
    moderator = false,
  ): Comment => ({
    id: newId(),
    body,
    author: by,
    createdAt: iso(),
    editedAt: null,
    typed: by.kind === "user",
    can: { edit: by.me, delete: by.me || moderator },
  });
  const moderates = (id: string) => {
    const a = artifacts.find((x) => x.id === id);
    return a?.owner.id === me.user.id || a?.can?.edit === true;
  };
  const seed = (id: string): CommentThread[] => {
    const m = moderates(id);
    const a = comment("Can we tighten this headline?", other, m);
    const b = comment("Agreed, shorter is better.", mine());
    const c = comment("Looks good overall.", other, m);
    const d = comment("Which layout do we ship?", other, m);
    d.ask = {
      question: "Which layout do we ship?",
      options: [
        { id: "wide", label: "Wide hero", detail: "Full-bleed image" },
        { id: "compact", label: "Compact hero" },
      ],
      recommended: { optionId: "compact", why: "Loads faster on mobile." },
      to: [mine()],
      closed: false,
    };
    const e = comment("Ship the banner?", mine());
    e.ask = {
      question: "Ship the banner?",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      to: [other],
      closed: false,
    };
    const asked: CommentThread[] = seedAsk
      ? [
          {
            id: newId(),
            anchor: { kind: "note" },
            version: 1,
            status: "open",
            resolvedBy: null,
            resolvedAt: null,
            createdAt: d.createdAt,
            comments: [d],
          },
          {
            id: newId(),
            anchor: { kind: "note" },
            version: 1,
            status: "open",
            resolvedBy: null,
            resolvedAt: null,
            createdAt: e.createdAt,
            comments: [e],
          },
        ]
      : [];
    const faces: CommentThread[] = [];
    if (seedAgents) {
      const agent = (linked: boolean): CommentAuthor => ({
        kind: "agent",
        // An unlinked agent is named by its product (server rule).
        name: linked ? "OA Product" : "Claude Code",
        for: "Leo Urbina",
        linked,
        ...(linked
          ? { product: "Claude Code", animal: { id: "fox", color: 2 } }
          : {}),
        me: false,
      });
      const fox = {
        linked: true,
        product: "Claude Code",
        animal: { id: "fox", color: 2 },
      };
      const ask = comment("Which layout should the Agents page use?", other, m);
      ask.ask = {
        question: "Which layout should the Agents page use?",
        options: [
          { id: "list", label: "List only" },
          { id: "detail", label: "List and detail" },
        ],
        to: [
          { ...agent(true), id: "agent:product", name: "OA Product" },
          { ...agent(false), id: "agent:claude", name: "Claude Code" },
        ],
        closed: false,
      };
      const mention = comment(
        "Looping in @OA Product and @Claude Code on this.",
        other,
        m,
      );
      mention.mentions = [
        {
          key: "agent:product",
          name: "OA Product",
          ...fox,
          for: "Leo Urbina",
          delivery: "delivered",
        },
        {
          key: "agent:claude",
          name: "Claude Code",
          linked: false,
          for: "Leo Urbina",
          delivery: "queued",
        },
      ];
      const f = [
        comment("Can the pricing section be shorter?", other, m),
        comment("Shortened to three sentences.", agent(true)),
        comment("Also fixed the footer typo.", agent(false)),
        mention,
        ask,
      ];
      faces.push({
        id: newId(),
        anchor: { kind: "note" },
        version: 1,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: f[0]?.createdAt ?? iso(),
        comments: f,
        agents: THREAD_AGENTS.map((x) => ({ ...x })),
      });
      // #2035: a thread with one agent, which fits on one line.
      const one = [
        comment("Can you check the footer link?", other, m),
        comment("Fixed, it points at /pricing now.", agent(true)),
      ];
      faces.push({
        id: newId(),
        anchor: { kind: "note" },
        version: 1,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: one[0]?.createdAt ?? iso(),
        comments: one,
        agents: THREAD_AGENTS.slice(0, 1).map((x) => ({ ...x })),
      });
    }
    return [
      {
        id: newId(),
        anchor: {
          kind: "text",
          version: 1,
          exact: "Landing page",
          prefix: "",
          suffix: "",
        },
        version: 1,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: a.createdAt,
        comments: [a, b],
      },
      {
        id: newId(),
        anchor: { kind: "note" },
        version: 1,
        status: "resolved",
        resolvedBy: other,
        resolvedAt: iso(),
        createdAt: c.createdAt,
        comments: [c],
      },
      ...asked,
      ...faces,
    ];
  };
  const list = (id: string) => {
    let l = threads.get(id);
    if (!l) {
      l =
        artifacts.find((x) => x.id === id)?.title === "Landing page"
          ? seed(id)
          : [];
      threads.set(id, l);
    }
    return l;
  };
  const open = (id: string) =>
    list(id).filter((t) => t.status === "open").length;
  const art = (id: unknown) =>
    artifacts.find((x) => x.id === id && x.deletedAt === null);
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const badIds = (...ids: unknown[]): Response | null =>
    ids.every((x) => typeof x === "string" && ID.test(x))
      ? null
      : err("bad_request", "Malformed id");
  const MAX_REPLIES = 200;
  const guard = (id: unknown, write = false): Response | null => {
    const a = art(id);
    if (!a) return err("not_found", "Not found");
    if (a.comments === false) return err("comments_off", "Comments are off");
    if (write && rateLimit !== undefined)
      return HttpResponse.json(
        { error: { code: "rate_limited", message: "Too many comments" } },
        { status: 429, headers: { "Retry-After": String(rateLimit) } },
      );
    return null;
  };
  /** The body fields (ReplyBodySchema); null is invalid_body. The raw JSON rides along for the anchor. */
  const parseBody = async (req: Request) => {
    const raw = (await req.json().catch(() => null)) as {
      anchor?: unknown;
    } | null;
    const r = ReplyBodySchema.safeParse(raw);
    return r.success ? { ...r.data, anchor: raw?.anchor } : null;
  };
  const agentOf = (k: string) => MOCK_AGENTS.find((x) => x.key === k);
  const person = (k: string): CommentAuthor =>
    k === me.user.id
      ? mine()
      : agentOf(k)
        ? { kind: "agent", id: k, name: agentOf(k)?.name ?? k, me: false }
        : { ...other, id: k };
  /**
   * Ask and mentions from a parsed body onto a new comment. mentions
   * are owner and editors only: a Response is the 403.
   */
  const decorate = (
    c: Comment,
    j: {
      mentions?: { key: string }[];
    },
    id: string,
  ): Response | null => {
    if (j.mentions && !moderates(id))
      return err("forbidden", "Only the owner and editors can mention");
    if (j.mentions)
      c.mentions = j.mentions.map((m) => ({
        key: m.key,
        name: agentOf(m.key)?.name ?? m.key,
        delivery: agentOf(m.key)?.online === false ? "queued" : "delivered",
      }));
    return null;
  };
  const closeAsks = (t: CommentThread) => {
    for (const c of t.comments)
      if (c.ask) c.ask.closed = t.status === "resolved";
  };
  const A = "*/api/v1/artifacts/:id/comments";
  const base = A;
  const thr = `${A}/:tid`;
  const rep = `${A}/:tid/replies`;
  const one = `${A}/:tid/comments/:cid`;
  const answer = `${A}/:tid/comments/:cid/answer`;
  const handlers = [
    http.get("*/api/v1/artifacts/:id/agents", ({ params }) => {
      if (!art(params.id)) return err("not_found", "Not found");
      return HttpResponse.json(MOCK_AGENTS);
    }),
    http.post(answer, async ({ params, request }) => {
      const bad = guard(params.id, true) ?? badIds(params.tid, params.cid);
      if (bad) return bad;
      const c = list(String(params.id))
        .find((x) => x.id === params.tid)
        ?.comments.find((x) => x.id === params.cid);
      if (!c?.ask) return err("not_found", "Not found");
      if (!c.ask.to.some((a) => a.me))
        return err("forbidden", "Only the people asked can answer");
      if (c.ask.closed) return err("conflict", "This ask is closed");
      const j = AnswerBodySchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!j.success || !c.ask.options.some((o) => o.id === j.data.optionId))
        return err("bad_request", "Unknown option");
      c.ask.answer = {
        optionId: j.data.optionId,
        by: mine(),
        at: iso(),
        typed: true,
        yes: c.author.me,
      };
      emit(String(params.id), open(String(params.id)));
      return HttpResponse.json(c);
    }),
    http.get(base, async ({ params, request }) => {
      await delay(0);
      const bad = guard(params.id);
      if (bad) return bad;
      const s = new URL(request.url).searchParams.get("status") ?? "all";
      // A signed-out caller (no session, no guest token) can edit or delete nothing (#2080).
      const anon =
        !request.headers.has("cookie") &&
        !/^bearer\s/i.test(request.headers.get("authorization") ?? "");
      const all = list(String(params.id)).map((t) =>
        anon
          ? {
              ...t,
              comments: t.comments.map((c) => ({
                ...c,
                can: { edit: false, delete: false },
              })),
            }
          : t,
      );
      return HttpResponse.json({
        threads: all.filter((t) => s === "all" || t.status === s),
        open: open(String(params.id)),
        truncated: false,
      });
    }),
    http.post(base, async ({ params, request }) => {
      const bad = guard(params.id, true);
      if (bad) return bad;
      const j = await parseBody(request);
      if (!j) return err("invalid_body", "Invalid comment");
      const a = art(params.id) as ArtifactSummary;
      const parsed = anchorInputSchema.safeParse(j.anchor);
      if (!parsed.success) return err("invalid_anchor", "Invalid anchor");
      const d = parsed.data;
      const anchor: Anchor =
        d.kind === "note"
          ? d
          : d.kind === "pin"
            ? {
                ...d,
                version: d.version ?? a.currentVersion,
                // The server stamps a pin's hash; null when the version has none.
                contentHash:
                  contentHash?.(a.id, d.version ?? a.currentVersion) ?? null,
              }
            : { ...d, version: d.version ?? a.currentVersion };
      const c = comment(j.body, mine());
      const bad2 = decorate(c, j, a.id);
      if (bad2) return bad2;
      const t: CommentThread = {
        id: newId(),
        anchor,
        version: "version" in anchor ? anchor.version : a.currentVersion,
        status: "open",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: c.createdAt,
        comments: [c],
      };
      list(a.id).push(t);
      emit(a.id, open(a.id));
      return HttpResponse.json(t, { status: 201 });
    }),
    http.post(rep, async ({ params, request }) => {
      const bad = guard(params.id, true) ?? badIds(params.tid);
      if (bad) return bad;
      const t = list(String(params.id)).find((x) => x.id === params.tid);
      if (!t) return err("not_found", "Not found");
      const j = await parseBody(request);
      if (!j) return err("invalid_body", "Invalid comment");
      // The root plus MAX_REPLIES replies: the next one is a conflict.
      if (t.comments.length > MAX_REPLIES)
        return err("conflict", "This thread has too many replies");
      const c = comment(j.body, mine());
      const bad2 = decorate(c, j, String(params.id));
      if (bad2) return bad2;
      // #2035: a reply also tells the thread's agents; the mock varies the outcome.
      if (t.agents?.length)
        c.notified = t.agents.map((x, i) => ({
          key: x.key,
          name: x.name,
          ...(x.for ? { for: x.for } : {}),
          ...(x.linked !== undefined ? { linked: x.linked } : {}),
          ...(x.product ? { product: x.product } : {}),
          ...(x.animal ? { animal: x.animal } : {}),
          delivery: i % 3 === 0 ? "delivered" : i % 3 === 1 ? "queued" : "gone",
        }));
      t.comments.push(c);
      emit(String(params.id), open(String(params.id)));
      return HttpResponse.json(c, { status: 201 });
    }),
    // #2035: stop (DELETE) or resume (PUT) a thread's agent; the caller's own agents and the owner's.
    ...(["delete", "put"] as const).map((method) =>
      http[method](`${A}/:tid/agents/:key`, ({ params }) => {
        const bad = guard(params.id, true) ?? badIds(params.tid);
        if (bad) return bad;
        const t = list(String(params.id)).find((x) => x.id === params.tid);
        const key = String(params.key);
        const known = THREAD_AGENTS.find((x) => x.key === key);
        if (!t || !known) return err("not_found", "Not found");
        if (!known.canRemove)
          return err(
            "forbidden",
            "Only the person whose agent it is, or the owner, can change this",
          );
        const now = (t.agents ?? []).filter((x) => x.key !== key);
        t.agents =
          method === "delete"
            ? now
            : THREAD_AGENTS.filter(
                (x) => x.key === key || now.some((y) => y.key === x.key),
              ).map((x) => ({ ...x }));
        emit(String(params.id), open(String(params.id)));
        return new HttpResponse(null, { status: 204 });
      }),
    ),
    http.patch(thr, async ({ params, request }) => {
      const bad = guard(params.id, true) ?? badIds(params.tid);
      if (bad) return bad;
      const t = list(String(params.id)).find((x) => x.id === params.tid);
      if (!t) return err("not_found", "Not found");
      const j = (await request.json().catch(() => null)) as {
        status?: string;
      } | null;
      if (j?.status !== "open" && j?.status !== "resolved")
        return err("bad_request", "Invalid status");
      t.status = j.status;
      t.resolvedBy = j.status === "resolved" ? mine() : null;
      t.resolvedAt = j.status === "resolved" ? iso() : null;
      closeAsks(t);
      emit(String(params.id), open(String(params.id)));
      return HttpResponse.json(t);
    }),
    http.patch(one, async ({ params, request }) => {
      const bad = guard(params.id, true) ?? badIds(params.tid, params.cid);
      if (bad) return bad;
      const c = list(String(params.id))
        .find((x) => x.id === params.tid)
        ?.comments.find((x) => x.id === params.cid);
      if (!c) return err("not_found", "Not found");
      if (!c.can.edit) return err("forbidden", "Not yours to edit");
      const j = await parseBody(request);
      if (!j) return err("invalid_body", "Invalid comment");
      c.body = j.body;
      c.editedAt = iso();
      return HttpResponse.json(c);
    }),
    http.delete(one, ({ params }) => {
      const bad = guard(params.id, true) ?? badIds(params.tid, params.cid);
      if (bad) return bad;
      const l = list(String(params.id));
      const t = l.find((x) => x.id === params.tid);
      const c = t?.comments.find((x) => x.id === params.cid);
      if (!t || !c) return err("not_found", "Not found");
      if (!c.can.delete) return err("forbidden", "Not yours to delete");
      if (t.comments[0] === c) l.splice(l.indexOf(t), 1);
      else t.comments.splice(t.comments.indexOf(c), 1);
      emit(String(params.id), open(String(params.id)));
      return new HttpResponse(null, { status: 204 });
    }),
  ];
  const comments = (id: string) => list(id).flatMap((t) => t.comments);
  return {
    handlers,
    asksForYou: (id) =>
      list(id).filter(
        (t) =>
          t.status === "open" &&
          t.comments.some(
            (c) => c.ask && !c.ask.answer && c.ask.to.some((a) => a.me),
          ),
      ).length,
  };
}

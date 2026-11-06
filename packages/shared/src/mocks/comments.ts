/**
 * MSW mock of the comments REST contract (#682), in memory per createHandlers.
 * Seeded with one open text thread and one resolved note on the "Landing page"
 * fixture, so a test or the mock app has something to show.
 */
import { delay, type HttpHandler, HttpResponse, http } from "msw";
import {
  anchorInputSchema,
  type Comment,
  type CommentAuthor,
  type CommentThread,
  ReplyBodySchema,
} from "../comments.js";
import type { ErrorCode } from "../errors.js";
import { newId } from "../ids.js";
import type { ArtifactSummary } from "../schemas.js";

type Deps = {
  artifacts: ArtifactSummary[];
  me: { user: { id: string; name: string | null; email: string } };
  err: (code: ErrorCode, message: string) => Response;
  emit: (id: string, open: number) => void;
  /** Every write answers 429 with this Retry-After (seconds). */
  rateLimit?: number;
};

const iso = () => new Date().toISOString();

export function createCommentHandlers({
  artifacts,
  me,
  err,
  emit,
  rateLimit,
}: Deps): HttpHandler[] {
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
    return r.success ? { body: r.data.body, anchor: raw?.anchor } : null;
  };
  const A = "*/api/v1/artifacts/:id/comments";
  const base = A;
  const thr = `${A}/:tid`;
  const rep = `${A}/:tid/replies`;
  const one = `${A}/:tid/comments/:cid`;
  return [
    http.get(base, async ({ params, request }) => {
      await delay(0);
      const bad = guard(params.id);
      if (bad) return bad;
      const s = new URL(request.url).searchParams.get("status") ?? "all";
      const all = list(String(params.id));
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
      const anchor =
        parsed.data.kind === "note"
          ? parsed.data
          : {
              ...parsed.data,
              version: parsed.data.version ?? a.currentVersion,
            };
      const c = comment(j.body, mine());
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
      t.comments.push(c);
      emit(String(params.id), open(String(params.id)));
      return HttpResponse.json(c, { status: 201 });
    }),
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
}

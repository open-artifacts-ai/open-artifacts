/**
 * MSW mock of the For you inbox (#2512): R.meInbox and its writes, in memory
 * per createHandlers, with Design's examples. Without a variant there are no
 * handlers and /me carries no `inbox`, as on a server without it: no bell.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import type { ErrorCode } from "../errors.js";
import {
  type Inbox,
  type InboxItem,
  InboxLaterBodySchema,
  InboxMuteBodySchema,
  type InboxMutes,
  InboxReadBodySchema,
} from "../inbox.js";
import { R } from "../routes.js";
import { FOR_YOU_ASK } from "./comments.js";

/**
 * mixed: two need you (a waiting ask, a machine to approve) and two updates.
 * calm: nothing needs you; "While you were away" and two updates.
 * empty: nothing at all (first time).
 * back: the machine is back from Later.
 */
export type ForYouVariant = "mixed" | "calm" | "empty" | "back";

type Deps = {
  variant?: ForYouVariant;
  /** The "Landing page" fixture: the ask is seeded there. */
  landingId: string;
  /** Another fixture page the updates open. */
  otherId: string;
  err: (code: ErrorCode, message: string) => Response;
  /** Whether the seeded ask still waits for the caller (answered asks leave). */
  askOpen: (id: string, thread: string) => boolean;
  now?: () => number;
};

const MIN = 60_000;
/** Updates per page of R.meInbox. */
export const INBOX_MOCK_PAGE = 20;

export function createForYouMock(d: Deps): {
  handlers: HttpHandler[];
  /** Me.inbox, or undefined when the variant is off. */
  counts: () => Inbox["counts"] | undefined;
} {
  if (!d.variant) return { handlers: [], counts: () => undefined };
  const now = d.now ?? Date.now;
  const ago = (ms: number) => new Date(now() - ms).toISOString();
  const page = (id: string, title: string) => ({ id, title });
  /** A linked agent, as comments show one (CommentAuthor). */
  const agent = (name: string, animal: string, color: number) => ({
    kind: "agent" as const,
    name,
    for: "Ada Lovelace",
    linked: true,
    product: "Claude Code",
    animal: { id: animal, color },
    me: false,
  });
  const person = (name: string) => ({
    kind: "user" as const,
    name,
    me: false,
  });
  const ask: InboxItem = {
    id: `ask:${FOR_YOU_ASK.comment}`,
    level: "needs_you",
    kind: "ask",
    urgency: "waiting",
    waitingSince: ago(4 * MIN),
    artifact: page(d.landingId, "Open Artifacts Asks"),
    actor: agent("OA Manager", "owl", 4),
    agentKey: "agent:manager",
    text: "Ship the landing with the waitlist?",
    href: `/a/${d.landingId}?thread=${FOR_YOU_ASK.thread}`,
    createdAt: ago(4 * MIN),
    readAt: null,
  };
  const machine = (back: boolean): InboxItem => ({
    id: "itm:machine1",
    level: "needs_you",
    kind: "machine",
    machine: { id: "mach1", name: "Ada-Workstation" },
    artifact: null,
    actor: null,
    text: "Approve this machine: Ada-Workstation",
    href: "/agents",
    createdAt: ago(back ? 26 * 60 * MIN : 20 * MIN),
    readAt: null,
    ...(back
      ? {
          backFromLater: true as const,
          later: { until: ago(MIN), used: true as const },
        }
      : {}),
  });
  const update = (
    id: string,
    kind: InboxItem["kind"],
    text: string,
    title: string,
    at: number,
    read: boolean,
    actor: InboxItem["actor"],
    agentKey?: string,
  ): InboxItem => ({
    id,
    level: "update",
    kind,
    artifact: page(d.otherId, title),
    actor,
    ...(agentKey ? { agentKey } : {}),
    text,
    href: `/a/${d.otherId}`,
    createdAt: ago(at),
    readAt: read ? ago(at - MIN) : null,
  });
  const design = agent("OA Design", "fox", 1);
  let needsYou: InboxItem[] = [];
  let later: InboxItem[] = [];
  let updates: InboxItem[] = [];
  if (d.variant === "mixed") {
    needsYou = [ask, machine(false)];
    updates = [
      update(
        "itm:reply1",
        "reply",
        "OA Design replied",
        "Landing page: direction B",
        60 * MIN,
        false,
        design,
        "agent:design",
      ),
      update(
        "itm:decided1",
        "decision",
        "Sam decided: Yearly first",
        "Pricing table",
        120 * MIN,
        true,
        person("Sam Rivera"),
      ),
    ];
  }
  if (d.variant === "calm") {
    // Since 22:00 the caller's time, the evening before.
    const since = new Date(now());
    if (since.getHours() < 22) since.setDate(since.getDate() - 1);
    since.setHours(22, 0, 0, 0);
    updates = [
      {
        id: "itm:away1",
        level: "update",
        kind: "away",
        away: { since: since.toISOString(), count: 6, pages: 3 },
        artifact: null,
        actor: null,
        text: "While you were away",
        href: "/",
        createdAt: ago(2 * MIN),
        readAt: null,
      },
      update(
        "itm:reply2",
        "reply",
        "OA Docs replied",
        "Setup guide",
        12 * MIN,
        false,
        agent("OA Docs", "otter", 5),
        "agent:docs",
      ),
      update(
        "itm:share1",
        "share",
        "Maya shared a page with you",
        "Q4 launch plan",
        26 * 60 * MIN,
        true,
        person("Maya Chen"),
      ),
    ];
  }
  if (d.variant === "back") needsYou = [machine(true)];

  const open = () =>
    needsYou.filter((x) => {
      if (x.kind !== "ask" || !x.artifact) return true;
      const thread = new URL(x.href, "https://x.invalid").searchParams.get(
        "thread",
      );
      return !thread || d.askOpen(x.artifact.id, thread);
    });
  const counts = () => ({
    needsYou: open().length,
    unreadUpdates: updates.filter((x) => x.readAt === null).length,
  });
  const mutes: InboxMutes["items"] = [];
  const done = () => new HttpResponse(null, { status: 204 });
  const readNow = (x: InboxItem) =>
    x.readAt === null ? { ...x, readAt: ago(0) } : x;
  return {
    counts,
    handlers: [
      // Updates page by INBOX_MOCK_PAGE; the cursor is the next offset.
      http.get(`*${R.meInbox}`, ({ request }) => {
        const from = Number(
          new URL(request.url).searchParams.get("cursor") ?? 0,
        );
        const next = from + INBOX_MOCK_PAGE;
        return HttpResponse.json({
          needsYou: open(),
          later,
          updates: updates.slice(from, next),
          cursor: next < updates.length ? String(next) : null,
          counts: counts(),
        } satisfies Inbox);
      }),
      http.post(`*${R.meInboxRead}`, async ({ request }) => {
        const p = InboxReadBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        const ids = new Set(p.data.ids);
        updates = updates.map((x) => (ids.has(x.id) ? readNow(x) : x));
        return done();
      }),
      http.post(`*${R.meInboxReadAll}`, () => {
        updates = updates.map(readNow);
        return done();
      }),
      http.post("*/api/v1/me/inbox/:id/later", async ({ request, params }) => {
        const p = InboxLaterBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        const it = needsYou.find((x) => x.id === params.id);
        if (!it) return d.err("not_found", "Not found");
        if (it.later || it.backFromLater)
          return d.err("later_used", "Already put off once");
        // "morning": 08:00 the next day (the server uses prefs.timeZone).
        const t = new Date(now());
        if (p.data.until === "hour") t.setTime(now() + 60 * MIN);
        else {
          t.setDate(t.getDate() + 1);
          t.setHours(8, 0, 0, 0);
        }
        const moved: InboxItem = {
          ...it,
          later: { until: t.toISOString(), used: true },
        };
        needsYou = needsYou.filter((x) => x !== it);
        later = [...later, moved];
        return HttpResponse.json(moved);
      }),
      http.get(`*${R.meInboxMutes}`, () =>
        HttpResponse.json({ items: mutes } satisfies InboxMutes),
      ),
      // A mute stops push only: every item stays listed.
      http.post(`*${R.meInboxMutes}`, async ({ request }) => {
        const p = InboxMuteBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        if (!mutes.some((m) => m.kind === p.data.kind && m.id === p.data.id))
          mutes.push({ ...p.data, name: p.data.id });
        return done();
      }),
      http.delete("*/api/v1/me/inbox/mutes/:kind/:id", ({ params }) => {
        const i = mutes.findIndex(
          (m) => m.kind === params.kind && m.id === params.id,
        );
        if (i >= 0) mutes.splice(i, 1);
        return done();
      }),
    ],
  };
}

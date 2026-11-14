/**
 * MSW mock of For you (#2512), in memory per createHandlers.
 *
 * PROVISIONAL: the shapes and routes are the dashboard's guess until OA
 * Backend's contract lands (TODO(OA Backend, #2512)). Without a variant every
 * route answers 404, as a server without For you does, so the bell stays hidden.
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import type { ErrorCode } from "../errors.js";
import {
  type ForYouAway,
  type ForYouItem,
  ForYouLaterBodySchema,
  ForYouMuteBodySchema,
  ForYouReadBodySchema,
} from "../for-you.js";
import { R } from "../routes.js";
import { FOR_YOU_ASK } from "./comments.js";

/**
 * mixed: two need you (a waiting ask, a machine to approve) and two updates.
 * calm: nothing needs you, "While you were away" and two updates.
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
  /** Whether the seeded ask still waits for the caller (answered asks drop out). */
  askOpen: (id: string, thread: string) => boolean;
  now?: () => number;
};

const MIN = 60_000;

export function createForYouMock(d: Deps): {
  handlers: HttpHandler[];
  /** Agents muted through R.forYouMutes, for tests. */
  muted: string[];
} {
  const now = d.now ?? Date.now;
  const ago = (ms: number) => new Date(now() - ms).toISOString();
  const muted: string[] = [];
  if (!d.variant) {
    const none = () => d.err("not_found", "Not found");
    return {
      muted,
      handlers: [
        http.get(`*${R.forYou}`, none),
        http.post(`*${R.forYouRead}`, none),
        http.post("*/api/v1/for-you/:id/later", none),
        http.post(`*${R.forYouMutes}`, none),
      ],
    };
  }
  const manager = {
    kind: "agent" as const,
    name: "OA Manager",
    key: "agent:manager",
  };
  const ask: ForYouItem = {
    id: "fy-ask",
    level: "needs",
    kind: "ask",
    title: "Ship the landing with the waitlist?",
    context: 'OA Manager asks · on "Open Artifacts Asks"',
    at: ago(4 * MIN),
    actor: manager,
    page: { id: d.landingId, title: "Open Artifacts Asks" },
    ask: { ...FOR_YOU_ASK },
    waitingMs: 4 * MIN,
    read: false,
  };
  const machine = (back: boolean): ForYouItem => ({
    id: "fy-machine",
    level: "needs",
    kind: "machine",
    title: "Approve this machine: Ada-Workstation",
    context: "It wants to connect agents as you",
    at: ago(back ? 26 * 60 * MIN : 20 * MIN),
    actor: { kind: "system", name: "Open Artifacts" },
    action: { href: "/agents" },
    read: false,
    ...(back ? { later: { state: "returned" as const } } : {}),
  });
  const update = (
    id: string,
    title: string,
    context: string,
    at: number,
    read: boolean,
    actor: ForYouItem["actor"],
    kind: ForYouItem["kind"] = "reply",
  ): ForYouItem => ({
    id,
    level: "update",
    kind,
    title,
    context,
    at: ago(at),
    actor,
    // The page's own title: the quoted one in the line.
    page: { id: d.otherId, title: /"([^"]+)"/.exec(context)?.[1] ?? context },
    read,
  });
  const design = {
    kind: "agent" as const,
    name: "OA Design",
    key: "agent:design",
  };
  const sam = { kind: "user" as const, name: "Sam Rivera" };
  let items: ForYouItem[] = [];
  let away: ForYouAway | null = null;
  if (d.variant === "mixed")
    items = [
      ask,
      machine(false),
      update(
        "fy-reply",
        "OA Design replied",
        'on "Landing page: direction B"',
        60 * MIN,
        false,
        design,
      ),
      update(
        "fy-decided",
        "Sam decided: Yearly first",
        'on "Pricing table"',
        120 * MIN,
        true,
        sam,
        "decision",
      ),
    ];
  if (d.variant === "calm") {
    const folded = Array.from({ length: 6 }, (_, i) =>
      update(
        `fy-away-${i + 1}`,
        i % 2 ? "Sam replied" : "OA Design replied",
        `on "Page ${(i % 3) + 1}"`,
        (9 + i) * 60 * MIN,
        false,
        i % 2 ? sam : design,
      ),
    );
    // Since 22:00 the caller's time, the evening before.
    const since = new Date(now());
    if (since.getHours() < 22) since.setDate(since.getDate() - 1);
    since.setHours(22, 0, 0, 0);
    away = {
      updates: 6,
      pages: 3,
      since: since.toISOString(),
      ids: folded.map((x) => x.id),
    };
    items = [
      update(
        "fy-version",
        "OA Docs published v4",
        'of "Setup guide", a page you follow',
        12 * MIN,
        false,
        { kind: "agent", name: "OA Docs", key: "agent:docs" },
        "version",
      ),
      update(
        "fy-shared",
        "Maya shared a page with you",
        '"Q4 launch plan"',
        26 * 60 * MIN,
        true,
        { kind: "user", name: "Maya Chen" },
        "share",
      ),
      ...folded,
    ];
  }
  if (d.variant === "back") items = [machine(true)];

  const visible = () =>
    items.filter(
      (x) => !x.ask || !x.page || d.askOpen(x.page.id, x.ask.thread),
    );
  /** 8:00 tomorrow, the caller's time. */
  const morning = () => {
    const t = new Date(now());
    t.setDate(t.getDate() + 1);
    t.setHours(8, 0, 0, 0);
    return t.toISOString();
  };
  return {
    muted,
    handlers: [
      http.get(`*${R.forYou}`, () =>
        HttpResponse.json({ items: visible(), away }),
      ),
      http.post(`*${R.forYouRead}`, async ({ request }) => {
        const p = ForYouReadBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        const ids = "ids" in p.data ? new Set(p.data.ids) : null;
        items = items.map((x) =>
          x.level === "update" && (!ids || ids.has(x.id))
            ? { ...x, read: true }
            : x,
        );
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("*/api/v1/for-you/:id/later", async ({ request, params }) => {
        const p = ForYouLaterBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        const it = items.find((x) => x.id === params.id);
        if (!it || it.level !== "needs") return d.err("not_found", "Not found");
        if (it.later) return d.err("conflict", "Already put off once");
        const until =
          p.data.when === "hour"
            ? new Date(now() + 60 * MIN).toISOString()
            : morning();
        items = items.map((x) =>
          x === it ? { ...x, later: { state: "snoozed", until } } : x,
        );
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`*${R.forYouMutes}`, async ({ request }) => {
        const p = ForYouMuteBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        muted.push(p.data.agent);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/v1/artifacts/:id/follow", ({ params }) => {
        // No more updates from the page; what needs you stays.
        items = items.filter(
          (x) => x.level !== "update" || x.page?.id !== params.id,
        );
        return new HttpResponse(null, { status: 204 });
      }),
    ],
  };
}

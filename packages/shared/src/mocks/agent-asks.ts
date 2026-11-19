/**
 * MSW mock of asking someone else's agent (#2577): the held requests, the
 * switch and the "listens to" list, in memory per createHandlers, with
 * Design's examples (v8). Opt in with createHandlers({ agentAsks: true }).
 */
import { type HttpHandler, HttpResponse, http } from "msw";
import {
  AgentRequestsSwitchSchema,
  AllowBodySchema,
  type AllowResult,
  type AskHistory,
  type HeldList,
  type HeldRequest,
  ListenAddBodySchema,
  type ListenAddResult,
  type ListenEntry,
  ListenShortenBodySchema,
  type ListensList,
} from "../agent-asks.js";
import type { ErrorCode } from "../errors.js";
import { R } from "../routes.js";

/** The one held request the "held" For you variant points at. */
export const MOCK_HELD_ID = "held_dev1";

type Deps = {
  landingId: string;
  /** A member's name by id, for the entries an add returns. */
  memberName?: (id: string) => string | undefined;
  err: (code: ErrorCode, message: string) => Response;
  now?: () => number;
};

const DAY = 24 * 3600_000;
const MIN = 60_000;
const hex = (c: string) => c.repeat(64);

export function createAgentAsksMock(d: Deps): {
  handlers: HttpHandler[];
  /** The held requests, for the For you mock's item. */
  held: () => HeldRequest[];
} {
  const now = d.now ?? Date.now;
  const person = (id: string, name: string) => ({ id, name });
  let on = true;
  let nextId = 1;
  const item = (
    i: number,
    body: string,
    at: number,
    hash: string,
  ): HeldRequest["items"][number] => ({
    commentId: `c_held${i}`,
    threadId: "t_held",
    agentKey: "agent:sam-bot",
    agentName: "Web",
    way: "mention",
    body,
    wordsHash: hex(hash),
    createdAt: now() - at,
  });
  let held: HeldRequest[] = [
    {
      id: MOCK_HELD_ID,
      sender: person("u_dev", "Dev Patel"),
      artifact: { id: d.landingId, title: "Launch status" },
      items: [
        item(1, "where does the 42% in row 3 come from?", 15 * MIN, "a"),
        item(2, "and is it this week or last week?", 14 * MIN, "b"),
        item(3, "the date in row 5 is wrong, can you fix it", 8 * MIN, "c"),
      ],
      since: now() - 15 * MIN,
      lastAt: now() - 8 * MIN,
      quietUntil: null,
      open: false,
      space: { id: "sp_launch", name: "Launch", pagesCovered: 4 },
    },
  ];
  let listens: ListenEntry[] = [
    {
      id: "l_maya",
      member: person("u_maya", "Maya Chen"),
      scope: "all",
      artifact: null,
      space: null,
      until: now() + 88 * DAY,
      createdAt: now() - 2 * DAY,
    },
    {
      id: "l_dev",
      member: person("u_dev", "Dev Patel"),
      scope: "page",
      artifact: { id: d.landingId, title: "Launch status" },
      space: null,
      until: now() + 26 * DAY,
      createdAt: now() - 4 * DAY,
    },
    {
      id: "l_priya",
      member: person("u_priya", "Priya Shah"),
      scope: "space",
      artifact: null,
      space: { id: "sp_launch", name: "Launch" },
      until: now() + 26 * DAY,
      createdAt: now() - 4 * DAY,
    },
  ];
  const done = () => new HttpResponse(null, { status: 204 });
  return {
    held: () => held,
    handlers: [
      http.get(`*${R.agentAskHeld}`, () =>
        HttpResponse.json({ requests: held } satisfies HeldList),
      ),
      http.post(
        "*/api/v1/me/agent-asks/held/:id/allow",
        async ({ request, params }) => {
          const p = AllowBodySchema.safeParse(await request.json());
          if (!p.success) return d.err("bad_request", "Invalid body");
          const r = held.find((x) => x.id === params.id);
          if (!r) return d.err("not_found", "Not found");
          let sent = 0;
          let changed = 0;
          for (const it of p.data.items) {
            const cur = r.items.find((x) => x.commentId === it.commentId);
            if (cur && cur.wordsHash === it.wordsHash) sent++;
            else changed++;
          }
          if (p.data.level !== "once") {
            const until = p.data.until ?? now() + 30 * DAY;
            listens = [
              ...listens,
              {
                id: `l_new${nextId++}`,
                member: r.sender,
                scope: p.data.level,
                artifact: p.data.level === "page" ? r.artifact : null,
                space:
                  p.data.level === "space" && r.space
                    ? { id: r.space.id, name: r.space.name }
                    : null,
                until,
                createdAt: now(),
              },
            ];
          }
          if (changed === 0) held = held.filter((x) => x !== r);
          return HttpResponse.json({
            sent,
            changed,
            waiting: 0,
          } satisfies AllowResult);
        },
      ),
      http.post("*/api/v1/me/agent-asks/held/:id/not-now", ({ params }) => {
        if (!held.some((x) => x.id === params.id))
          return d.err("not_found", "Not found");
        held = held.filter((x) => x.id !== params.id);
        return done();
      }),
      http.get(`*${R.agentAskHistory}`, () =>
        HttpResponse.json({
          rows: [
            {
              agent: { key: "agent:sam-bot", name: "Web" },
              asker: person("u_maya", "Maya Chen"),
              artifact: { id: d.landingId, title: "Launch status" },
              at: now() - DAY,
              outcome: "on_list",
            },
            {
              agent: { key: "agent:sam-bot", name: "Web" },
              asker: person("u_dev", "Dev Patel"),
              artifact: { id: d.landingId, title: "Launch status" },
              at: now() - 2 * MIN,
              outcome: "allowed_once",
            },
          ],
        } satisfies AskHistory),
      ),
      // The add: members only, not yourself; a page open to the link is refused.
      http.post(`*${R.agentListens}`, async ({ request }) => {
        const p = ListenAddBodySchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        const ids = p.data.memberIds ?? [p.data.memberId ?? ""];
        const entries: ListenEntry[] = [];
        for (const id of ids) {
          const name = d.memberName?.(id);
          if (!name) return d.err("bad_request", "Not a teammate you can add");
          const days =
            p.data.until <= 365 ? p.data.until * DAY : p.data.until - now();
          const e: ListenEntry = {
            id: `l_new${nextId++}`,
            member: person(id, name),
            scope: p.data.scope,
            artifact:
              p.data.scope === "page" && p.data.artifactId
                ? { id: p.data.artifactId, title: "Launch status" }
                : null,
            space:
              p.data.scope === "space" && p.data.spaceId
                ? { id: p.data.spaceId, name: "Launch" }
                : null,
            until: now() + days,
            createdAt: now(),
          };
          entries.push(e);
        }
        listens = [...listens, ...entries];
        return HttpResponse.json({ entries } satisfies ListenAddResult);
      }),
      http.get(`*${R.agentRequests}`, () => HttpResponse.json({ on })),
      http.put(`*${R.agentRequests}`, async ({ request }) => {
        const p = AgentRequestsSwitchSchema.safeParse(await request.json());
        if (!p.success) return d.err("bad_request", "Invalid body");
        on = p.data.on;
        return HttpResponse.json({ on });
      }),
      http.get(`*${R.agentListens}`, () =>
        HttpResponse.json({ entries: listens } satisfies ListensList),
      ),
      http.patch(
        "*/api/v1/me/agent-listens/:id",
        async ({ request, params }) => {
          const p = ListenShortenBodySchema.safeParse(await request.json());
          if (!p.success) return d.err("bad_request", "Invalid body");
          const e = listens.find((x) => x.id === params.id);
          if (!e) return d.err("not_found", "Not found");
          const next = { ...e, until: p.data.until };
          listens = listens.map((x) => (x === e ? next : x));
          return HttpResponse.json(next);
        },
      ),
      http.delete("*/api/v1/me/agent-listens/:id", ({ params }) => {
        if (!listens.some((x) => x.id === params.id))
          return d.err("not_found", "Not found");
        listens = listens.filter((x) => x.id !== params.id);
        return done();
      }),
    ],
  };
}

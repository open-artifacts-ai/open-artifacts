// PROVISIONAL (#2780): mock-only person @mentions, over the shared mocks
// (which do not know `people` yet). Delete with src/viewer/comments/people.ts
// once the shared mocks serve the route.
// - GET mention-candidates?q= lists people by the start of a name or of any
//   word in it (never an email), at most 8.
// - A new thread or reply keeps its `people`, and the list shows them.
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

type Face = { kind: "user"; id: string; name: string; me: false };

export const MOCK_PEOPLE: Face[] = [
  { kind: "user", id: "usr_sam", name: "Sam Rivera", me: false },
  { kind: "user", id: "usr_samira", name: "Samira Okafor", me: false },
  { kind: "user", id: "usr_maya", name: "Maya Chen", me: false },
  { kind: "user", id: "usr_priya", name: "Priya Nair", me: false },
  { kind: "user", id: "usr_tomas", name: "Tomas Alvarez", me: false },
];

const matches = (name: string, q: string) =>
  name
    .toLowerCase()
    .split(/\s+/)
    .some((w) => w.startsWith(q.toLowerCase())) ||
  name.toLowerCase().startsWith(q.toLowerCase());

/** A server without #2780: the route is absent (404), so no people are offered. */
export const mentionPeopleAbsentHandlers = (): HttpHandler[] => [
  http.get("*/api/v1/artifacts/:id/mention-candidates", () =>
    HttpResponse.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404 },
    ),
  ),
];

/** `next` is every handler after these: they forward to it and add `people`. */
export function mentionPeopleHandlers(next: HttpHandler[]): HttpHandler[] {
  const on = new Map<string, Face[]>();
  const keep = async (request: Request) => {
    const raw = (await request.clone().json()) as {
      people?: string[];
    } & Record<string, unknown>;
    const { people, ...rest } = raw;
    const forward = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(rest),
    });
    const res = await getResponse(next, forward);
    if (!res?.ok || !people?.length) return res;
    const out = (await res.json()) as {
      id: string;
      comments?: { id: string }[];
    };
    const c = out.comments ? out.comments[0] : out;
    if (!c) return HttpResponse.json(out, { status: res.status });
    const faces = people.flatMap((id) => {
      const f = MOCK_PEOPLE.find((p) => p.id === id);
      return f ? [f] : [];
    });
    on.set(c.id, faces);
    (c as { people?: Face[] }).people = faces;
    return HttpResponse.json(out, { status: res.status });
  };
  return [
    http.get("*/api/v1/artifacts/:id/mention-candidates", ({ request }) => {
      const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
      if (q === "" || q.length > 40)
        return HttpResponse.json(
          {
            error: { code: "bad_request", message: "q is 1 to 40 characters" },
          },
          { status: 400 },
        );
      return HttpResponse.json({
        items: MOCK_PEOPLE.filter((p) => matches(p.name, q)).slice(0, 8),
      });
    }),
    http.post("*/api/v1/artifacts/:id/comments", ({ request }) =>
      keep(request),
    ),
    http.post(
      "*/api/v1/artifacts/:id/comments/:thread/replies",
      ({ request }) => keep(request),
    ),
    http.get("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as {
        threads: { comments: { id: string; people?: Face[] }[] }[];
      };
      for (const t of list.threads)
        for (const c of t.comments) {
          const own = on.get(c.id);
          if (own) c.people = own;
        }
      return HttpResponse.json(list);
    }),
  ];
}

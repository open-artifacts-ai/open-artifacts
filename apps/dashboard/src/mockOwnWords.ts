// Mock-only "Something else" with a typed answer, over the shared mocks (which
// do not serve `ownWords`).
// ?mock=own-words (or &ownwords=1 beside another mock): a pick with { ownWords: { text } } (trimmed, 1 to 1000, no
// optionId) is recorded, and the list then shows the answer with its words.
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

const bad = (reason: string) =>
  HttpResponse.json(
    {
      error: {
        code: "bad_request",
        message: "Invalid text",
        details: { path: "ownWords.text", reason },
      },
    },
    { status: 400 },
  );

/** `next` is every handler after these. */
export function ownWordsHandlers(next: HttpHandler[]): HttpHandler[] {
  const own = new Map<string, string>();
  const A = "*/api/v1/artifacts/:id/comments";
  type Ask = {
    options: { id: string }[];
    answer?: Record<string, unknown>;
  };
  type Thread = { comments: { id: string; ask?: Ask }[] };
  const mark = (list: { threads: Thread[] }) => {
    for (const t of list.threads)
      for (const c of t.comments) {
        if (!c.ask) continue;
        const text = own.get(c.id);
        if (text)
          c.ask.answer = {
            by: { kind: "user", name: "You", me: true },
            at: new Date().toISOString(),
            typed: true,
            yes: false,
            ownWords: { text },
          };
      }
  };
  return [
    http.get(A, async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as { threads: Thread[] };
      mark(list);
      return HttpResponse.json(list);
    }),
    http.post(
      `${A}/:thread/comments/:comment/answer`,
      async ({ request, params }) => {
        const body = (await request.clone().json()) as {
          optionId?: string;
          ownWords?: { text?: string };
        };
        if (body.ownWords === undefined) return getResponse(next, request);
        if (body.optionId !== undefined)
          return HttpResponse.json(
            { error: { code: "bad_request", message: "One or the other" } },
            { status: 400 },
          );
        const text = (body.ownWords.text ?? "").trim();
        if (text === "") return bad("empty");
        if (text.length > 1000) return bad("too_long");
        // Recorded here, never as a pick of one of the options: the list shows it as the answer.
        const list = (await (
          await getResponse(
            next,
            new Request(
              new URL(`/api/v1/artifacts/${params.id}/comments`, request.url),
            ),
          )
        )?.json()) as { threads: Thread[] };
        const c = list.threads
          .flatMap((t) => t.comments)
          .find((x) => x.id === params.comment);
        if (!c?.ask) return bad("empty");
        own.set(String(params.comment), text);
        mark(list);
        return HttpResponse.json(c);
      },
    ),
  ];
}

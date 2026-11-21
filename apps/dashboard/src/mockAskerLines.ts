// #2577 (mock only, with ?mock=agent-asks&asker=1): the asker's lines.
// - the @ list gains "Web (Ana)", whose person turned asking off;
// - a comment that says "one more thing" and mentions a held agent answers
//   with the server's non-fatal over-the-limit notice (#2559).
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

type Agent = Record<string, unknown>;

/** `next` is every handler after these. */
export function askerLinesHandlers(next: HttpHandler[]): HttpHandler[] {
  return [
    http.get("*/api/v1/artifacts/:id/agents", async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as Agent[];
      return HttpResponse.json([
        ...list,
        {
          key: "agent:ana-web",
          name: "Web (Ana)",
          online: true,
          state: "online",
          lastActiveAt: null,
          machine: null,
          owner: "Ana",
          askState: "off",
        },
      ]);
    }),
    http.post("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      const res = await getResponse(next, request.clone());
      if (!res?.ok) return res;
      const body = (await request.clone().json()) as { body?: string };
      if (!/one more thing/i.test(body.body ?? "")) return res;
      const thread = (await res.json()) as { comments: Agent[] };
      const [first, ...rest] = thread.comments;
      return HttpResponse.json(
        {
          ...thread,
          comments: [
            {
              ...first,
              notice: "That's a lot of mentions. Try again in a few minutes.",
            },
            ...rest,
          ],
        },
        { status: res.status },
      );
    }),
  ];
}

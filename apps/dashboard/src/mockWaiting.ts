// Mock-only (#1910, #2778): &waiting=1 makes the shared mocks carry the
// waiting fields: the first Library card says one ask has waited 4 minutes,
// and every open ask in a page's comments says it has waited 4 minutes.
// Loaded only with VITE_MOCK.
import {
  getResponse,
  type HttpHandler,
  HttpResponse,
  http,
  type JsonBodyType,
} from "msw";

const FOUR_MIN = 4 * 60_000;

/** Add `ask.waitingSince` to every open ask in a comments response. */
function mark(node: unknown, since: string): JsonBodyType {
  if (Array.isArray(node)) return node.map((n) => mark(n, since));
  if (!node || typeof node !== "object") return node as JsonBodyType;
  const o = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = mark(v, since);
  const ask = o.ask as { closed?: boolean } | undefined;
  if (ask && !ask.closed) out.ask = { ...ask, waitingSince: since };
  return out;
}

export function waitingHandlers(
  main: HttpHandler[],
  params: URLSearchParams,
): HttpHandler[] {
  if (params.get("waiting") !== "1") return [];
  const since = () => new Date(Date.now() - FOUR_MIN).toISOString();
  return [
    http.get("*/api/v1/artifacts", async ({ request }) => {
      const res = await getResponse(main, request);
      if (!res?.ok) return res;
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      const [first, ...rest] = body.items;
      return HttpResponse.json({
        ...body,
        items: first
          ? [{ ...first, waiting: { count: 1, oldestSince: since() } }, ...rest]
          : [],
      });
    }),
    http.get("*/api/v1/artifacts/:id/comments", async ({ request }) => {
      const res = await getResponse(main, request);
      if (!res?.ok) return res;
      const j = mark(await res.json(), since());
      return HttpResponse.json(j);
    }),
  ];
}

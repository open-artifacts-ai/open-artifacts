import {
  type PushSubscriptionPatchBody,
  type PushSubscriptions,
  R,
} from "@oa/shared";
import { getResponse, HttpResponse, http, type RequestHandler } from "msw";

/**
 * Mock-only, until #2774 lands: S5's per-browser switches on top of the For
 * you mock (?mock=foryou). The list carries each browser's needsYou and
 * updates (a new browser starts with Needs you on, Updates off), and PATCH
 * changes them; an unknown id is 404. Move into the shared mock when #2774
 * merges.
 */
export const pushSwitchHandlers = (
  base: () => RequestHandler[],
): RequestHandler[] => {
  const switches = new Map<string, { needsYou: boolean; updates: boolean }>();
  const of = (id: string) =>
    switches.get(id) ?? { needsYou: true, updates: false };
  const list = async (url: string) => {
    const res = await getResponse(base(), new Request(url, { method: "GET" }));
    return (await res?.json()) as PushSubscriptions;
  };
  return [
    http.get(`*${R.mePushSubscriptions}`, async ({ request }) => {
      const body = await list(request.url);
      return HttpResponse.json({
        items: body.items.map((x) => ({ ...x, ...of(x.id) })),
      });
    }),
    http.patch(
      "*/api/v1/me/push/subscriptions/:id",
      async ({ request, params }) => {
        const id = String(params.id);
        const body = await list(
          request.url.replace(/\/subscriptions\/[^/?]*$/, "/subscriptions"),
        );
        if (!body.items.some((x) => x.id === id))
          return HttpResponse.json(
            { error: { code: "not_found", message: "Not found" } },
            { status: 404 },
          );
        const next = {
          ...of(id),
          ...((await request.json()) as PushSubscriptionPatchBody),
        };
        switches.set(id, next);
        return HttpResponse.json(next);
      },
    ),
  ];
};

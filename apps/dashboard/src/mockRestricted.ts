import { getResponse, HttpResponse, http, type RequestHandler } from "msw";

/**
 * Mock-only: a restricted member, on top of the hosted mocks.
 * ?mock=restricted (with ?hosted=1): no tokens or connected agents, so no
 * Connections tab, and an empty Mine.
 * ?mock=restricted-rows: the fixtures' token and agent, so Connections shows both
 * cards as revoke-only; Mine is empty too.
 */
export const restrictedHandlers = (
  hosted: RequestHandler[],
  rows: boolean,
): RequestHandler[] => [
  http.get("*/api/v1/me", async ({ request }) => {
    const res = await getResponse(hosted, request);
    const me = (await res?.json()) as {
      user: object;
      auth: object;
    };
    return HttpResponse.json({
      ...me,
      user: { ...me.user, role: "member" },
      auth: { ...me.auth, readOnly: true, cap: "restricted" },
    });
  }),
  http.get("*/api/v1/artifacts", ({ request }) =>
    new URL(request.url).searchParams.get("scope") === "mine"
      ? HttpResponse.json({ items: [], nextCursor: null })
      : undefined,
  ),
  ...(rows
    ? []
    : [
        http.get("*/api/v1/tokens", () => HttpResponse.json([])),
        http.get("*/api/v1/oauth-clients", () => HttpResponse.json([])),
      ]),
];

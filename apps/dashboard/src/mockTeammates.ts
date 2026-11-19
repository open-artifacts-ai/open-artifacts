// Mock-only teammates, `memberId` on shares and `listensAsked` on onboarding,
// over the shared mocks (which do not serve them yet).

import { R } from "@oa/shared";
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";

type M = { id: string; name: string | null; email: string; role: string };

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** `next` is every handler after these. `asked`: the question was already answered. */
export function teammatesHandlers(
  next: HttpHandler[],
  opts: { asked?: boolean } = {},
): HttpHandler[] {
  let asked = opts.asked ?? false;
  const members = async (request: Request): Promise<M[]> => {
    const res = await getResponse(
      next,
      new Request(new URL("/api/v1/members", request.url), {
        headers: request.headers,
      }),
    );
    return res?.ok ? ((await res.json()) as M[]) : [];
  };
  return [
    http.get(`*${R.meTeammates}`, async ({ request }) => {
      const list = (await members(request)).filter(
        (m) => m.role === "member" || m.role === "admin",
      );
      return HttpResponse.json({
        members: list.map((m) => {
          const name = m.name ?? m.email.split("@")[0] ?? "";
          return { id: m.id, name, initials: initials(name) };
        }),
      });
    }),
    http.post(`*${R.meOnboardingListensAsked}`, async ({ request }) => {
      asked = true;
      const res = await getResponse(
        next,
        new Request(new URL(R.onboarding, request.url), {
          headers: request.headers,
        }),
      );
      const o = res?.ok ? ((await res.json()) as object) : {};
      return HttpResponse.json({
        ...o,
        agentConnected: true,
        listensAsked: true,
      });
    }),
    http.get("*/api/v1/onboarding", async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const o = (await res.json()) as Record<string, unknown>;
      return HttpResponse.json({
        ...o,
        agentConnected: true,
        listensAsked: asked,
      });
    }),
    http.put("*/api/v1/onboarding", async ({ request }) => {
      const res = await getResponse(next, request);
      if (!res?.ok) return res;
      const o = (await res.json()) as Record<string, unknown>;
      return HttpResponse.json({
        ...o,
        agentConnected: true,
        listensAsked: asked,
      });
    }),
    http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
      const res = await getResponse(next, request.clone());
      if (!res?.ok) return res;
      const body = (await res.json()) as { email: string };
      const m = (await members(request)).find(
        (x) => x.email.toLowerCase() === body.email.toLowerCase(),
      );
      return HttpResponse.json({ ...body, memberId: m?.id ?? null });
    }),
  ];
}
